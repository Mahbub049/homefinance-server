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
  const idx = diffMonths(plan.startMonth, targetMonth);
  return amountForIndex(plan, idx);
}

function getExpectedPaidAmountUntilMonth(plan, nowMonth) {
  if (!plan.startMonth || !plan.endMonth) return 0;
  if (nowMonth < plan.startMonth) return 0;

  const total = Number(plan.totalPayable || 0);
  const months = Number(plan.months || 0);
  if (months <= 0) return 0;

  let cur = nowMonth;
  if (cur > plan.endMonth) cur = plan.endMonth;

  const expectedMonths = diffMonthsInclusive(plan.startMonth, cur, plan.endMonth);
  if (expectedMonths <= 0) return 0;

  const regular = getRegularMonthlyAmount(plan);
  const last = getLastInstallmentAmount(plan);

  if (expectedMonths >= months) {
    return round2(total);
  }

  return round2(expectedMonths * regular);
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

router.put("/plans/:id/status", requireAuth, requireFamily, async (req, res) => {
  const { status } = req.body || {};

  if (!["active", "closed"].includes(status)) {
    return res.status(400).json({ ok: false, message: "Invalid status" });
  }

  const existing = await EMIPlan.findOne({ _id: req.params.id, familyId: req.familyId });
  if (!existing) return res.status(404).json({ ok: false, message: "Plan not found" });
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

async function generateInstallmentsForPlans({
  familyId,
  month,
  expenseCategoryId,
  planIds = null,
}) {
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
    if (!monthInRange(month, p.startMonth, p.endMonth)) continue;

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

    if (!monthInRange(month, plan.startMonth, plan.endMonth)) {
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
    const { status, paidByUserId, fromAccountId, paidDate } = req.body || {};
    if (!["paid", "pending"].includes(status)) {
      return res.status(400).json({ ok: false, message: "Invalid status" });
    }
    if (status === "paid" && (!paidByUserId || !fromAccountId)) {
      return res.status(400).json({ ok: false, message: "Select both a paying family member and a payment account" });
    }
    const payDate = status === "paid" ? (paidDate ? new Date(paidDate) : new Date()) : null;
    if (status === "paid" && Number.isNaN(payDate.getTime())) {
      return res.status(400).json({ ok: false, message: "Invalid payment date" });
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
        const account = await Account.findOne({ _id: fromAccountId, familyId: req.familyId, isActive: true }).session(session);
        if (!account || !["cash", "bank", "wallet"].includes(account.type)) {
          const err = new Error("Select an active cash, bank or mobile-wallet payment account");
          err.status = 400;
          throw err;
        }
        const payer = await FamilyMember.findOne({ familyId: req.familyId, userId: paidByUserId }).session(session)
          .populate({ path: "userId", select: "name", options: { session } });
        if (!payer) {
          const err = new Error("Selected payer is not a family member");
          err.status = 400;
          throw err;
        }
        const owner = ownerFromMemberName(payer.userId?.name);
        if ((!owner && account.owner !== "Joint") || (owner && account.owner !== owner && account.owner !== "Joint")) {
          const err = new Error("Selected account does not belong to this payer");
          err.status = 400;
          throw err;
        }
        const category = (inst.categoryId
          ? await Category.findOne({ _id: inst.categoryId, familyId: req.familyId, kind: "expense" }).session(session)
          : null) || (await Category.findOne({ familyId: req.familyId, kind: "expense", name: { $regex: /^\s*emi\s*$/i } }).session(session));
        if (!category) {
          const err = new Error("EMI expense category missing. Create it in Settings first.");
          err.status = 400;
          throw err;
        }
        const paidMonth = monthKey(payDate);
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
          fromAccountId: account._id, toAccountId: null, paidByUserId,
          receivedByUserId: null, paymentMode: "single",
          paymentParts: [{ userId: paidByUserId, accountId: account._id, amount: Number(inst.amount) }],
          split: normalizedEmiSplit(plan, shareRows), budgetImpact: true,
          ledgerEligible: true, settlementImpact: true, sourceType: "emi_installment",
          sourceId: inst._id, createdByUserId: req.user.userId,
        }], { session });
        const [entry] = await LedgerEntry.create([{
          familyId: req.familyId, entryType: "expense", financialType: "debt",
          module: "emi", date: payDate, month: paidMonth, categoryId: category._id,
          amountTotal: Number(inst.amount), paidByUserId, receivedByUserId: null,
          note, sourceType: "transaction", sourceId: tx._id,
          createdByUserId: req.user.userId,
        }], { session });
        await Split.insertMany(shareRows.map(row => ({
          familyId: req.familyId, ledgerEntryId: entry._id,
          userId: row.userId, shareAmount: Number(row.shareAmount),
        })), { session });
        inst.status = "paid";
        inst.paidByUserId = paidByUserId;
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