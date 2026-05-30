import mongoose from "mongoose";
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import MonthlyBalance from "../models/MonthlyBalance.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function parseMonth(yyyyMM) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(yyyyMM || "").trim());
  if (!m) return null;

  const y = Number(m[1]);
  const mm = Number(m[2]);
  if (!y || mm < 1 || mm > 12) return null;

  return { y, mm };
}

function monthBounds(yyyyMM) {
  const parsed = parseMonth(yyyyMM);
  if (!parsed) return null;

  const start = new Date(parsed.y, parsed.mm - 1, 1, 0, 0, 0, 0);
  const end = new Date(parsed.y, parsed.mm, 1, 0, 0, 0, 0);
  const days = new Date(parsed.y, parsed.mm, 0).getDate();

  return { start, end, days };
}

function cleanId(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || value.id || value);
  return String(value);
}

function moduleInfo(entry = {}) {
  const module = String(entry.module || "manual").toLowerCase();
  const financialType = String(entry.financialType || "living").toLowerCase();

  if (module === "fixed") {
    return { key: "fixed", label: "Fixed Expenses", tone: "amber" };
  }

  if (module === "grocery") {
    return { key: "grocery", label: "Grocery", tone: "emerald" };
  }

  if (module === "emi" || financialType === "debt") {
    return { key: "emi", label: "EMI / Debt", tone: "violet" };
  }

  if (financialType === "investment") {
    return { key: "investment", label: "Investment", tone: "sky" };
  }

  return { key: "remaining", label: "Remaining Expenses", tone: "rose" };
}

function accountBelongsToUser(accountOwner, userName) {
  const owner = String(accountOwner || "").trim().toLowerCase();
  const name = String(userName || "").trim().toLowerCase();

  if (!owner || owner === "joint") return false;
  return name.includes(owner);
}

function buildEmptyUser(user, daysInMonth) {
  const byTypeTemplate = [
    { key: "fixed", label: "Fixed Expenses", amount: 0, count: 0, tone: "amber" },
    { key: "grocery", label: "Grocery", amount: 0, count: 0, tone: "emerald" },
    { key: "emi", label: "EMI / Debt", amount: 0, count: 0, tone: "violet" },
    { key: "remaining", label: "Remaining Expenses", amount: 0, count: 0, tone: "rose" },
    { key: "investment", label: "Investment", amount: 0, count: 0, tone: "sky" },
  ];

  return {
    userId: String(user._id),
    name: user.name || "Member",
    email: user.email || "",
    summary: {
      income: 0,
      spent: 0,
      paid: 0,
      netRemaining: 0,
      cashRemaining: 0,
      accountBalance: 0,
      savingsBalance: 0,
      transferIn: 0,
      transferOut: 0,
      transferNet: 0,
      settlementPosition: 0,
      expenseCount: 0,
      averageDailySpend: 0,
      largestExpense: 0,
    },
    expenseTypes: byTypeTemplate,
    categoryBreakdown: [],
    dailyTrend: Array.from({ length: daysInMonth }, (_, idx) => ({
      day: String(idx + 1).padStart(2, "0"),
      amount: 0,
    })),
    topExpenses: [],
    accountBalances: [],
    insights: [],
  };
}

