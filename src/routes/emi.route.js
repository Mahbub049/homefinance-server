import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";
import Transaction from "../models/Transaction.js";
import EMIPlan from "../models/EMIPlan.js";
import EMIInstallment from "../models/EMIInstallment.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Category from "../models/Category.js";
import Account from "../models/Account.js";
import MonthlyBalance from "../models/MonthlyBalance.js";
import { auditEmiRecords } from "../utils/emiIntegrity.js";
import { writableMonth } from "../utils/carryForwardRules.js";
import { scheduleForPlan, installmentIndexForMonth, buildResumedSchedule } from "../utils/emiSchedule.js";
import { normalizeEmiPaymentFunding, parseEmiPaymentDate } from "../utils/emiPaymentFunding.js";

import {
  splitEqual,
  splitPersonal,
  splitRatio,
  splitFixed,
  round2,
} from "../utils/splitCalc.js";
import { regularAmount, amountForIndex, newPlanRegularAmount, splitInstallment, validatePlanSplit, summarizeEmiDues } from "../utils/emiAccounting.js";

const router = Router();

function currentMonth() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthKey(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function addMonths(yyyyMm, add) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const dt = new Date(y, (m - 1) + add, 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function monthInRange(targetMonth, startMonth, endMonth) {
  if (!targetMonth || !startMonth || !endMonth) return false;
  return targetMonth >= startMonth && targetMonth <= endMonth;
}

function ownerFromMemberName(name) {
  const n = String(name || "").trim().toLowerCase();

  if (n.includes("mahbub")) return "Mahbub";
  if (n.includes("mirza")) return "Mirza";

  return "";
}

function diffMonthsInclusive(start, now, end) {
  let cur = now;
  if (cur < start) cur = start;
  if (cur > end) cur = end;

  const [sy, sm] = start.split("-").map(Number);
  const [cy, cm] = cur.split("-").map(Number);

  return (cy - sy) * 12 + (cm - sm) + 1;
}

function diffMonths(start, end) {
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  return (ey - sy) * 12 + (em - sm);
}

function getRegularMonthlyAmount(plan) {
  return regularAmount(plan);
}

function getLastInstallmentAmount(plan) {
  return amountForIndex(plan, Number(plan.months || 0) - 1);
}

function getInstallmentAmountForMonth(plan, targetMonth) {
  const idx = installmentIndexForMonth(plan, targetMonth);
  return amountForIndex(plan, idx);
}

function getExpectedPaidAmountUntilMonth(plan, nowMonth) {
  return round2(scheduleForPlan(plan).reduce((sum, dueMonth, index) =>
    sum + (dueMonth <= nowMonth ? amountForIndex(plan, index) : 0), 0));
}

async function computePlanStats(familyId, plan) {
  const monthNow = currentMonth();

  const totalMonths = Number(plan.months || 0);
  const totalPayable = Number(plan.totalPayable || 0);

  const paidInstallments = await EMIInstallment.find({
    familyId,
    planId: plan._id,
    status: "paid",
  }).select("amount");

  const paidCount = paidInstallments.length;
  const actualPaidAmount = round2(
    paidInstallments.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  );

  const remainingMonths = Math.max(0, totalMonths - paidCount);
  const remaining = Math.max(0, round2(totalPayable - actualPaidAmount));
  const progress =
    totalPayable > 0 ? round2((actualPaidAmount / totalPayable) * 100) : 0;

  let behindBy = 0;
  if (plan.startMonth && monthNow >= plan.startMonth) {
    const expectedPaidAmount = getExpectedPaidAmountUntilMonth(plan, monthNow);
    behindBy = Math.max(0, round2(expectedPaidAmount - actualPaidAmount));
  }

  return {
    paidCount,
    remainingMonths,
    remaining,
    progress,
    behindBy,
  };
}

// =====================
// Plans
// =====================

router.get("/plans", requireAuth, requireFamily, async (req, res) => {
  const plans = await EMIPlan.find({ familyId: req.familyId }).sort({
    createdAt: -1,
  });

  const withStats = [];
  for (const p of plans) {
    const stats = await computePlanStats(req.familyId, p);
    withStats.push({
      ...p.toObject(),
      monthlyAmount: getRegularMonthlyAmount(p),
      stats,
    });
  }
  res.json({ ok: true, plans: withStats });
});

router.post("/plans", requireAuth, requireFamily, async (req, res) => {
  const {
    productName,
    brand,
    category,
    purchaseDate,
    originalPrice,
    emiCharge,
    months,
    startMonth,
    splitType,
    personalUserId,
    ratios,
    fixed,
    note,
  } = req.body || {};

  if (!productName || !purchaseDate || !originalPrice || !months || !startMonth) {
    return res.status(400).json({ ok: false, message: "Missing required fields" });
  }

  const m = Number(months);
  const allowedMonths = new Set([1, 3, 6, 9, 12, 18, 24, 36]);
  if (!Number.isFinite(m) || m <= 0 || !allowedMonths.has(m)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid months. Allowed: 1,3,6,9,12,18,24,36",
    });
  }

  const op = Number(originalPrice);
  const pct = Number(emiCharge || 0);

  if (!Number.isFinite(op) || op <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Original price must be a positive number",
    });
  }

  if (!Number.isFinite(pct) || pct < 0) {
    return res.status(400).json({
      ok: false,
      message: "EMI charge (%) must be a non-negative number",
    });
  }

  const tp = round2(op + (op * pct) / 100);
  if (Math.round(tp * 100) < m) {
    return res.status(400).json({ ok: false, message: "Total payable is too small for this installment duration." });
  }
  const monthlyAmount = newPlanRegularAmount(tp, m);

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(startMonth))) {
    return res.status(400).json({ ok: false, message: "Invalid start month (YYYY-MM)" });
  }
  if (Number.isNaN(new Date(purchaseDate).getTime())) {
    return res.status(400).json({ ok: false, message: "Invalid purchase date" });
  }
  try {
    const members = await FamilyMember.find({ familyId: req.familyId }).select("userId").lean();
    validatePlanSplit({ splitType, personalUserId, ratios, fixed }, members.map((r) => r.userId), monthlyAmount);
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false, message: error.message });
  }
  const endMonth = addMonths(startMonth, m - 1);

  const plan = await EMIPlan.create({
    familyId: req.familyId,
    productName: productName.trim(),
    brand: (brand || "").trim(),
    category: (category || "").trim(),
    purchaseDate: new Date(purchaseDate),
    originalPrice: op,
    emiCharge: pct,
    totalPayable: tp,
    months: m,
    startMonth,
    endMonth,
    monthlyAmount,
    splitType: splitType || "equal",
    personalUserId: personalUserId || null,
    ratios: Array.isArray(ratios) ? ratios : [],
    fixed: Array.isArray(fixed) ? fixed : [],
    note: (note || "").trim(),
    createdByUserId: req.user.userId,
  });

  res.json({ ok: true, plan });
});

