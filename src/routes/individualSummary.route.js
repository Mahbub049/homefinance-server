import mongoose from "mongoose";
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Transaction from "../models/Transaction.js";
import Account from "../models/Account.js";
import { buildLedgerPaymentRows, calculateOrdinaryExpenseShares } from "../utils/expenseFunding.js";
import { loadSharedBudgetMonth } from "../utils/sharedBudgetReadModel.js";
import { loadReconciledMonth } from "../utils/reconciledAccounts.js";
import { calculateMonthlyLiquidFlow } from "../utils/monthlyLiquidFlow.js";
import { memberOwnerKey } from "../utils/reportingMath.js";

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

  if (module === 'shared_purchase') {
    return { key: 'shared', label: 'Large Purchase Budget', tone: 'violet' };
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
  const key = memberOwnerKey(userName);
  return !!key && key === String(accountOwner || '');
}

function buildEmptyUser(user, daysInMonth) {
  const byTypeTemplate = [
    { key: "fixed", label: "Fixed Expenses", amount: 0, count: 0, tone: "amber" },
    { key: "grocery", label: "Grocery", amount: 0, count: 0, tone: "emerald" },
    { key: "emi", label: "EMI / Debt", amount: 0, count: 0, tone: "violet" },
    { key: "shared", label: "Large Purchase Budget", amount: 0, count: 0, tone: "violet" },
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
      cashRemaining: 0, // closing personal liquid-account balance, includes earlier months
      monthlyCashRemaining: 0, // THIS month's actual account cash movement
      actualIncomeReceived: 0,
      actualCashExpenses: 0,
      savingsDeposited: 0,
      savingsWithdrawn: 0,
      sharedPurchaseAllocation: 0,
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

router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();
    const bounds = monthBounds(month);

    if (!bounds) {
      return res.status(400).json({ ok: false, message: "Valid month (YYYY-MM) required" });
    }

    const topLimit = Math.min(100, Math.max(1, Number.parseInt(req.query.topLimit, 10) || 10));
    const familyObjectId = new mongoose.Types.ObjectId(req.familyId);

    const members = await FamilyMember.find({ familyId: familyObjectId })
      .populate("userId", "name email")
      .lean();

    const users = members.map((member) => member.userId).filter(Boolean);
    const userMap = new Map(users.map((u) => [String(u._id), buildEmptyUser(u, bounds.days)]));

    const postedEntries = await LedgerEntry.find({ familyId: familyObjectId, month })
      .populate("categoryId", "name kind financialType")
      .populate("paidByUserId", "name email")
      .populate("receivedByUserId", "name email")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    // Same scheduled allocations as Dashboard, without posting a second expense.
    const budgetView = await loadSharedBudgetMonth(req.familyId, month, postedEntries);
    const entries = budgetView.entries;
    const regularEntries = budgetView.regularEntries;
    const entryIds = regularEntries.map((entry) => entry._id);
    const splits = entryIds.length
      ? await Split.find({ familyId: familyObjectId, ledgerEntryId: { $in: entryIds } }).lean()
      : [];

    const linkedTransactionIds = regularEntries
      .filter((entry) => entry.entryType === "expense" && entry.sourceType === "transaction" && entry.sourceId)
      .map((entry) => entry.sourceId);
    const fundingTransactions = linkedTransactionIds.length
      ? await Transaction.find({ familyId: familyObjectId, _id: { $in: linkedTransactionIds }, txType: "expense" })
        .select("_id txType amount paidByUserId paymentMode paymentParts settlementImpact").lean()
      : [];
    const paymentRows = buildLedgerPaymentRows(entries, fundingTransactions);
    const ordinaryExpense = calculateOrdinaryExpenseShares({
      entries: regularEntries, splits, transactions: fundingTransactions, userIds: users.map((user) => user._id),
    });

    const splitsByEntry = Object.create(null);
    for (const split of splits) {
      const key = String(split.ledgerEntryId);
      if (!splitsByEntry[key]) splitsByEntry[key] = [];
      splitsByEntry[key].push(split);
    }
    for (const allocation of budgetView.virtualRows) {
      splitsByEntry[String(allocation._id)] = allocation.splits || [];
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
    const allocationIssues = [];

    for (const entry of entries) {
      const entrySplits = splitsByEntry[String(entry._id)] || [];
      const amount = Number(entry.amountTotal || 0);
      const dayNumber = new Date(entry.date).getDate();
      const dayIndex = Number.isFinite(dayNumber) ? dayNumber - 1 : -1;

      if (entry.entryType === "income") {
        familyIncome += amount;
        if (!entrySplits.length && amount > 0) {
          const recipient = userMap.get(String(entry.receivedByUserId?._id || entry.receivedByUserId || ''));
          if (recipient) {
            recipient.summary.income += amount;
          } else {
            allocationIssues.push({ code: 'UNALLOCATED_INCOME', entryId: String(entry._id) });
          }
        }
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
      if (!entrySplits.length && amount > 0) allocationIssues.push({ code: 'UNALLOCATED_EXPENSE', entryId: String(entry._id) });

      const type = moduleInfo(entry);
      const categoryName = entry.categoryId?.name || type.label || "Expense";

      // The 'Paid' metric is a real cash payment, not a scheduled budget allocation.
      // This includes both contributors when a payment is split across accounts.
      const fundingRows = paymentRows.get(String(entry._id)) || [];
      for (const payment of fundingRows) {
        const paidState = userMap.get(payment.userId);
        if (!paidState) continue;
        const paidAmount = payment.amountCents / 100;
        paidState.summary.paid += paidAmount;
        familyPaid += paidAmount;
        paidState.topExpenses.push({
          entryId: String(entry._id),
          date: entry.date,
          category: categoryName,
          module: entry.module || "manual",
          typeLabel: type.label,
          note: entry.note || "",
          paidBy: paidState.name,
          paidAmount: round2(paidAmount),
          totalAmount: round2(amount),
        });
      }

      for (const split of entrySplits) {
        // Shared Purchase schedules populate userId as an object; always normalize it.
        const userId = cleanId(split.userId);
        const state = userMap.get(userId);
        if (!state) continue;

        const shareAmount = Number(split.shareAmount || 0);
        if (shareAmount <= 0) continue;

        state.summary.spent += shareAmount;
        if (entry.isBudgetAllocation) state.summary.sharedPurchaseAllocation += shareAmount;
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

    const [reconciled, allAccounts, monthTransactions] = await Promise.all([
      loadReconciledMonth(req.familyId, month),
      // Include inactive accounts with past financial history.
      Account.find({ familyId: familyObjectId })
        .select('_id owner name type').lean(),
      Transaction.find({ familyId: familyObjectId, month })
        .select('_id txType amount sourceType paymentMode paymentParts fromAccountId toAccountId').lean(),
    ]);
    const accountsSnapshot = {
      source: reconciled.closed ? 'closed_month' : 'system_calculated',
      accounts: reconciled.closing.accounts,
    };
    const accountsById = new Map(accountsSnapshot.accounts.map((account) => [String(account.accountId), account]));
    const monthlyFlow = calculateMonthlyLiquidFlow(allAccounts, monthTransactions);

    for (const account of accountsSnapshot.accounts) {
      if (String(account.owner || '').toLowerCase() === 'joint') continue;
      for (const user of users) {
        if (!accountBelongsToUser(account.owner, user.name)) continue;
        const state = userMap.get(String(user._id));
        if (!state) continue;
        const row = {
          accountId: String(account.accountId), name: account.name,
          type: account.type, owner: account.owner, balance: round2(account.balance),
        };
        state.accountBalances.push(row);
        state.summary.accountBalance += Number(row.balance || 0);
        if (['cash', 'bank', 'wallet'].includes(String(row.type || '').toLowerCase())) {
          state.summary.cashRemaining += Number(row.balance || 0);
        }
        if (['savings', 'investment'].includes(String(row.type || '').toLowerCase())) {
          state.summary.savingsBalance += Number(row.balance || 0);
        }
      }
    }

    for (const transfer of monthTransactions.filter((tx) => tx.txType === 'transfer')) {
      const amount = Number(transfer.amount || 0);
      const fromAccount = accountsById.get(String(transfer.fromAccountId));
      const toAccount = accountsById.get(String(transfer.toAccountId));
      for (const user of users) {
        const state = userMap.get(String(user._id));
        if (!state) continue;
        if (fromAccount && accountBelongsToUser(fromAccount.owner, user.name)) state.summary.transferOut += amount;
        if (toAccount && accountBelongsToUser(toAccount.owner, user.name)) state.summary.transferIn += amount;
      }
    }

    for (const user of users) {
      const state = userMap.get(String(user._id));
      const owner = memberOwnerKey(user.name);
      const flow = owner && monthlyFlow.byOwner[owner];
      if (!state || !flow) continue;
      state.summary.monthlyCashRemaining = flow.remainingFromMonth;
      state.summary.actualIncomeReceived = flow.income;
      state.summary.actualCashExpenses = flow.expenses;
      state.summary.savingsDeposited = flow.savedOrInvested;
      state.summary.savingsWithdrawn = flow.savingsWithdrawn;
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
        .slice(0, 20);

      state.dailyTrend = state.dailyTrend.map((row) => ({ ...row, amount: round2(row.amount) }));
      state.topExpenses = state.topExpenses
        .sort((a, b) => Number(b.paidAmount || b.totalAmount || 0) - Number(a.paidAmount || a.totalAmount || 0))
        .slice(0, topLimit);

      state.summary.income = round2(state.summary.income);
      state.summary.spent = round2(state.summary.spent);
      state.summary.paid = round2(state.summary.paid);
      state.summary.netRemaining = round2(state.summary.income - state.summary.spent);
      state.summary.sharedPurchaseAllocation = round2(state.summary.sharedPurchaseAllocation);
      state.summary.monthlyCashRemaining = round2(state.summary.monthlyCashRemaining);
      state.summary.cashRemaining = round2(state.summary.cashRemaining);
      state.summary.accountBalance = round2(state.summary.accountBalance);
      state.summary.savingsBalance = round2(state.summary.savingsBalance);
      state.summary.transferIn = round2(state.summary.transferIn);
      state.summary.transferOut = round2(state.summary.transferOut);
      state.summary.transferNet = round2(state.summary.transferIn - state.summary.transferOut);
      state.summary.settlementPosition = round2(
        (ordinaryExpense.paidMap[userId] || 0) - (ordinaryExpense.shareMap[userId] || 0)
      );
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
        reportBasis: {
          budget: 'regular_expense_shares_plus_scheduled_shared_purchase_allocations',
          cash: 'posted_transactions_from_liquid_accounts',
          settlement: 'ordinary_expenses_only_check_wallet_for_full_settlement',
        },
        issues: [...(budgetView.summary.issues || []), ...reconciled.issues, ...monthlyFlow.issues, ...allocationIssues],
        ordinaryExpenseIntegrity: {
          balanced: ordinaryExpense.balanced,
          discrepancy: ordinaryExpense.settlementDiscrepancy,
        },
        users: outputUsers,
        family: {
          totalIncome: round2(familyIncome),
          totalSpent: round2(familySpent),
          totalPaid: round2(familyPaid),
          unallocatedExpense: round2(familySpent - outputUsers.reduce((sum, u) => sum + u.summary.spent, 0)),
          // Family totals include joint accounts, unlike the personal account cards.
          totalCashRemaining: round2(
            accountsSnapshot.accounts.filter((account) => ['cash','bank','wallet'].includes(account.type))
              .reduce((sum, account) => sum + Number(account.balance || 0), 0)
          ),
          monthlyCashRemaining: round2(monthlyFlow.household.remainingFromMonth),
          scheduledSharedAllocation: round2(budgetView.summary.scheduledLargePurchaseAllocation),
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
