import mongoose from "mongoose";
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function monthKey(year, m) {
  return `${year}-${String(m).padStart(2, "0")}`;
}

function monthStartEnd(year, m) {
  const start = new Date(year, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, m, 1, 0, 0, 0, 0);
  return { start, end };
}

async function totalBalanceAtDate(familyObjectId, cutoffDate, openingSum, includedAccountIds) {
  const cutoff = new Date(cutoffDate);

  const inflowRows = await Transaction.aggregate([
    {
      $match: {
        familyId: familyObjectId,
        date: { $lt: cutoff },
        toAccountId: { $in: includedAccountIds },
        txType: { $in: ["income", "transfer"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  const outflowRows = await Transaction.aggregate([
    {
      $match: {
        familyId: familyObjectId,
        date: { $lt: cutoff },
        fromAccountId: { $in: includedAccountIds },
        txType: { $in: ["expense", "transfer"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  const inflow = Number(inflowRows?.[0]?.total || 0);
  const outflow = Number(outflowRows?.[0]?.total || 0);

  return round2(Number(openingSum || 0) + inflow - outflow);
}

function parseYear(y) {
  const n = Number(y);
  if (!Number.isFinite(n) || n < 2000 || n > 2100) return null;
  return n;
}

router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const year = parseYear(req.query.year) ?? new Date().getFullYear();

    const startMonth = `${year}-01`;
    const endMonth = `${year}-12`;

    const familyObjectId = new mongoose.Types.ObjectId(req.familyId);

    // ✅ NEW ENGINE: Aggregate Transactions by month & txType
    const txRows = await Transaction.aggregate([
      {
        $match: {
          familyId: familyObjectId,
          month: { $gte: startMonth, $lte: endMonth },
        },
      },
      {
        $group: {
          _id: { month: "$month", txType: "$txType" },
          total: { $sum: "$amount" },
        },
      },
    ]);

    const txMap = {};
    for (const r of txRows) {
      const m = r._id.month;
      const t = r._id.txType;
      if (!txMap[m]) txMap[m] = {};
      txMap[m][t] = Number(r.total || 0);
    }

    // Savings growth = transfers into savings - transfers out of savings
    const savingsAccounts = await Account.find({
      familyId: familyObjectId,
      type: "savings",
      isActive: true,
    })
      .select("_id")
      .lean();

    const cashAccounts = await Account.find({
      familyId: familyObjectId,
      isActive: true,
      type: { $ne: "savings" }, // ✅ exclude savings from Opening/Closing
    })
      .select("_id openingBalance")
      .lean();

    const cashAccountIds = cashAccounts.map((a) => a._id);

    const openingSum = cashAccounts.reduce((s, a) => s + Number(a.openingBalance || 0), 0);

    const savingsIds = savingsAccounts.map((x) => x._id);

    const savingsInRows = await Transaction.aggregate([
      {
        $match: {
          familyId: familyObjectId,
          month: { $gte: startMonth, $lte: endMonth },
          txType: "transfer",
          toAccountId: { $in: savingsIds },
        },
      },
      { $group: { _id: "$month", total: { $sum: "$amount" } } },
    ]);

    const savingsOutRows = await Transaction.aggregate([
      {
        $match: {
          familyId: familyObjectId,
          month: { $gte: startMonth, $lte: endMonth },
          txType: "transfer",
          fromAccountId: { $in: savingsIds },
        },
      },
      { $group: { _id: "$month", total: { $sum: "$amount" } } },
    ]);

    const savingsInMap = Object.create(null);
    const savingsOutMap = Object.create(null);
    for (const r of savingsInRows) savingsInMap[String(r._id)] = Number(r.total || 0);
    for (const r of savingsOutRows) savingsOutMap[String(r._id)] = Number(r.total || 0);

    const months = [];
    for (let i = 1; i <= 12; i++) {
      const m = monthKey(year, i);
      const { start, end } = monthStartEnd(year, i);
      const openingBalance = await totalBalanceAtDate(
        familyObjectId,
        start,
        openingSum,
        cashAccountIds
      );

      const closingBalance = await totalBalanceAtDate(
        familyObjectId,
        end,
        openingSum,
        cashAccountIds
      );

      const income = round2(txMap[m]?.income || 0);
      const expense = round2(txMap[m]?.expense || 0);
      const transfer = round2(txMap[m]?.transfer || 0);
      const netCashflow = round2(income - expense);

      const savingsIn = round2(savingsInMap[m] || 0);
      const savingsOut = round2(savingsOutMap[m] || 0);
      const savingsGrowth = round2(savingsIn - savingsOut);

      const savingsRate = income > 0 ? round2((savingsIn / income) * 100) : 0;

      months.push({
        month: m,
        income,
        expense,
        transfer,
        netCashflow,
        savingsIn,
        savingsOut,
        savingsGrowth,
        savingsRate,
        openingBalance,
        closingBalance,
      });
    }

    const totals = months.reduce(
      (acc, x) => {
        acc.income += x.income;
        acc.expense += x.expense;
        acc.transfer += x.transfer;
        acc.netCashflow += x.netCashflow;
        acc.savingsIn += x.savingsIn;
        acc.savingsOut += x.savingsOut;
        acc.savingsGrowth += x.savingsGrowth;
        return acc;
      },
      {
        income: 0,
        expense: 0,
        transfer: 0,
        netCashflow: 0,
        savingsIn: 0,
        savingsOut: 0,
        savingsGrowth: 0,
      }
    );

    for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
    totals.savingsRate = totals.income > 0 ? round2((totals.savingsIn / totals.income) * 100) : 0;

    res.json({ ok: true, year, months, totals });
  } catch (err) {
    console.error("YearOverview Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

export default router;