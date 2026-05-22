import { Router } from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import FamilyMember from "../models/FamilyMember.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import User from "../models/User.js";

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

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month, amount) {
  const p = parseMonth(month);
  if (!p) return null;

  const d = new Date(p.y, p.m - 1 + amount, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function lastMonths(endMonth, count = 12) {
  const validEnd = parseMonth(endMonth) ? endMonth : currentMonth();
  const start = addMonths(validEnd, -(count - 1));
  const months = [];

  for (let i = 0; i < count; i++) {
    months.push(addMonths(start, i));
  }

  return months.filter(Boolean);
}

function ownerFromMemberName(name) {
  const n = String(name || "").trim().toLowerCase();

  if (n.includes("mahbub")) return "Mahbub";
  if (n.includes("mirza")) return "Mirza";

  return "";
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/* =========================================================
   Savings V2

   Savings is NOT an expense.
   Savings deposit = Transfer transaction.
   Example: EBL Account -> TBL DPS Account

   Endpoints:
   GET  /api/savings/accounts
   GET  /api/savings/overview?month=YYYY-MM
   GET  /api/savings/yearly-summary?endMonth=YYYY-MM
   POST /api/savings/deposit
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

// Overview: savings account balances + this-month in/out
router.get("/overview", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;

  if (!month) {
    return res.status(400).json({
      ok: false,
      message: "month is required",
    });
  }

  const monthEnd = endOfMonthDate(month);

  if (!monthEnd) {
    return res.status(400).json({
      ok: false,
      message: "Invalid month",
    });
  }

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
      totals: {
        deposited: 0,
        withdrawn: 0,
        net: 0,
        totalBalance: 0,
      },
      accounts: [],
    });
  }

  const touchingMatch = {
    familyId: new mongoose.Types.ObjectId(req.familyId),
    txType: "transfer",
    date: { $lte: monthEnd },
    $or: [
      { fromAccountId: { $in: ids } },
      { toAccountId: { $in: ids } },
    ],
  };

  const rows = await Transaction.aggregate([
    { $match: touchingMatch },
    {
      $project: {
        fromAccountId: 1,
        toAccountId: 1,
        amount: 1,
        month: 1,
        inAcc: {
          $cond: [{ $in: ["$toAccountId", ids] }, "$toAccountId", null],
        },
        outAcc: {
          $cond: [{ $in: ["$fromAccountId", ids] }, "$fromAccountId", null],
        },
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
          {
            $group: {
              _id: "$pairs.acc",
              net: { $sum: "$pairs.amt" },
            },
          },
        ],

        monthTotals: [
          { $match: { month } },
          {
            $project: {
              toSavings: {
                $cond: [{ $in: ["$toAccountId", ids] }, true, false],
              },
              fromSavings: {
                $cond: [{ $in: ["$fromAccountId", ids] }, true, false],
              },
              amount: 1,
            },
          },
          {
            $group: {
              _id: null,
              deposited: {
                $sum: { $cond: ["$toSavings", "$amount", 0] },
              },
              withdrawn: {
                $sum: { $cond: ["$fromSavings", "$amount", 0] },
              },
            },
          },
        ],

        monthByAccount: [
          { $match: { month } },
          {
            $project: {
              pairs: [
                {
                  acc: {
                    $cond: [{ $in: ["$toAccountId", ids] }, "$toAccountId", null],
                  },
                  dep: "$amount",
                  wdr: 0,
                },
                {
                  acc: {
                    $cond: [{ $in: ["$fromAccountId", ids] }, "$fromAccountId", null],
                  },
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

  for (const r of rows?.[0]?.balance || []) {
    balanceMap.set(String(r._id), r.net);
  }

  const monthMap = new Map();

  for (const r of rows?.[0]?.monthByAccount || []) {
    monthMap.set(String(r._id), {
      deposited: r.deposited || 0,
      withdrawn: r.withdrawn || 0,
    });
  }

  const mt = rows?.[0]?.monthTotals?.[0] || {
    deposited: 0,
    withdrawn: 0,
  };

  const totals = {
    deposited: mt.deposited || 0,
    withdrawn: mt.withdrawn || 0,
    net: (mt.deposited || 0) - (mt.withdrawn || 0),
    totalBalance: 0,
  };

  const accounts = savingsAccounts.map((a) => {
    const netTransfers = balanceMap.get(String(a._id)) || 0;
    const currentBalance =
      Number(a.openingBalance || 0) + Number(netTransfers || 0);

    totals.totalBalance += currentBalance;

    const ms = monthMap.get(String(a._id)) || {
      deposited: 0,
      withdrawn: 0,
    };

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

  res.json({
    ok: true,
    month,
    totals,
    accounts,
  });
});

router.get("/yearly-summary", requireAuth, requireFamily, async (req, res) => {
  try {
    const endMonth = String(req.query.endMonth || currentMonth()).trim();
    const months = lastMonths(endMonth, 12);

    if (!months.length) {
      return res.status(400).json({
        ok: false,
        message: "Invalid month range",
      });
    }

    const allAccounts = await Account.find({
      familyId: req.familyId,
      isActive: true,
    })
      .select("_id name owner type")
      .lean();

    const ownerNames = Array.from(
      new Set(
        allAccounts
          .map((account) => String(account.owner || "").trim())
          .filter((owner) => owner && owner.toLowerCase() !== "joint")
      )
    );

    const output = new Map();

    for (const owner of ownerNames) {
      output.set(owner, {
        id: `owner:${owner}`,
        name: owner,
        owner,
        totalCashSaved: 0,
        totalSaved: 0,
        months: months.map((month) => ({
          month,
          income: 0,
          expense: 0,
          transferIn: 0,
          transferOut: 0,
          transferNet: 0,
          monthlySaved: 0,
          cumulativeSaved: 0,

          // old aliases so frontend will not break
          saved: 0,
          withdrawn: 0,
          netSaved: 0,
          totalBeforeSaving: 0,
          remainingAfterSavings: 0,
        })),
      });
    }

    const monthIndex = new Map(months.map((month, index) => [month, index]));

    function getRealOwner(owner) {
      const clean = String(owner || "").trim();
      if (!clean) return "";
      if (clean.toLowerCase() === "joint") return "Joint";

      const matched = ownerNames.find(
        (item) => item.toLowerCase() === clean.toLowerCase()
      );

      return matched || clean;
    }

    function ownerParts(owner) {
      const realOwner = getRealOwner(owner);

      if (!realOwner) return [];

      if (realOwner === "Joint") {
        if (ownerNames.length === 0) return [];
        const ratio = 1 / ownerNames.length;
        return ownerNames.map((name) => ({
          owner: name,
          ratio,
        }));
      }

      if (!output.has(realOwner)) return [];

      return [{ owner: realOwner, ratio: 1 }];
    }

    function addOwnerAmount(owner, month, field, amount, ratio = 1) {
      const realOwner = getRealOwner(owner);
      const member = output.get(realOwner);
      const index = monthIndex.get(month);

      if (!member || index === undefined) return;

      member.months[index][field] += Number(amount || 0) * Number(ratio || 1);
    }

    function addUserAmount(userId, month, field, amount) {
      const userIdText = String(userId || "");

      if (!userIdText) return;

      const matchedOwner = ownerNames.find((owner) =>
        userIdText.toLowerCase().includes(owner.toLowerCase())
      );

      if (matchedOwner) {
        addOwnerAmount(matchedOwner, month, field, amount);
      }
    }

    const familyMembers = await FamilyMember.find({
      familyId: req.familyId,
    })
      .populate("userId", "name email")
      .lean();

    const userIdToOwner = new Map();

    for (const member of familyMembers || []) {
      const user = member.userId || {};
      const userId = String(user._id || member.userId || "");
      const name = String(user.name || "").toLowerCase();

      const matchedOwner = ownerNames.find((owner) =>
        name.includes(owner.toLowerCase())
      );

      if (userId && matchedOwner) {
        userIdToOwner.set(userId, matchedOwner);
      }
    }

    function addByUserId(userId, month, field, amount) {
      const owner = userIdToOwner.get(String(userId || ""));
      if (!owner) return;

      addOwnerAmount(owner, month, field, amount);
    }

    const ledgerEntries = await LedgerEntry.find({
      familyId: req.familyId,
      month: { $in: months },
      entryType: { $in: ["income", "expense"] },
    })
      .select("_id month entryType amountTotal paidByUserId receivedByUserId")
      .lean();

    const ledgerIds = ledgerEntries.map((entry) => entry._id);

    const splitRows = ledgerIds.length
      ? await Split.find({
        familyId: req.familyId,
        ledgerEntryId: { $in: ledgerIds },
      })
        .select("ledgerEntryId userId shareAmount")
        .lean()
      : [];

    const splitMap = new Map();

    for (const row of splitRows) {
      const key = String(row.ledgerEntryId);

      if (!splitMap.has(key)) {
        splitMap.set(key, []);
      }

      splitMap.get(key).push(row);
    }

    for (const entry of ledgerEntries) {
      const splits = splitMap.get(String(entry._id)) || [];
      const field = entry.entryType === "income" ? "income" : "expense";

      if (splits.length > 0) {
        for (const split of splits) {
          addByUserId(split.userId, entry.month, field, split.shareAmount);
        }
      } else {
        const fallbackUserId =
          entry.entryType === "income"
            ? entry.receivedByUserId
            : entry.paidByUserId;

        addByUserId(fallbackUserId, entry.month, field, entry.amountTotal);
      }
    }

    const accountMap = new Map(
      allAccounts.map((account) => [String(account._id), account])
    );

    const transfers = await Transaction.find({
      familyId: req.familyId,
      txType: "transfer",
      month: { $in: months },
    })
      .select("month amount fromAccountId toAccountId")
      .lean();

    for (const tx of transfers) {
      const amount = Number(tx.amount || 0);

      const fromAccount = accountMap.get(String(tx.fromAccountId));
      const toAccount = accountMap.get(String(tx.toAccountId));

      const fromOwner = getRealOwner(fromAccount?.owner);
      const toOwner = getRealOwner(toAccount?.owner);

      if (!fromOwner || !toOwner || fromOwner === toOwner) {
        continue;
      }

      for (const part of ownerParts(fromOwner)) {
        addOwnerAmount(
          part.owner,
          tx.month,
          "transferOut",
          amount,
          part.ratio
        );
      }

      for (const part of ownerParts(toOwner)) {
        addOwnerAmount(
          part.owner,
          tx.month,
          "transferIn",
          amount,
          part.ratio
        );
      }
    }

    const members = Array.from(output.values()).map((member) => {
      let cumulativeSaved = 0;

      member.months = member.months.map((item) => {
        const transferNet =
          Number(item.transferIn || 0) - Number(item.transferOut || 0);

        const monthlySaved =
          Number(item.income || 0) -
          Number(item.expense || 0) +
          transferNet;

        cumulativeSaved += monthlySaved;

        return {
          ...item,
          income: round2(item.income),
          expense: round2(item.expense),
          transferIn: round2(item.transferIn),
          transferOut: round2(item.transferOut),
          transferNet: round2(transferNet),
          monthlySaved: round2(monthlySaved),
          cumulativeSaved: round2(cumulativeSaved),

          // compatibility aliases
          saved: round2(monthlySaved),
          withdrawn: monthlySaved < 0 ? round2(Math.abs(monthlySaved)) : 0,
          netSaved: round2(monthlySaved),
          totalBeforeSaving: round2(Number(item.income || 0) + transferNet),
          remainingAfterSavings: round2(cumulativeSaved),
        };
      });

      member.totalCashSaved = round2(cumulativeSaved);
      member.totalSaved = round2(cumulativeSaved);

      return member;
    });

    res.json({
      ok: true,
      endMonth: months[months.length - 1],
      startMonth: months[0],
      months,
      members,
    });
  } catch (e) {
    console.error("Savings yearly summary error:", e);

    res.status(500).json({
      ok: false,
      message: e?.message || "Savings yearly summary failed",
    });
  }
});

// Manual deposit as a transfer
router.post("/deposit", requireAuth, requireFamily, async (req, res) => {
  try {
    const {
      paidByUserId,
      date,
      fromAccountId,
      toAccountId,
      amount,
      note,
    } = req.body || {};

    const d = new Date(date || Date.now());

    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({
        ok: false,
        message: "Invalid date",
      });
    }

    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}`;

    const amt = Number(amount);

    if (!amt || amt <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Amount must be > 0",
      });
    }

    if (!fromAccountId || !toAccountId) {
      return res.status(400).json({
        ok: false,
        message: "From & To accounts required",
      });
    }

    if (String(fromAccountId) === String(toAccountId)) {
      return res.status(400).json({
        ok: false,
        message: "From and To accounts must be different",
      });
    }

    const [fromAcc, toAcc] = await Promise.all([
      Account.findOne({
        _id: fromAccountId,
        familyId: req.familyId,
        isActive: true,
      }),
      Account.findOne({
        _id: toAccountId,
        familyId: req.familyId,
        isActive: true,
      }),
    ]);

    if (!fromAcc || !toAcc) {
      return res.status(400).json({
        ok: false,
        message: "Invalid account selection",
      });
    }

    if (!["cash", "bank", "wallet"].includes(fromAcc.type)) {
      return res.status(400).json({
        ok: false,
        message: "From account must be a cash, bank, or wallet account",
      });
    }

    if (!["savings", "investment"].includes(toAcc.type)) {
      return res.status(400).json({
        ok: false,
        message: "To account must be a savings or investment account",
      });
    }

    if (paidByUserId) {
      const payerMember = await FamilyMember.findOne({
        familyId: req.familyId,
        userId: paidByUserId,
      }).populate("userId", "name");

      if (!payerMember) {
        return res.status(400).json({
          ok: false,
          message: "Selected user is not a valid family member",
        });
      }

      const payerOwner = ownerFromMemberName(payerMember?.userId?.name);

      if (
        payerOwner &&
        (fromAcc.owner !== payerOwner || toAcc.owner !== payerOwner)
      ) {
        return res.status(400).json({
          ok: false,
          message: "Selected accounts must belong to the selected user",
        });
      }
    }

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
      paidByUserId: paidByUserId || null,
      receivedByUserId: null,
      createdByUserId: req.user.userId,
    });

    res.status(201).json({
      ok: true,
      item,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e?.message || "Deposit failed",
    });
  }
});

export default router;