router.get("/due-summary", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = String(req.query.month || currentMonth());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ ok: false, message: "Invalid month" });
    const plans = await EMIPlan.find({ familyId: req.familyId }).lean();
    const installments = await EMIInstallment.find({ familyId: req.familyId, month: { $lte: month } })
      .select("planId month status paidAt").lean();
    res.json({ ok: true, summary: summarizeEmiDues(plans, installments, month) });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message || "Unable to calculate EMI dues" });
  }
});

// Read-only reconciliation. Never alters historic installment/ledger records.
router.get("/integrity", requireAuth, requireFamily, async (req, res) => {
  try {
    const familyId = req.familyId;
    const month = String(req.query.month || currentMonth());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ ok: false, message: "Invalid reconciliation month (YYYY-MM)" });
    }
    const [plans, installments, transactions, accounts] = await Promise.all([
      EMIPlan.find({ familyId }).lean(),
      EMIInstallment.find({ familyId }).lean(),
      Transaction.find({ familyId, sourceType: "emi_installment" })
        .select("_id sourceId sourceType txType amount month date fromAccountId").lean(),
      Account.find({ familyId }).select("_id name type owner").lean(),
    ]);
    const ledgerEntries = await LedgerEntry.find({ familyId, module: "emi" })
      .select("_id sourceType sourceId amountTotal month").lean();
    const splits = ledgerEntries.length
      ? await Split.find({ familyId, ledgerEntryId: { $in: ledgerEntries.map(r => r._id) } })
        .select("ledgerEntryId userId shareAmount").lean()
      : [];
    return res.json({ ok: true, report: auditEmiRecords({ plans, installments, transactions, ledgerEntries, splits, accounts, asOfMonth: month }) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Could not check EMI record integrity" });
  }
});

