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
import Account from "../models/Account.js";

import {
  splitEqual,
  splitPersonal,
  splitRatio,
  splitFixed,
  round2,
} from "../utils/splitCalc.js";
import { cleanupPendingInstallmentLedgers } from "../utils/installmentLedger.js";

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

  await cleanupPendingInstallmentLedgers(req.familyId, month);

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

  if (plan.splitType === "personal") return splitPersonal(amount, plan.personalUserId);
  if (plan.splitType === "ratio") return splitRatio(amount, plan.ratios || []);
  if (plan.splitType === "fixed") return splitFixed(amount, plan.fixed || []);
  return splitEqual(amount, userIds);
}

function normalizedEmiSplit(plan) {
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
      fixed: (plan.fixed || []).map((row) => ({ userId: row.userId, amount: Number(row.amount || 0) })),
    };
  }
  return { type: "equal", personalUserId: null, ratios: [], fixed: [] };
}

// update installment status
router.put("/installments/:id/status", requireAuth, requireFamily, async (req, res) => {
  try {
    const { status, paidByUserId, fromAccountId, paidDate } = req.body || {};

    if (!["pending", "paid"].includes(status)) {
      return res.status(400).json({ ok: false, message: "Invalid status" });
    }

    const inst = await EMIInstallment.findOne({
      _id: req.params.id,
      familyId: req.familyId,
    }).populate("planId", "productName splitType personalUserId ratios fixed");

    if (!inst) {
      return res.status(404).json({ ok: false, message: "Installment not found" });
    }

    let entry = null;
    if (inst.ledgerEntryId) {
      entry = await LedgerEntry.findOne({
        _id: inst.ledgerEntryId,
        familyId: req.familyId,
      });
    }
    if (!entry && inst.transactionId) {
      entry = await LedgerEntry.findOne({
        familyId: req.familyId,
        sourceType: "transaction",
        sourceId: inst.transactionId,
      });
    }

    if (status === "paid") {
      if (!paidByUserId) {
        return res.status(400).json({ ok: false, message: "paidByUserId is required" });
      }
      if (!fromAccountId) {
        return res.status(400).json({ ok: false, message: "fromAccountId is required" });
      }

      const payDate = paidDate ? new Date(paidDate) : new Date();
      if (Number.isNaN(payDate.getTime())) {
        return res.status(400).json({ ok: false, message: "Invalid paidDate" });
      }

      const txMonth = monthKey(payDate);
      const account = await Account.findOne({
        _id: fromAccountId,
        familyId: req.familyId,
        isActive: true,
      }).select("_id name type owner");

      if (!account) {
        return res.status(400).json({ ok: false, message: "Selected account not found" });
      }
      if (!["cash", "bank", "wallet"].includes(account.type)) {
        return res.status(400).json({
          ok: false,
          message: "EMI payment must be made from a cash, bank, or wallet account",
        });
      }

      const payerMember = await FamilyMember.findOne({
        familyId: req.familyId,
        userId: paidByUserId,
      }).populate("userId", "name");

      if (!payerMember) {
        return res.status(400).json({
          ok: false,
          message: "Selected payer is not a valid family member",
        });
      }

      const payerOwner = ownerFromMemberName(payerMember?.userId?.name);
      if (payerOwner && account.owner !== payerOwner && account.owner !== "Joint") {
        return res.status(400).json({
          ok: false,
          message: "Selected account does not belong to the selected payer",
        });
      }

      const category =
        (inst.categoryId
          ? await Category.findOne({ _id: inst.categoryId, familyId: req.familyId, kind: "expense" })
          : null) ||
        (entry?.categoryId
          ? await Category.findOne({ _id: entry.categoryId, familyId: req.familyId, kind: "expense" })
          : null) ||
        (await resolveEmiExpenseCategory(req.familyId, null));

      if (!category) {
        return res.status(400).json({
          ok: false,
          message: "EMI expense category not found. Please create an Expense category named 'EMI' in Settings.",
        });
      }

      const amount = Number(inst.amount || 0);
      const txNote = `EMI: ${inst?.planId?.productName || "Installment payment"}`;
      const splitRows = await buildEmiSplitRows(req.familyId, inst.planId, amount);
      const txSplit = normalizedEmiSplit(inst.planId);

      let transaction = inst.transactionId
        ? await Transaction.findOne({ _id: inst.transactionId, familyId: req.familyId })
        : null;

      if (!transaction) {
        transaction = await Transaction.create({
          familyId: req.familyId,
          txType: "expense",
          date: payDate,
          month: txMonth,
          categoryId: category._id,
          amount,
          note: txNote,
          fromAccountId,
          toAccountId: null,
          paidByUserId,
          receivedByUserId: null,
          paymentMode: "single",
          paymentParts: [{ userId: paidByUserId, accountId: fromAccountId, amount }],
          split: txSplit,
          budgetImpact: true,
          ledgerEligible: true,
          settlementImpact: true,
          sourceType: "emi_installment",
          sourceId: inst._id,
          createdByUserId: req.user.userId,
        });
      } else {
        transaction.txType = "expense";
        transaction.date = payDate;
        transaction.month = txMonth;
        transaction.categoryId = category._id;
        transaction.amount = amount;
        transaction.note = txNote;
        transaction.fromAccountId = fromAccountId;
        transaction.toAccountId = null;
        transaction.paidByUserId = paidByUserId;
        transaction.receivedByUserId = null;
        transaction.paymentMode = "single";
        transaction.paymentParts = [{ userId: paidByUserId, accountId: fromAccountId, amount }];
        transaction.split = txSplit;
        transaction.budgetImpact = true;
        transaction.ledgerEligible = true;
        transaction.settlementImpact = true;
        transaction.sourceType = "emi_installment";
        transaction.sourceId = inst._id;
        await transaction.save();
      }

      if (!entry) {
        entry = await LedgerEntry.create({
          familyId: req.familyId,
          entryType: "expense",
          financialType: "debt",
          module: "emi",
          date: payDate,
          month: txMonth,
          categoryId: category._id,
          amountTotal: amount,
          paidByUserId,
          receivedByUserId: null,
          note: txNote,
          sourceType: "transaction",
          sourceId: transaction._id,
          createdByUserId: req.user.userId,
        });
      } else {
        entry.entryType = "expense";
        entry.financialType = "debt";
        entry.module = "emi";
        entry.date = payDate;
        entry.month = txMonth;
        entry.categoryId = category._id;
        entry.amountTotal = amount;
        entry.paidByUserId = paidByUserId;
        entry.receivedByUserId = null;
        entry.note = txNote;
        entry.sourceType = "transaction";
        entry.sourceId = transaction._id;
        await entry.save();
      }

      await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: entry._id });
      await Split.insertMany(
        splitRows.map((row) => ({
          familyId: req.familyId,
          ledgerEntryId: entry._id,
          userId: row.userId,
          shareAmount: Number(row.shareAmount || 0),
        }))
      );

      inst.status = "paid";
      inst.categoryId = category._id;
      inst.ledgerEntryId = entry._id;
      inst.transactionId = transaction._id;
      inst.paidByUserId = paidByUserId;
      inst.paidAt = payDate;
      await inst.save();

      return res.json({ ok: true, installment: inst });
    }

    if (inst.transactionId) {
      await Transaction.deleteOne({ _id: inst.transactionId, familyId: req.familyId });
    }
    if (entry) {
      await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: entry._id });
      await LedgerEntry.deleteOne({ _id: entry._id, familyId: req.familyId });
    }

    inst.status = "pending";
    inst.paidByUserId = null;
    inst.paidAt = null;
    inst.transactionId = null;
    inst.ledgerEntryId = null;
    await inst.save();

    return res.json({ ok: true, installment: inst });
  } catch (error) {
    console.error("EMI status update error:", error);
    return res.status(error.status || 500).json({
      ok: false,
      message: error?.message || "Could not update EMI status",
    });
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