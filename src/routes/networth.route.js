import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import LedgerEntry from "../models/LedgerEntry.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import EMIPlan from "../models/EMIPlan.js";
import EMIInstallment from "../models/EMIInstallment.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function currentYYYYMM() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function sumAmount(arr, field) {
  return round2((arr || []).reduce((sum, x) => sum + Number(x?.[field] || 0), 0));
}

function parseMonth(month) {
  const [y, m] = String(month || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return { y, m };
}

function endOfMonthDate(month) {
  const p = parseMonth(month);
  if (!p) return null;
  return new Date(p.y, p.m, 0, 23, 59, 59, 999);
}

async function computeSavingsAssetV2(familyId, asOfMonth) {
  const monthEnd = endOfMonthDate(asOfMonth);
  if (!monthEnd) return 0;

  const savingsAccounts = await Account.find({
    familyId,
    isActive: true,
    type: { $in: ["savings", "investment"] },
  }).select("_id openingBalance");

  const ids = savingsAccounts.map((a) => a._id);
  if (ids.length === 0) return 0;

  const rows = await Transaction.aggregate([
    {
      $match: {
        familyId: new mongoose.Types.ObjectId(familyId),
        txType: "transfer",
        date: { $lte: monthEnd },
        $or: [{ fromAccountId: { $in: ids } }, { toAccountId: { $in: ids } }],
      },
    },
    {
      $project: {
        pairs: [
          { acc: { $cond: [{ $in: ["$toAccountId", ids] }, "$toAccountId", null] }, amt: "$amount" },
          {
            acc: { $cond: [{ $in: ["$fromAccountId", ids] }, "$fromAccountId", null] },
            amt: { $multiply: ["$amount", -1] },
          },
        ],
      },
    },
    { $unwind: "$pairs" },
    { $match: { "pairs.acc": { $ne: null } } },
    { $group: { _id: null, net: { $sum: "$pairs.amt" } } },
  ]);

  const openingSum = round2(
    savingsAccounts.reduce((sum, a) => sum + Number(a.openingBalance || 0), 0)
  );
  const netTransfers = round2(rows?.[0]?.net || 0);
  return round2(openingSum + netTransfers);
}

// GET /api/networth?asOfMonth=YYYY-MM&manualSavings=12345
// Net Worth = (Ledger Investment + Savings Asset + Manual Savings) - Remaining EMI
router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const asOfMonth =
      (req.query.asOfMonth || req.query.month || "").trim() || currentYYYYMM();
    const manualSavings = round2(Number(req.query.manualSavings || 0));

    // ================================
    // Assets
    // ================================
    // Ledger investments (all time, up to asOfMonth)
    const ledgerInvestmentEntries = await LedgerEntry.find({
      familyId: req.familyId,
      financialType: "investment",
      month: { $lte: asOfMonth },
    }).select("amountTotal");

    const ledgerInvestment = sumAmount(ledgerInvestmentEntries, "amountTotal");

    // Savings asset (V2, account-based transfers, up to asOfMonth)
    const totalSavingsAsset = await computeSavingsAssetV2(req.familyId, asOfMonth);

    const totalAsset = round2(ledgerInvestment + totalSavingsAsset + manualSavings);

    // ================================
    // Liabilities
    // ================================
    // Remaining EMI liability = sum( totalPayable - paidCount * monthlyAmount ) for active plans
    const plans = await EMIPlan.find({ familyId: req.familyId, status: "active" }).select(
      "totalPayable monthlyAmount"
    );

    let remainingEMI = 0;
    let totalPayableActive = 0;
    let totalPaidActive = 0;

    for (const p of plans) {
      totalPayableActive += Number(p.totalPayable || 0);

      const paidCount = await EMIInstallment.countDocuments({
        familyId: req.familyId,
        planId: p._id,
        status: "paid",
      });

      const paid = Number(p.monthlyAmount || 0) * paidCount;
      totalPaidActive += paid;

      const rem = Math.max(0, Number(p.totalPayable || 0) - paid);
      remainingEMI += rem;
    }

    remainingEMI = round2(remainingEMI);
    totalPayableActive = round2(totalPayableActive);
    totalPaidActive = round2(totalPaidActive);

    // ================================
    // Net Worth
    // ================================
    const netWorth = round2(totalAsset - remainingEMI);

    res.json({
      ok: true,
      data: {
        asOfMonth,
        assets: {
          ledgerInvestment,
          totalSavingsAsset,
          manualSavings,
          totalAsset,
        },
        liabilities: {
          remainingEMI,
          totalPayableActive,
          totalPaidActive,
        },
        netWorth,
      },
    });
  } catch (err) {
    console.error("Net Worth Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

export default router;