// Editing old records never rewrites existing generated bills or payments.
router.put('/plans/:id', requireAuth, requireFamily, async (req, res) => {
  try {
    const plan = await EMIPlan.findOne({ familyId: req.familyId, _id: req.params.id });
    if (!plan) return res.status(404).json({ok:false,message:'পরিকল্পনা পাওয়া যায়নি।'});
    const bills = await EMIInstallment.exists({familyId:req.familyId,planId:plan._id});
    const metadata = ['productName','brand','category','note'];
    for (const key of metadata) if (req.body?.[key] !== undefined) plan[key] = String(req.body[key] || '').trim();
    if (!plan.productName) return res.status(400).json({ok:false,message:'পণ্যের নাম প্রয়োজন।'});
    if (bills && ['months','startMonth','originalPrice','emiCharge','splitType','personalUserId','ratios','fixed']
      .some(key => req.body?.[key] !== undefined && JSON.stringify(req.body[key]) !== JSON.stringify(plan[key]))) {
      return res.status(409).json({ok:false,message:'এই পরিকল্পনার বিল তৈরি হয়েছে। মূল্য, মেয়াদ বা ভাগ পাল্টালে পুরোনো হিসাব বদলে যাবে। শুধু নাম, খাত ও নোট পরিবর্তন করুন।'});
    }
    if (!bills && ['months','startMonth','originalPrice','emiCharge','splitType'].some(key=>req.body?.[key] !== undefined)) {
      const count=Number(req.body.months ?? plan.months);
      const price=Number(req.body.originalPrice ?? plan.originalPrice);
      const charge=Number(req.body.emiCharge ?? plan.emiCharge);
      const start=String(req.body.startMonth ?? plan.startMonth);
      if (!Number.isInteger(count) || count<1 || count>36 || !Number.isFinite(price) || price<=0 || !Number.isFinite(charge) || charge<0 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(start)) return res.status(400).json({ok:false,message:'কিস্তির মূল্য/মেয়াদ সঠিক নয়।'});
      const total=round2(price*(1+charge/100));
      if (Math.round(total*100)<count) return res.status(400).json({ok:false,message:'মোট টাকা খুব কম।'});
      const next={splitType:req.body.splitType ?? plan.splitType, personalUserId:req.body.personalUserId ?? plan.personalUserId, ratios:req.body.ratios ?? plan.ratios, fixed:req.body.fixed ?? plan.fixed};
      const members=await FamilyMember.find({familyId:req.familyId}).select('userId').lean();
      validatePlanSplit(next,members.map(m=>m.userId),newPlanRegularAmount(total,count));
      Object.assign(plan,{originalPrice:price,emiCharge:charge,totalPayable:total,months:count,startMonth:start,endMonth:addMonths(start,count-1),monthlyAmount:newPlanRegularAmount(total,count),scheduleMonths:[],...next});
    }
    await plan.save();
    res.json({ok:true,plan});
  } catch(err) { res.status(err.status||500).json({ok:false,message:err.message||'পরিকল্পনা পরিবর্তন করা যায়নি।'}); }
});

// Explicit pause is different from completed/closed. Resume never changes a paid bill.
router.post('/plans/:id/resume', requireAuth, requireFamily, async (req,res)=>{
  try {
    const resumeMonth=String(req.body?.resumeMonth || currentMonth());
    const mode=String(req.body?.mode || 'from-now');
    if (!['from-now','include-missed'].includes(mode)) return res.status(400).json({ok:false,message:'চালু করার পদ্ধতি সঠিক নয়।'});
    if (!writableMonth(resumeMonth) || resumeMonth < currentMonth()) return res.status(409).json({ok:false,message:'চলতি বা ভবিষ্যতের মাস থেকে চালু করতে পারবেন।'});
    const plan=await EMIPlan.findOne({familyId:req.familyId,_id:req.params.id});
    if (!plan) return res.status(404).json({ok:false,message:'পরিকল্পনা পাওয়া যায়নি।'});
    if (plan.status==='active') return res.status(409).json({ok:false,message:'কিস্তি ইতিমধ্যে চালু রয়েছে।'});
    const bills=await EMIInstallment.find({familyId:req.familyId,planId:plan._id}).select('month status').lean();
    if (mode==='from-now') {
      const paidMonths=bills.filter(b=>b.status==='paid').map(b=>b.month);
      const schedule=buildResumedSchedule(plan,paidMonths,resumeMonth);
      const future=new Set(schedule);
      const conflicts=bills.filter(b=>b.status==='pending');
      if (conflicts.length) return res.status(409).json({ok:false,message:`পুরোনো ${conflicts.length}টি অবৈতনিক বিল আছে। এগুলো আগে বাতিল করুন, তারপর নতুন মাস থেকে চালু করুন।`});
      plan.scheduleMonths=schedule;
      plan.endMonth=schedule.at(-1);
    }
    plan.status='active';
    await plan.save();
    res.json({ok:true,plan});
  } catch(err) {res.status(err.status||500).json({ok:false,message:err.message||'কিস্তি চালু করা যায়নি।'});}
});

