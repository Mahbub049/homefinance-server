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

async function computePlanStats(familyId, plan) {
  const monthNow = currentMonth();

  const totalMonths = Number(plan.months || 0);
  const monthly = Number(plan.monthlyAmount || 0);

  // paid installments count
  const paidCount = await EMIInstallment.countDocuments({
    familyId,
    planId: plan._id,
    status: "paid",
  });

  // remaining months based on paidCount (simple)
  const remainingMonths = Math.max(0, totalMonths - paidCount);
  const remaining = round2(remainingMonths * monthly);

  const progress = totalMonths > 0 ? round2((paidCount / totalMonths) * 100) : 0;

  // behindBy logic: expected paid by now based on current month
  // If plan starts 2026-03 and now is 2026-06 => expected paid = 4 months (Mar,Apr,May,Jun)
  let behindBy = 0;
  if (plan.startMonth && monthNow >= plan.startMonth) {
    const expectedPaidMonths =
      diffMonthsInclusive(plan.startMonth, monthNow, plan.endMonth);
    const expectedPaidAmount = round2(expectedPaidMonths * monthly);
    const actualPaidAmount = round2(paidCount * monthly);
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

function diffMonthsInclusive(start, now, end) {
  // clamp now between start and end
  let cur = now;
  if (cur < start) cur = start;
  if (cur > end) cur = end;

  const [sy, sm] = start.split("-").map(Number);
  const [cy, cm] = cur.split("-").map(Number);

  return (cy - sy) * 12 + (cm - sm) + 1;
}

// =====================
// Plans
// =====================

// list plans (+ stats)
router.get("/plans", requireAuth, requireFamily, async (req, res) => {
  const plans = await EMIPlan.find({ familyId: req.familyId }).sort({ createdAt: -1 });

  const withStats = [];
  for (const p of plans) {
    const stats = await computePlanStats(req.familyId, p);
    withStats.push({ ...p.toObject(), stats });
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
    totalPayable, // (ignored; server computes)
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
    return res
      .status(400)
      .json({ ok: false, message: "Invalid months. Allowed: 1,3,6,9,12,18,24,36" });
  }

  const op = Number(originalPrice);
  const pct = Number(emiCharge || 0);
  if (!Number.isFinite(op) || op <= 0) {
    return res.status(400).json({ ok: false, message: "Original price must be a positive number" });
  }
  if (!Number.isFinite(pct) || pct < 0) {
    return res.status(400).json({ ok: false, message: "EMI charge (%) must be a non-negative number" });
  }

  // emiCharge is percentage (e.g., 0.9 means 0.9%)
  const tp = round2(op + (op * pct) / 100);
  const monthlyAmount = round2(tp / m);

  const endMonth = addMonths(startMonth, m - 1);

  const plan = await EMIPlan.create({
    familyId: req.familyId,
    productName: productName.trim(),
    brand: (brand || "").trim(),
    category: (category || "").trim(),
    purchaseDate: new Date(purchaseDate),
    originalPrice: op,
    emiCharge: Number(emiCharge || 0),
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

  if (!plan) return res.status(404).json({ ok: false, message: "Plan not found" });
  res.json({ ok: true, plan });
});

// =====================
// Installments
// =====================

router.get("/installments", requireAuth, requireFamily, async (req, res) => {
  const month = String(req.query.month || "").trim();
  if (!month) return res.status(400).json({ ok: false, message: "month is required" });

  const items = await EMIInstallment.find({ familyId: req.familyId, month })
    .populate("planId", "productName")
    .sort({ createdAt: -1 });

  res.json({ ok: true, items });
});

// Generate EMI installments into EMIInstallment + LedgerEntry + Split
router.post("/generate", requireAuth, requireFamily, async (req, res) => {
  try {
    const { month, expenseCategoryId } = req.body || {};
    if (!month) return res.status(400).json({ ok: false, message: "month required" });

    // 1) Find category (by id OR by name EMI)
    let cat = null;

    if (expenseCategoryId) {
      cat = await Category.findOne({
        _id: expenseCategoryId,
        familyId: req.familyId,
        kind: "expense",
      });
    }

    // Fallback search by name even if expenseCategoryId was provided but not found
    if (!cat) {
      cat = await Category.findOne({
        familyId: req.familyId,
        kind: "expense",
        name: { $regex: /^\s*emi\s*$/i },
      });
    }

    if (!cat) {
      return res.status(400).json({
        ok: false,
        message:
          "EMI expense category not found. Please create an Expense category named 'EMI' in Settings.",
      });
    }

    // 2) Family members (SAFE: if none found, use current user)
    const members = await FamilyMember.find({ familyId: req.familyId });
    let userIds = members.map((m) => String(m.userId));

    if (userIds.length === 0) {
      userIds = [String(req.user.userId)];
    }

    const plans = await EMIPlan.find({ familyId: req.familyId, status: "active" });

    let createdCount = 0;

    for (const p of plans) {
      if (!monthInRange(month, p.startMonth, p.endMonth)) continue;

      // skip if already generated
      const exists = await EMIInstallment.findOne({
        familyId: req.familyId,
        planId: p._id,
        month,
      });
      if (exists) continue;

      const amount = Number(p.monthlyAmount);
      const dueDate = new Date(`${month}-01`);

      // split rows
      let splitRows = [];
      if (p.splitType === "equal") splitRows = splitEqual(amount, userIds);
      if (p.splitType === "personal") splitRows = splitPersonal(amount, p.personalUserId);
      if (p.splitType === "ratio") splitRows = splitRatio(amount, p.ratios);
      if (p.splitType === "fixed") splitRows = splitFixed(amount, p.fixed);

      // ledger entry
      const entry = await LedgerEntry.create({
        familyId: req.familyId,
        entryType: "expense",
        financialType: "debt",
        module: "emi",
        date: dueDate,
        month,
        categoryId: cat._id,
        amountTotal: amount,
        paidByUserId: null,
        note: `EMI: ${p.productName}`,
        createdByUserId: req.user.userId,
      });

      await Split.insertMany(
        splitRows.map((r) => ({
          familyId: req.familyId,
          ledgerEntryId: entry._id,
          userId: r.userId,
          shareAmount: r.shareAmount,
        }))
      );

      await EMIInstallment.create({
        familyId: req.familyId,
        planId: p._id,
        month,
        dueDate,
        amount,
        status: "pending",
        ledgerEntryId: entry._id,
      });

      createdCount++;
    }

    res.json({ ok: true, createdCount, usedCategory: { id: cat._id, name: cat.name } });
  } catch (err) {
    console.error("EMI generate error:", err);
    res.status(500).json({
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

  if (!inst) return res.status(404).json({ ok: false, message: "Installment not found" });

  const entry = await LedgerEntry.findOne({
    _id: inst.ledgerEntryId,
    familyId: req.familyId,
  });

  if (!entry) return res.status(404).json({ ok: false, message: "Linked ledger entry not found" });

  // ✅ PAID => create Transaction so Transactions page totals change
  if (status === "paid") {
    if (!inst.transactionId) {
      const tx = await Transaction.create({
        familyId: req.familyId,
        txType: "expense",
        date: entry.date,           // keeps within EMI month
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

    // Link LedgerEntry to Transaction (prevents rebuild duplicates)
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

  // ✅ PENDING => delete Transaction (money not moved), unlink ledger source
  if (status === "pending") {
    if (inst.transactionId) {
      await Transaction.deleteOne({ _id: inst.transactionId, familyId: req.familyId });
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

// delete installment (and linked ledger+splits)
router.delete("/installments/:id", requireAuth, requireFamily, async (req, res) => {
  const inst = await EMIInstallment.findOneAndDelete({
    _id: req.params.id,
    familyId: req.familyId,
  });

  if (!inst) return res.status(404).json({ ok: false, message: "Installment not found" });

  // delete linked Transaction (if any)
  if (inst.transactionId) {
    await Transaction.deleteOne({ _id: inst.transactionId, familyId: req.familyId });
  }

  // delete linked splits + ledger entry
  if (inst.ledgerEntryId) {
    await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: inst.ledgerEntryId });
    await LedgerEntry.deleteOne({ _id: inst.ledgerEntryId, familyId: req.familyId });
  }

  res.json({ ok: true });
});

export default router;