async function computeAccountsAtMonthEnd(familyId, month) {
  const bounds = monthBounds(month);
  if (!bounds) return [];

  const familyObjectId = new mongoose.Types.ObjectId(familyId);
  const accounts = await Account.find({ familyId: familyObjectId, isActive: true })
    .select("name type owner openingBalance")
    .sort({ owner: 1, name: 1 })
    .lean();

  const inflows = await Transaction.aggregate([
    {
      $match: {
        familyId: familyObjectId,
        date: { $lt: bounds.end },
        toAccountId: { $ne: null },
        txType: { $in: ["income", "transfer"] },
      },
    },
    { $group: { _id: "$toAccountId", total: { $sum: "$amount" } } },
  ]);

  const outflows = await Transaction.aggregate([
    {
      $match: {
        familyId: familyObjectId,
        date: { $lt: bounds.end },
        fromAccountId: { $ne: null },
        txType: { $in: ["expense", "transfer"] },
      },
    },
    { $group: { _id: "$fromAccountId", total: { $sum: "$amount" } } },
  ]);

  const inMap = Object.create(null);
  const outMap = Object.create(null);

  for (const row of inflows) inMap[String(row._id)] = Number(row.total || 0);
  for (const row of outflows) outMap[String(row._id)] = Number(row.total || 0);

  return accounts.map((account) => {
    const id = String(account._id);
    const balance = Number(account.openingBalance || 0) + Number(inMap[id] || 0) - Number(outMap[id] || 0);

    return {
      accountId: id,
      name: account.name,
      type: account.type,
      owner: account.owner,
      balance: round2(balance),
    };
  });
}

async function loadClosingAccounts(familyId, month) {
  const familyObjectId = new mongoose.Types.ObjectId(familyId);
  const closed = await MonthlyBalance.findOne({
    familyId: familyObjectId,
    month,
    closingBalance: { $ne: null },
  }).lean();

  if (closed?.accountsClosing?.length) {
    return {
      source: "closed_month",
      accounts: closed.accountsClosing.map((row) => ({
        accountId: String(row.accountId),
        name: row.name || "Account",
        type: row.type || "bank",
        owner: row.owner || "Joint",
        balance: round2(row.balance || 0),
      })),
    };
  }

  return {
    source: "system_calculated",
    accounts: await computeAccountsAtMonthEnd(familyId, month),
  };
}