router.put("/plans/:id/status", requireAuth, requireFamily, async (req, res) => {
  const { status } = req.body || {};

  if (!["active", "paused", "closed"].includes(status)) {
    return res.status(400).json({ ok: false, message: "Invalid status" });
  }

  const existing = await EMIPlan.findOne({ _id: req.params.id, familyId: req.familyId });
  if (!existing) return res.status(404).json({ ok: false, message: "Plan not found" });
  if (status === "active" && existing.status !== "active") return res.status(409).json({ok:false,message:"বিরতির পর চালু করতে Resume ব্যবহার করুন।"});
  if (status === "closed") {
    const paid = await EMIInstallment.find({ familyId: req.familyId, planId: existing._id, status: "paid" }).select("amount").lean();
    const paidTotal = round2(paid.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    if (paidTotal < round2(existing.totalPayable) - 0.009) {
      return res.status(409).json({ ok: false, message: "Cannot close an EMI plan with outstanding installments. Paid history and remaining liability must be preserved." });
    }
  }
  existing.status = status;
  const plan = await existing.save();

  if (!plan) {
    return res.status(404).json({ ok: false, message: "Plan not found" });
  }

  res.json({ ok: true, plan });
});

// =====================
// Installments
// =====================

router.get("/installments", requireAuth, requireFamily, async (req, res) => {
  const month = String(req.query.month || "").trim();

  if (!month) {
    return res.status(400).json({ ok: false, message: "month is required" });
  }

  // Read-only by design. Never delete legacy ledger data while merely viewing EMI bills.
  // Historical inconsistencies appear in /integrity for explicit review.
  const items = await EMIInstallment.find({
    familyId: req.familyId,
    month,
  })
    .populate("planId", "productName")
    .sort({ createdAt: -1 });

  res.json({ ok: true, items });
});

async function resolveEmiExpenseCategory(familyId, expenseCategoryId) {
  let cat = null;

  if (expenseCategoryId) {
    cat = await Category.findOne({
      _id: expenseCategoryId,
      familyId,
      kind: "expense",
    });
  }

  if (!cat) {
    cat = await Category.findOne({
      familyId,
      kind: "expense",
      name: { $regex: /^\s*emi\s*$/i },
    });
  }

  return cat;
}

// Step 05: generated bills must never silently change a manually corrected
// historical month or a formally closed month. This creates no cash entry.
async function ensureEditableEmiBillMonth(familyId, month) {
  if (!writableMonth(String(month || ''))) {
    const err = new Error('Only October 2026 and later valid months can receive new EMI bills. Historical months are protected.');
    err.status = 409;
    throw err;
  }
  const closed = await MonthlyBalance.exists({
    familyId, month, closingBalance: { $ne: null },
  });
  if (closed) {
    const err = new Error('This month is already closed. EMI bills cannot be generated in a closed month.');
    err.status = 409;
    throw err;
  }
}

async function generateInstallmentsForPlans({
  familyId,
  month,
  expenseCategoryId,
  planIds = null,
}) {
  await ensureEditableEmiBillMonth(familyId, month);
  const cat = await resolveEmiExpenseCategory(familyId, expenseCategoryId);

  if (!cat) {
    const error = new Error(
      "EMI expense category not found. Please create an Expense category named 'EMI' in Settings."
    );
    error.status = 400;
    throw error;
  }

  const planQuery = { familyId, status: "active" };
  if (Array.isArray(planIds) && planIds.length > 0) {
    planQuery._id = { $in: planIds };
  }

  const plans = await EMIPlan.find(planQuery);
  let createdCount = 0;

  for (const p of plans) {
    if (installmentIndexForMonth(p, month) < 0) continue;

    const exists = await EMIInstallment.findOne({
      familyId,
      planId: p._id,
      month,
    });

    if (exists) continue;

    const amount = getInstallmentAmountForMonth(p, month);
    const dueDate = new Date(`${month}-01`);

    // A generated installment is only a schedule. It must not affect the
    // dashboard, debt, spend, or member shares before payment is recorded.
    await EMIInstallment.create({
      familyId,
      planId: p._id,
      month,
      dueDate,
      amount,
      status: "pending",
      categoryId: cat._id,
      ledgerEntryId: null,
    });

    createdCount++;
  }

  return {
    createdCount,
    usedCategory: { id: cat._id, name: cat.name },
  };
}

router.post("/generate", requireAuth, requireFamily, async (req, res) => {
  try {
    const { month, expenseCategoryId } = req.body || {};

    if (!month) {
      return res.status(400).json({ ok: false, message: "month required" });
    }

    const result = await generateInstallmentsForPlans({
      familyId: req.familyId,
      month,
      expenseCategoryId,
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("EMI generate error:", err);
    res.status(err.status || 500).json({
      ok: false,
      message: err.message || "Generate failed (server error)",
    });
  }
});

router.post("/plans/:id/generate", requireAuth, requireFamily, async (req, res) => {
  try {
    const { month, expenseCategoryId } = req.body || {};

    if (!month) {
      return res.status(400).json({ ok: false, message: "month required" });
    }

    const plan = await EMIPlan.findOne({
      _id: req.params.id,
      familyId: req.familyId,
      status: "active",
    });

    if (!plan) {
      return res.status(404).json({
        ok: false,
        message: "Active EMI plan not found",
      });
    }

    if (installmentIndexForMonth(plan, month) < 0) {
      return res.status(400).json({
        ok: false,
        message: `Selected month is outside this plan's active range (${plan.startMonth} to ${plan.endMonth})`,
      });
    }

    const result = await generateInstallmentsForPlans({
      familyId: req.familyId,
      month,
      expenseCategoryId,
      planIds: [plan._id],
    });

    res.json({
      ok: true,
      planId: plan._id,
      ...result,
    });
  } catch (err) {
    console.error("EMI single generate error:", err);
    res.status(err.status || 500).json({
      ok: false,
      message: err.message || "Generate failed (server error)",
    });
  }
});

async function buildEmiSplitRows(familyId, plan, amount) {
  const members = await FamilyMember.find({ familyId }).select("userId").lean();
  const userIds = members.map((member) => String(member.userId)).filter(Boolean);
  if (!userIds.length) {
    const error = new Error("No family members found for EMI split");
    error.status = 400;
    throw error;
  }
  validatePlanSplit(plan, userIds, getRegularMonthlyAmount(plan));
  return splitInstallment(plan, amount, userIds);
}

function normalizedEmiSplit(plan, splitRows) {
  if (plan.splitType === "personal") {
    return { type: "personal", personalUserId: plan.personalUserId || null, ratios: [], fixed: [] };
  }
  if (plan.splitType === "ratio") {
    return {
      type: "ratio",
      personalUserId: null,
      ratios: (plan.ratios || []).map((row) => ({ userId: row.userId, ratio: Number(row.ratio || 0) })),
      fixed: [],
    };
  }
  if (plan.splitType === "fixed") {
    return {
      type: "fixed",
      personalUserId: null,
      ratios: [],
      fixed: splitRows.map((row) => ({ userId: row.userId, amount: Number(row.shareAmount || 0) })),
    };
  }
  return { type: "equal", personalUserId: null, ratios: [], fixed: [] };
}

// A payment is an atomic financial event: Transaction, LedgerEntry, Split, and
// EMIInstallment must commit together. Requires MongoDB replica set / Atlas.
// No writes occur if the transaction cannot be started or committed.
async function runAtomicEmiWrite(operation) {
  try {
    return await mongoose.connection.transaction(async (session) => operation(session));
  } catch (err) {
    const message = String(err?.message || "");
    if (/Transaction numbers are only allowed on a replica set|does not support retryable writes|replica set|transactions are not supported/i.test(message)) {
      const error = new Error("This database does not support atomic payments. Use MongoDB Atlas or a replica set; no EMI payment was recorded.");
      error.status = 503;
      throw error;
    }
    throw err;
  }
}

function emiConflict(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

async function refuseClosedMonth(familyId, month, session) {
  const closed = await MonthlyBalance.findOne({ familyId, month, closedAt: { $ne: null } }).session(session).lean();
  if (closed) emiConflict(`The ${month} month is closed. Reopen and reconcile it before changing an EMI payment dated in that month.`);
}

router.put("/installments/:id/status", requireAuth, requireFamily, async (req, res) => {
  try {
    const { status, paidByUserId, fromAccountId, paidDate, paymentMode, paymentParts } = req.body || {};
    if (!["paid", "pending"].includes(status)) {
      return res.status(400).json({ ok: false, message: "Invalid status" });
    }
    let payDate = null;
    if (status === "paid") {
      try { payDate = parseEmiPaymentDate(paidDate); }
      catch (err) { return res.status(400).json({ ok: false, message: err.message }); }
    }

    const updated = await runAtomicEmiWrite(async (session) => {
      const inst = await EMIInstallment.findOne({ _id: req.params.id, familyId: req.familyId }).session(session);
      if (!inst) {
        const err = new Error("Installment not found");
        err.status = 404;
        throw err;
      }

      if (status === "paid") {
        if (inst.status !== "pending") emiConflict("This installment was already paid. No second payment was recorded.");
        if (inst.transactionId || inst.ledgerEntryId) {
          emiConflict("Pending installment has legacy payment links. Review its integrity report before recording another payment.");
        }
        const previouslyPosted = await Transaction.findOne({ familyId: req.familyId, sourceType: "emi_installment", sourceId: inst._id }).session(session).lean();
        if (previouslyPosted) emiConflict("A linked transaction already exists. Duplicate EMI payment blocked; inspect the integrity report.");
        const plan = await EMIPlan.findOne({ _id: inst.planId, familyId: req.familyId }).session(session);
        if (!plan) emiConflict("Missing EMI plan; cannot safely record a payment");
        const familyMembers = await FamilyMember.find({ familyId: req.familyId }).session(session)
          .populate({ path: "userId", select: "name", options: { session } });
        const fundingAccounts = await Account.find({ familyId: req.familyId, isActive: true }).session(session);
        let funding;
        try {
          funding = normalizeEmiPaymentFunding({
            paymentMode, paidByUserId, fromAccountId, paymentParts,
            totalAmount: Number(inst.amount), familyMembers, accounts: fundingAccounts,
          });
        } catch (err) { err.status = 400; throw err; }
        const category = (inst.categoryId
          ? await Category.findOne({ _id: inst.categoryId, familyId: req.familyId, kind: "expense" }).session(session)
          : null) || (await Category.findOne({ familyId: req.familyId, kind: "expense", name: { $regex: /^\s*emi\s*$/i } }).session(session));
        if (!category) {
          const err = new Error("EMI expense category missing. Create it in Settings first.");
          err.status = 400;
          throw err;
        }
        const paidMonth = monthKey(payDate);
        if (!writableMonth(paidMonth)) emiConflict('Payments dated before October 2026 are protected. Record a genuine new payment using its actual current date.');
        await refuseClosedMonth(req.familyId, paidMonth, session);
        const memberRows = await FamilyMember.find({ familyId: req.familyId }).select("userId").session(session).lean();
        const userIds = memberRows.map(r => String(r.userId));
        validatePlanSplit(plan, userIds, regularAmount(plan));
        const shareRows = splitInstallment(plan, Number(inst.amount), userIds);
        const shareCents = shareRows.reduce((sum, r) => sum + Math.round(Number(r.shareAmount) * 100), 0);
        if (shareCents !== Math.round(Number(inst.amount) * 100)) emiConflict("EMI member shares do not balance; payment blocked");
        const note = `EMI: ${plan.productName}`;
        const [tx] = await Transaction.create([{
          familyId: req.familyId, txType: "expense", date: payDate, month: paidMonth,
          categoryId: category._id, amount: Number(inst.amount), note,
          fromAccountId: funding.fromAccountId, toAccountId: null, paidByUserId: funding.paidByUserId,
          receivedByUserId: null, paymentMode: funding.paymentMode,
          paymentParts: funding.paymentParts,
          split: normalizedEmiSplit(plan, shareRows), budgetImpact: true,
          ledgerEligible: true, settlementImpact: true, sourceType: "emi_installment",
          sourceId: inst._id, createdByUserId: req.user.userId,
        }], { session });
        const [entry] = await LedgerEntry.create([{
          familyId: req.familyId, entryType: "expense", financialType: "debt",
          module: "emi", date: payDate, month: paidMonth, categoryId: category._id,
          amountTotal: Number(inst.amount), paidByUserId: funding.paidByUserId, receivedByUserId: null,
          note, sourceType: "transaction", sourceId: tx._id,
          createdByUserId: req.user.userId,
        }], { session });
        await Split.insertMany(shareRows.map(row => ({
          familyId: req.familyId, ledgerEntryId: entry._id,
          userId: row.userId, shareAmount: Number(row.shareAmount),
        })), { session });
        inst.status = "paid";
        inst.paidByUserId = funding.paidByUserId;
        inst.paidAt = payDate;
        inst.categoryId = category._id;
        inst.transactionId = tx._id;
        inst.ledgerEntryId = entry._id;
        await inst.save({ session });
        return inst.toObject();
      }

      // Reverse only fully verified paid records. Never delete an unrelated or
      // inconsistent historical transaction automatically.
      if (inst.status === "pending" && !inst.transactionId && !inst.ledgerEntryId) {
        return { ...inst.toObject(), alreadyPending: true };
      }
      if (inst.status !== "paid" || !inst.transactionId || !inst.ledgerEntryId) {
        emiConflict("This installment has incomplete payment links. Review the EMI integrity report; automatic reversal is blocked.");
      }
      const plan = await EMIPlan.findOne({ _id: inst.planId, familyId: req.familyId }).session(session);
      if (!plan) emiConflict("EMI plan is missing; automatic reversal is blocked.");
      if (plan.status === "closed") emiConflict("Reopen the EMI plan before reversing one of its payments.");
      const tx = await Transaction.findOne({ _id: inst.transactionId, familyId: req.familyId }).session(session);
      const entry = await LedgerEntry.findOne({ _id: inst.ledgerEntryId, familyId: req.familyId }).session(session);
      if (!tx || !entry || tx.sourceType !== "emi_installment" || String(tx.sourceId) !== String(inst._id)
        || entry.sourceType !== "transaction" || String(entry.sourceId) !== String(tx._id)) {
        emiConflict("EMI payment references are inconsistent. Nothing was removed; review the integrity report.");
      }
      if (!writableMonth(tx.month)) emiConflict('Historical EMI payments before October 2026 cannot be reversed.');
      await refuseClosedMonth(req.familyId, tx.month, session);
      await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: entry._id }).session(session);
      await LedgerEntry.deleteOne({ familyId: req.familyId, _id: entry._id }).session(session);
      await Transaction.deleteOne({ familyId: req.familyId, _id: tx._id }).session(session);
      inst.status = "pending";
      inst.paidByUserId = null;
      inst.paidAt = null;
      inst.transactionId = null;
      inst.ledgerEntryId = null;
      await inst.save({ session });
      return inst.toObject();
    });
    return res.json({ ok: true, installment: updated, ...(updated.alreadyPending ? { alreadyPending: true } : {}) });
  } catch (error) {
    console.error("Atomic EMI change rejected:", error);
    return res.status(error.status || (error.code === 11000 ? 409 : 500)).json({
      ok: false,
      message: error.code === 11000 ? "Duplicate EMI source record detected; nothing was charged" : (error.message || "EMI change failed"),
    });
  }
});

router.delete("/installments/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    await runAtomicEmiWrite(async (session) => {
      const inst = await EMIInstallment.findOne({ _id: req.params.id, familyId: req.familyId }).session(session);
      if (!inst) {
        const error = new Error("Installment not found");
        error.status = 404;
        throw error;
      }
      if (inst.status !== "pending" || inst.transactionId || inst.ledgerEntryId) {
        emiConflict("Only an unpaid, unlinked generated EMI bill can be deleted");
      }
      if (!writableMonth(inst.month)) emiConflict('Historical generated bills before October 2026 are protected.');
      await refuseClosedMonth(req.familyId, inst.month, session);
      const linkedTx = await Transaction.findOne({ familyId: req.familyId, sourceType: "emi_installment", sourceId: inst._id }).session(session).lean();
      if (linkedTx) emiConflict("Found a linked transaction: deletion blocked to protect financial history");
      await EMIInstallment.deleteOne({ _id: inst._id, familyId: req.familyId, status: "pending" }).session(session);
    });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, message: error.message || "Could not delete EMI bill" });
  }
});

export default router;