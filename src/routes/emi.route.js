import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";
import Transaction from "../models/Transaction.js";
import EMIPlan from "../models/EMIPlan.js";
import EMIInstallment from "../models/EMIInstallment.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Category from "../models/Category.js";

import {
  splitEqual,
  splitPersonal,
  splitRatio,
  splitFixed,
  round2,
} from "../utils/splitCalc.js";

const router = Router();

function currentMonth() {
  const d = new Date();
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
  const total = Number(plan.totalPayable || 0);
  const months = Number(plan.months || 0);
  if (months <= 0) return 0;
  return Math.ceil(total / months);
}

function getLastInstallmentAmount(plan) {
  const total = Number(plan.totalPayable || 0);
  const months = Number(plan.months || 0);
  if (months <= 0) return 0;
  if (months === 1) return round2(total);

  const regular = getRegularMonthlyAmount(plan);
  return round2(total - regular * (months - 1));
}

function getInstallmentAmountForMonth(plan, targetMonth) {
  const months = Number(plan.months || 0);
  if (months <= 0) return 0;

  const idx = diffMonths(plan.startMonth, targetMonth) + 1;

  if (idx < 1 || idx > months) return 0;

  if (idx === months) {
    return getLastInstallmentAmount(plan);
  }

  return getRegularMonthlyAmount(plan);
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

// list plans (+ stats)
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

// create plan
router.post("/plans", requireAuth, requireFamily, async (req, res) => {
  const {
    productName,
    brand,
    category,
    purchaseDate,
    originalPrice,
    emiCharge,
    totalPayable, // ignored; server computes
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
  const monthlyAmount = Math.ceil(tp / m);
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

// update status
router.put("/plans/:id/status", requireAuth, requireFamily, async (req, res) => {
  const { status } = req.body || {};

  if (!["active", "closed"].includes(status)) {
    return res.status(400).json({ ok: false, message: "Invalid status" });
  }

  const plan = await EMIPlan.findOneAndUpdate(
    { _id: req.params.id, familyId: req.familyId },
    { status },
    { new: true }
  );

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
  currentUserId,
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

  const members = await FamilyMember.find({ familyId });
  let userIds = members.map((m) => String(m.userId));

  if (userIds.length === 0) {
    userIds = [String(currentUserId)];
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

    let splitRows = [];
    if (p.splitType === "equal") splitRows = splitEqual(amount, userIds);
    if (p.splitType === "personal")
      splitRows = splitPersonal(amount, p.personalUserId);
    if (p.splitType === "ratio") splitRows = splitRatio(amount, p.ratios);
    if (p.splitType === "fixed") splitRows = splitFixed(amount, p.fixed);

    const entry = await LedgerEntry.create({
      familyId,
      entryType: "expense",
      financialType: "debt",
      module: "emi",
      date: dueDate,
      month,
      categoryId: cat._id,
      amountTotal: amount,
      paidByUserId: null,
      note: `EMI: ${p.productName}`,
      createdByUserId: currentUserId,
    });

    await Split.insertMany(
      splitRows.map((r) => ({
        familyId,
        ledgerEntryId: entry._id,
        userId: r.userId,
        shareAmount: r.shareAmount,
      }))
    );

    await EMIInstallment.create({
      familyId,
      planId: p._id,
      month,
      dueDate,
      amount,
      status: "pending",
      ledgerEntryId: entry._id,
    });

    createdCount++;
  }

  return {
    createdCount,
    usedCategory: { id: cat._id, name: cat.name },
  };
}

// Generate all active plan bills for a month
router.post("/generate", requireAuth, requireFamily, async (req, res) => {
  try {
    const { month, expenseCategoryId } = req.body || {};

    if (!month) {
      return res.status(400).json({ ok: false, message: "month required" });
    }

    const result = await generateInstallmentsForPlans({
      familyId: req.familyId,
      currentUserId: req.user.userId,
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

// Generate only one selected plan bill for a month
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
      currentUserId: req.user.userId,
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

// update installment status
router.put("/installments/:id/status", requireAuth, requireFamily, async (req, res) => {
  const { status, paidByUserId } = req.body || {};

  if (!["pending", "paid"].includes(status)) {
    return res.status(400).json({ ok: false, message: "Invalid status" });
  }

  const inst = await EMIInstallment.findOne({
    _id: req.params.id,
    familyId: req.familyId,
  });

  if (!inst) {
    return res.status(404).json({ ok: false, message: "Installment not found" });
  }

  const entry = await LedgerEntry.findOne({
    _id: inst.ledgerEntryId,
    familyId: req.familyId,
  });

  if (!entry) {
    return res
      .status(404)
      .json({ ok: false, message: "Linked ledger entry not found" });
  }

  if (status === "paid") {
    if (!inst.transactionId) {
      const tx = await Transaction.create({
        familyId: req.familyId,
        txType: "expense",
        date: entry.date,
        month: inst.month,
        categoryId: entry.categoryId,
        amount: Number(inst.amount || entry.amountTotal || 0),
        note: entry.note || "EMI Payment",
        fromAccountId: null,
        toAccountId: null,
        paidByUserId: paidByUserId || req.user.userId,
        receivedByUserId: null,
        createdByUserId: req.user.userId,
      });

      inst.transactionId = tx._id;
    }

    inst.status = "paid";
    inst.paidByUserId = paidByUserId || req.user.userId;
    inst.paidAt = new Date();
    await inst.save();

    await LedgerEntry.updateOne(
      { _id: entry._id, familyId: req.familyId },
      {
        $set: {
          paidByUserId: inst.paidByUserId,
          sourceType: "transaction",
          sourceId: inst.transactionId,
        },
      }
    );

    return res.json({ ok: true, installment: inst });
  }

  if (status === "pending") {
    if (inst.transactionId) {
      await Transaction.deleteOne({
        _id: inst.transactionId,
        familyId: req.familyId,
      });
    }

    inst.status = "pending";
    inst.paidByUserId = null;
    inst.paidAt = null;
    inst.transactionId = null;
    await inst.save();

    await LedgerEntry.updateOne(
      { _id: entry._id, familyId: req.familyId },
      { $set: { paidByUserId: null, sourceType: "", sourceId: null } }
    );

    return res.json({ ok: true, installment: inst });
  }
});

// delete installment
router.delete("/installments/:id", requireAuth, requireFamily, async (req, res) => {
  const inst = await EMIInstallment.findOneAndDelete({
    _id: req.params.id,
    familyId: req.familyId,
  });

  if (!inst) {
    return res.status(404).json({ ok: false, message: "Installment not found" });
  }

  if (inst.transactionId) {
    await Transaction.deleteOne({
      _id: inst.transactionId,
      familyId: req.familyId,
    });
  }

  if (inst.ledgerEntryId) {
    await Split.deleteMany({
      familyId: req.familyId,
      ledgerEntryId: inst.ledgerEntryId,
    });

    await LedgerEntry.deleteOne({
      _id: inst.ledgerEntryId,
      familyId: req.familyId,
    });
  }

  res.json({ ok: true });
});

export default router;