router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();
    const bounds = monthBounds(month);

    if (!bounds) {
      return res.status(400).json({ ok: false, message: "Valid month (YYYY-MM) required" });
    }

    const familyObjectId = new mongoose.Types.ObjectId(req.familyId);

    const members = await FamilyMember.find({ familyId: familyObjectId })
      .populate("userId", "name email")
      .lean();

    const users = members.map((member) => member.userId).filter(Boolean);
    const userMap = new Map(users.map((u) => [String(u._id), buildEmptyUser(u, bounds.days)]));

    const entries = await LedgerEntry.find({ familyId: familyObjectId, month })
      .populate("categoryId", "name kind financialType")
      .populate("paidByUserId", "name email")
      .populate("receivedByUserId", "name email")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    const entryIds = entries.map((entry) => entry._id);
    const splits = entryIds.length
      ? await Split.find({ familyId: familyObjectId, ledgerEntryId: { $in: entryIds } }).lean()
      : [];

    const splitsByEntry = Object.create(null);
    for (const split of splits) {
      const key = String(split.ledgerEntryId);
      if (!splitsByEntry[key]) splitsByEntry[key] = [];
      splitsByEntry[key].push(split);
    }

    const categoryMaps = new Map();
    const typeMaps = new Map();

    for (const user of users) {
      categoryMaps.set(String(user._id), new Map());
      typeMaps.set(String(user._id), new Map());
    }

    let familyIncome = 0;
    let familySpent = 0;
    let familyPaid = 0;

    for (const entry of entries) {
      const entrySplits = splitsByEntry[String(entry._id)] || [];
      const amount = Number(entry.amountTotal || 0);
      const dayNumber = new Date(entry.date).getDate();
      const dayIndex = Number.isFinite(dayNumber) ? dayNumber - 1 : -1;

      if (entry.entryType === "income") {
        familyIncome += amount;

        for (const split of entrySplits) {
          const userId = String(split.userId);
          const state = userMap.get(userId);
          if (!state) continue;

          state.summary.income += Number(split.shareAmount || 0);
        }

        continue;
      }

      if (entry.entryType !== "expense") continue;

      familySpent += amount;

      const paidByUserId = cleanId(entry.paidByUserId);
      const type = moduleInfo(entry);
      const categoryName = entry.categoryId?.name || type.label || "Expense";

      if (paidByUserId && userMap.has(paidByUserId)) {
        const paidState = userMap.get(paidByUserId);
        paidState.summary.paid += amount;
        familyPaid += amount;

        // Top expenses must be based on who actually PAID the money,
        // not on who was responsible for the split/share.
        paidState.topExpenses.push({
          entryId: String(entry._id),
          date: entry.date,
          category: categoryName,
          module: entry.module || "manual",
          typeLabel: type.label,
          note: entry.note || "",
          paidBy: entry.paidByUserId?.name || "Unknown",
          paidAmount: round2(amount),
          totalAmount: round2(amount),
        });
      }

      for (const split of entrySplits) {
        const userId = String(split.userId);
        const state = userMap.get(userId);
        if (!state) continue;

        const shareAmount = Number(split.shareAmount || 0);
        if (shareAmount <= 0) continue;

        state.summary.spent += shareAmount;
        state.summary.expenseCount += 1;
        state.summary.largestExpense = Math.max(state.summary.largestExpense, shareAmount);

        if (dayIndex >= 0 && state.dailyTrend[dayIndex]) {
          state.dailyTrend[dayIndex].amount += shareAmount;
        }

        const categoryMap = categoryMaps.get(userId);
        const existingCat = categoryMap.get(categoryName) || { name: categoryName, amount: 0, count: 0 };
        existingCat.amount += shareAmount;
        existingCat.count += 1;
        categoryMap.set(categoryName, existingCat);

        const typeMap = typeMaps.get(userId);
        const existingType = typeMap.get(type.key) || { ...type, amount: 0, count: 0 };
        existingType.amount += shareAmount;
        existingType.count += 1;
        typeMap.set(type.key, existingType);

      }
    }

    const accountsSnapshot = await loadClosingAccounts(req.familyId, month);
    const accountsById = new Map(accountsSnapshot.accounts.map((account) => [String(account.accountId), account]));

    for (const account of accountsSnapshot.accounts) {
      if (String(account.owner || "").toLowerCase() === "joint") continue;

      for (const user of users) {
        if (!accountBelongsToUser(account.owner, user.name)) continue;

        const state = userMap.get(String(user._id));
        if (!state) continue;

        const row = {
          accountId: String(account.accountId),
          name: account.name,
          type: account.type,
          owner: account.owner,
          balance: round2(account.balance),
        };

        state.accountBalances.push(row);
        state.summary.accountBalance += Number(row.balance || 0);

        if (["cash", "bank", "wallet"].includes(String(row.type || "").toLowerCase())) {
          state.summary.cashRemaining += Number(row.balance || 0);
        }

        if (["savings", "investment"].includes(String(row.type || "").toLowerCase())) {
          state.summary.savingsBalance += Number(row.balance || 0);
        }
      }
    }

    const transfers = await Transaction.find({
      familyId: familyObjectId,
      month,
      txType: "transfer",
    })
      .select("amount fromAccountId toAccountId")
      .lean();

    for (const transfer of transfers) {
      const amount = Number(transfer.amount || 0);
      const fromAccount = accountsById.get(String(transfer.fromAccountId));
      const toAccount = accountsById.get(String(transfer.toAccountId));

      for (const user of users) {
        const state = userMap.get(String(user._id));
        if (!state) continue;

        if (fromAccount && accountBelongsToUser(fromAccount.owner, user.name)) {
          state.summary.transferOut += amount;
        }

        if (toAccount && accountBelongsToUser(toAccount.owner, user.name)) {
          state.summary.transferIn += amount;
        }
      }
    }

    const outputUsers = Array.from(userMap.values()).map((state) => {
      const userId = state.userId;

      const typeMap = typeMaps.get(userId) || new Map();
      state.expenseTypes = state.expenseTypes.map((template) => {
        const item = typeMap.get(template.key) || template;
        return {
          ...template,
          amount: round2(item.amount || 0),
          count: Number(item.count || 0),
        };
      });

      const categoryMap = categoryMaps.get(userId) || new Map();
      state.categoryBreakdown = Array.from(categoryMap.values())
        .map((row) => ({ ...row, amount: round2(row.amount), count: Number(row.count || 0) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);

      state.dailyTrend = state.dailyTrend.map((row) => ({ ...row, amount: round2(row.amount) }));
      state.topExpenses = state.topExpenses
        .sort((a, b) => Number(b.paidAmount || b.totalAmount || 0) - Number(a.paidAmount || a.totalAmount || 0))
        .slice(0, 10);

      state.summary.income = round2(state.summary.income);
      state.summary.spent = round2(state.summary.spent);
      state.summary.paid = round2(state.summary.paid);
      state.summary.netRemaining = round2(state.summary.income - state.summary.spent);
      state.summary.cashRemaining = round2(state.summary.cashRemaining);
      state.summary.accountBalance = round2(state.summary.accountBalance);
      state.summary.savingsBalance = round2(state.summary.savingsBalance);
      state.summary.transferIn = round2(state.summary.transferIn);
      state.summary.transferOut = round2(state.summary.transferOut);
      state.summary.transferNet = round2(state.summary.transferIn - state.summary.transferOut);
      state.summary.settlementPosition = round2(state.summary.paid - state.summary.spent);
      state.summary.averageDailySpend = round2(state.summary.spent / bounds.days);
      state.summary.largestExpense = round2(state.summary.largestExpense);

      const highestType = state.expenseTypes
        .filter((row) => row.amount > 0)
        .sort((a, b) => b.amount - a.amount)[0];

      const highestCategory = state.categoryBreakdown[0];

      state.insights = [
        highestType
          ? `${highestType.label} is the largest expense group this month.`
          : "No expense split is recorded for this member in this month.",
        highestCategory
          ? `${highestCategory.name} is the highest category for this member.`
          : "No category concentration found yet.",
        state.summary.settlementPosition > 0
          ? "This member paid more than their own share and may receive settlement."
          : state.summary.settlementPosition < 0
            ? "This member paid less than their own share and may need to settle with others."
            : "Paid amount and own share are balanced for this month.",
      ];

      return state;
    });

    const jointBalance = accountsSnapshot.accounts
      .filter((account) => String(account.owner || "").toLowerCase() === "joint")
      .reduce((sum, account) => sum + Number(account.balance || 0), 0);

    const highestSpender = outputUsers
      .slice()
      .sort((a, b) => Number(b.summary.spent || 0) - Number(a.summary.spent || 0))[0] || null;

    const strongestCash = outputUsers
      .slice()
      .sort((a, b) => Number(b.summary.cashRemaining || 0) - Number(a.summary.cashRemaining || 0))[0] || null;

    res.json({
      ok: true,
      data: {
        month,
        accountSource: accountsSnapshot.source,
        users: outputUsers,
        family: {
          totalIncome: round2(familyIncome),
          totalSpent: round2(familySpent),
          totalPaid: round2(familyPaid),
          totalCashRemaining: round2(
            outputUsers.reduce((sum, user) => sum + Number(user.summary.cashRemaining || 0), 0)
          ),
          totalAccountBalance: round2(
            outputUsers.reduce((sum, user) => sum + Number(user.summary.accountBalance || 0), 0) + jointBalance
          ),
          jointBalance: round2(jointBalance),
          highestSpender: highestSpender
            ? { userId: highestSpender.userId, name: highestSpender.name, amount: highestSpender.summary.spent }
            : null,
          strongestCash: strongestCash
            ? { userId: strongestCash.userId, name: strongestCash.name, amount: strongestCash.summary.cashRemaining }
            : null,
        },
      },
    });
  } catch (error) {
    console.error("Individual Summary Error:", error);
    res.status(500).json({ ok: false, message: error?.message || "Failed to load individual summary" });
  }
});

export default router;
