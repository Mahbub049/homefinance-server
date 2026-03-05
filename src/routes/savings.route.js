import { Router } from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";

const router = Router();

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

/* =========================================================
   Savings V2 (Account-based)

   Savings is NOT an expense.
   Savings deposit = Transfer transaction (Bank -> DPS)

   Endpoints used by client Savings page:
   - GET  /api/savings/accounts
   - GET  /api/savings/overview?month=YYYY-MM
   - POST /api/savings/deposit
========================================================= */

// List only savings/investment accounts
router.get("/accounts", requireAuth, requireFamily, async (req, res) => {
  const items = await Account.find({
    familyId: req.familyId,
    isActive: true,
    type: { $in: ["savings", "investment"] },
  }).sort({ name: 1 });

  res.json({ ok: true, items });
});

// Overview: balances + this-month in/out
router.get("/overview", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ ok: false, message: "month is required" });

  const monthEnd = endOfMonthDate(month);
  if (!monthEnd) return res.status(400).json({ ok: false, message: "Invalid month" });

  const savingsAccounts = await Account.find({
    familyId: req.familyId,
    isActive: true,
    type: { $in: ["savings", "investment"] },
  }).sort({ name: 1 });

  const ids = savingsAccounts.map((a) => a._id);
  if (ids.length === 0) {
    return res.json({
      ok: true,
      month,
      totals: { deposited: 0, withdrawn: 0, net: 0, totalBalance: 0 },
      accounts: [],
    });
  }

  const touchingMatch = {
    familyId: new mongoose.Types.ObjectId(req.familyId),
    txType: "transfer",
    date: { $lte: monthEnd },
    $or: [{ fromAccountId: { $in: ids } }, { toAccountId: { $in: ids } }],
  };

  const rows = await Transaction.aggregate([
    { $match: touchingMatch },
    {
      $project: {
        fromAccountId: 1,
        toAccountId: 1,
        amount: 1,
        month: 1,
        inAcc: { $cond: [{ $in: ["$toAccountId", ids] }, "$toAccountId", null] },
        outAcc: { $cond: [{ $in: ["$fromAccountId", ids] }, "$fromAccountId", null] },
      },
    },
    {
      $facet: {
        balance: [
          {
            $project: {
              pairs: [
                { acc: "$inAcc", amt: "$amount" },
                { acc: "$outAcc", amt: { $multiply: ["$amount", -1] } },
              ],
            },
          },
          { $unwind: "$pairs" },
          { $match: { "pairs.acc": { $ne: null } } },
          { $group: { _id: "$pairs.acc", net: { $sum: "$pairs.amt" } } },
        ],
        monthTotals: [
          { $match: { month } },
          {
            $project: {
              toSavings: { $cond: [{ $in: ["$toAccountId", ids] }, true, false] },
              fromSavings: { $cond: [{ $in: ["$fromAccountId", ids] }, true, false] },
              amount: 1,
            },
          },
          {
            $group: {
              _id: null,
              deposited: { $sum: { $cond: ["$toSavings", "$amount", 0] } },
              withdrawn: { $sum: { $cond: ["$fromSavings", "$amount", 0] } },
            },
          },
        ],
        monthByAccount: [
          { $match: { month } },
          {
            $project: {
              pairs: [
                {
                  acc: { $cond: [{ $in: ["$toAccountId", ids] }, "$toAccountId", null] },
                  dep: "$amount",
                  wdr: 0,
                },
                {
                  acc: { $cond: [{ $in: ["$fromAccountId", ids] }, "$fromAccountId", null] },
                  dep: 0,
                  wdr: "$amount",
                },
              ],
            },
          },
          { $unwind: "$pairs" },
          { $match: { "pairs.acc": { $ne: null } } },
          {
            $group: {
              _id: "$pairs.acc",
              deposited: { $sum: "$pairs.dep" },
              withdrawn: { $sum: "$pairs.wdr" },
            },
          },
        ],
      },
    },
  ]);

  const balanceMap = new Map();
  for (const r of rows?.[0]?.balance || []) balanceMap.set(String(r._id), r.net);

  const monthMap = new Map();
  for (const r of rows?.[0]?.monthByAccount || []) {
    monthMap.set(String(r._id), { deposited: r.deposited || 0, withdrawn: r.withdrawn || 0 });
  }

  const mt = (rows?.[0]?.monthTotals || [])[0] || { deposited: 0, withdrawn: 0 };
  const totals = {
    deposited: mt.deposited || 0,
    withdrawn: mt.withdrawn || 0,
    net: (mt.deposited || 0) - (mt.withdrawn || 0),
    totalBalance: 0,
  };

  const accounts = savingsAccounts.map((a) => {
    const netTransfers = balanceMap.get(String(a._id)) || 0;
    const currentBalance = Number(a.openingBalance || 0) + Number(netTransfers || 0);
    totals.totalBalance += currentBalance;

    const ms = monthMap.get(String(a._id)) || { deposited: 0, withdrawn: 0 };

    return {
      _id: a._id,
      name: a.name,
      type: a.type,
      owner: a.owner,
      openingBalance: a.openingBalance || 0,
      currentBalance,
      monthDeposited: ms.deposited,
      monthWithdrawn: ms.withdrawn,
    };
  });

  res.json({ ok: true, month, totals, accounts });
});

// Manual deposit/withdraw as a transfer (From -> To)
router.post("/deposit", requireAuth, requireFamily, async (req, res) => {
  try {
    const { date, fromAccountId, toAccountId, amount, note } = req.body || {};

    const d = new Date(date || Date.now());
    if (Number.isNaN(d.getTime()))
      return res.status(400).json({ ok: false, message: "Invalid date" });

    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    const amt = Number(amount);
    if (!amt || amt <= 0)
      return res.status(400).json({ ok: false, message: "Amount must be > 0" });

    if (!fromAccountId || !toAccountId)
      return res.status(400).json({ ok: false, message: "From & To accounts required" });

    if (String(fromAccountId) === String(toAccountId))
      return res
        .status(400)
        .json({ ok: false, message: "From and To accounts must be different" });

    const [fromAcc, toAcc] = await Promise.all([
      Account.findOne({ _id: fromAccountId, familyId: req.familyId }),
      Account.findOne({ _id: toAccountId, familyId: req.familyId }),
    ]);

    if (!fromAcc || !toAcc)
      return res.status(400).json({ ok: false, message: "Invalid account selection" });

    const item = await Transaction.create({
      familyId: req.familyId,
      txType: "transfer",
      date: d,
      month,
      categoryId: null,
      amount: amt,
      note: String(note || "").trim(),
      fromAccountId,
      toAccountId,
      paidByUserId: null,
      receivedByUserId: null,
      // requireAuth sets req.user = { userId }
      createdByUserId: req.user.userId,
    });

    res.status(201).json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Deposit failed" });
  }
});

export default router;
