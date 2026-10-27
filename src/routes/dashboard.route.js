import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import { calculateOrdinaryExpenseShares } from "../utils/expenseFunding.js";
import { loadSharedBudgetMonth } from "../utils/sharedBudgetReadModel.js";
import { summarizeDashboardBudget } from "../utils/dashboardBudgetMath.js";
import { loadReconciledMonth } from "../utils/reconciledAccounts.js";
import { summarizeLiquidBalances } from "../utils/reconciledAccountMath.js";
import { calculateMonthlyLiquidFlow } from "../utils/monthlyLiquidFlow.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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

// Savings V2: contributions are TRANSFERS into savings/investment accounts.
// We treat withdrawals as negative savings contribution.
async function computeSavingsV2(familyId, month) {
  const monthEnd = endOfMonthDate(month);
  if (!monthEnd) return { monthIn: 0, monthOut: 0, monthNet: 0, totalAsset: 0 };

  const savingsAccounts = await Account.find({
    familyId,
    // Inactive savings accounts still hold historical assets.
    type: { $in: ["savings", "investment"] },
  }).select("_id openingBalance");

  const ids = savingsAccounts.map((a) => a._id);
  if (ids.length === 0) return { monthIn: 0, monthOut: 0, monthNet: 0, totalAsset: 0 };

  // 1) Month in/out
  const mt = await Transaction.aggregate([
    {
      $match: {
        familyId: new mongoose.Types.ObjectId(familyId),
        txType: "transfer",
        month,
        $or: [{ fromAccountId: { $in: ids } }, { toAccountId: { $in: ids } }],
      },
    },
    {
      $project: {
        inAmt: { $cond: [{ $in: ["$toAccountId", ids] }, "$amount", 0] },
        outAmt: { $cond: [{ $in: ["$fromAccountId", ids] }, "$amount", 0] },
      },
    },
    { $group: { _id: null, monthIn: { $sum: "$inAmt" }, monthOut: { $sum: "$outAmt" } } },
  ]);

  const monthIn = round2(mt?.[0]?.monthIn || 0);
  const monthOut = round2(mt?.[0]?.monthOut || 0);
  const monthNet = round2(monthIn - monthOut);

  // 2) Total savings asset up to month end = sum(openingBalance) + net transfers up to monthEnd
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
  const totalAsset = round2(openingSum + netTransfers);

  return { monthIn, monthOut, monthNet, totalAsset };
}

/* =====================================================
   MONTH SUMMARY
===================================================== */

router.get("/summary", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = req.query.month;
    if (!parseMonth(month) || !/^(?:\d{4})-(?:0[1-9]|1[0-2])$/.test(String(month))) {
      return res.status(400).json({ ok: false, message: "Valid month (YYYY-MM) required" });
    }


    /* ===========================================
       1️⃣ LOAD FAMILY USERS
    =========================================== */
    const members = await FamilyMember.find({ familyId: req.familyId }).populate("userId", "name email");
    const users = members.map((m) => m.userId).filter(Boolean);

    /* ===========================================
       2️⃣ LOAD LEDGER ENTRIES (income + expense)
    =========================================== */
    const entries = await LedgerEntry.find({
      familyId: req.familyId,
      month,
    });

    // Budget reports include every scheduled family member's share even if
    // their reimbursement has not been paid yet. The old posted installments
    // are excluded from this READ model to avoid counting either share twice.
    const budgetView = await loadSharedBudgetMonth(req.familyId, month, entries);
    const budgetEntries = budgetView.entries;

    // Phase 4A: budget is a planning view. Cash is an account-transaction view.
    const sv2 = await computeSavingsV2(req.familyId, month);
    const budget = summarizeDashboardBudget({
      entries: budgetEntries,
      savingsContribution: sv2.monthNet,
    });
    // UI-only reporting detail: generated/unpaid EMI bills never count as paid.
    const paidEmi = round2(entries.reduce((sum, entry) =>
      entry.module === 'emi' && entry.entryType === 'expense' && entry.financialType === 'debt'
        ? sum + Number(entry.amountTotal || 0) : sum, 0));
    const totalIncome = budget.income;
    const totalLiving = budget.living;
    const totalDebt = budget.debt;
    const totalLedgerInvestment = budget.components.ledgerInvestment;
    const savingsContribution = budget.components.savingsContribution;
    const totalSavingsAsset = sv2.totalAsset;
    const totalInvestment = budget.investment;
    const available = budget.available;
    const finalBalance = budget.finalBalance;
    const savingsRate = budget.savingsRate;
    const legacyExpense = round2(totalLiving + totalDebt + totalLedgerInvestment);
    const legacyBalance = round2(totalIncome - legacyExpense);
    const legacyDisposable = round2(legacyBalance - savingsContribution);

    // Same read-only account reconciliation and month-only cash arithmetic as Wallet.
    // No bills, settlements or synthetic budget rows are booked as cash here.
    const [reconciled, accountsForFlow, monthTransactions] = await Promise.all([
      loadReconciledMonth(req.familyId, month),
      Account.find({ familyId: req.familyId }).select("_id type owner name").lean(),
      Transaction.find({ familyId: req.familyId, month })
        .select("_id txType amount sourceType fromAccountId toAccountId paymentMode paymentParts").lean(),
    ]);
    const monthlyCashFlow = calculateMonthlyLiquidFlow(accountsForFlow, monthTransactions);
    const recordedCash = summarizeLiquidBalances(reconciled.closing.accounts);
    const cashWarnings = [...(monthlyCashFlow.issues || []), ...(reconciled.issues || [])];
    const negativeLiquidAccounts = recordedCash.accounts.filter((account) => Number(account.balance) < 0)
      .map((account) => ({ name: account.name, owner: account.owner, balance: account.balance }));

    /* ===========================================
       6️⃣ SPLIT + SETTLEMENT LOGIC
    =========================================== */

    // ✅ Split model stores ledgerEntryId (NOT entryId) and does NOT store month.
    // Fetch splits only for the loaded month entries.
    const entryIds = entries.map((e) => e._id);
    const splits = await Split.find({
      familyId: req.familyId,
      ledgerEntryId: { $in: entryIds },
    });

    const linkedTransactionIds = entries
      .filter((entry) => entry.entryType === "expense" && entry.sourceType === "transaction" && entry.sourceId)
      .map((entry) => entry.sourceId);
    const fundingTransactions = linkedTransactionIds.length
      ? await Transaction.find({ familyId: req.familyId, _id: { $in: linkedTransactionIds }, txType: "expense" })
        .select("_id txType amount paidByUserId paymentMode paymentParts settlementImpact")
        .lean()
      : [];

    const { paidMap, shareMap, balanced, settlementDiscrepancy } = calculateOrdinaryExpenseShares({
      entries: budgetView.regularEntries, splits, transactions: fundingTransactions, userIds: users.map((user) => user._id),
    });

    const settlement = users.map((u) => {
      const net = round2(
        (paidMap[String(u._id)] || 0) -
        (shareMap[String(u._id)] || 0)
      );

      return {
        userId: u._id,
        name: u.name,
        net, // positive → gets back, negative → owes
      };
    });

    /* ===========================================
       RESPONSE
    =========================================== */

    res.json({
      ok: true,
      data: {
        // This is monthly BUDGET allocation. Actual account cash is in Wallet.
        budgetAllocation: budgetView.summary,
        // ✅ v2 summary (new dashboard brain)
        summary: {
          income: totalIncome,
          living: totalLiving,
          debt: totalDebt,
          investment: totalInvestment,
          available,
          finalBalance,
          savingsRate,
          components: { ...budget.components, paidEmi },
        },

        // 🧯 legacy (for old UI pieces / other pages)
        family: {
          income: totalIncome,
          expense: legacyExpense,
          savings: savingsContribution,
          balance: legacyBalance,
          disposable: legacyDisposable,
        },
        totalSavingsAsset,
        cash: {
          monthRemaining: monthlyCashFlow.household.remainingFromMonth,
          incomeReceived: monthlyCashFlow.household.income,
          paidExpenses: monthlyCashFlow.household.expenses,
          // Actual recorded account debits, never a scheduled or unpaid bill.
          emiPaid: monthlyCashFlow.household.emiPaid,
          otherExpenses: monthlyCashFlow.household.otherExpenses,
          sharedPurchasePaidUpfront: monthlyCashFlow.household.sharedPurchasePaidUpfront,
          cardRepayments: monthlyCashFlow.household.cardRepayments,
          savingsDeposited: monthlyCashFlow.household.savedOrInvested,
          savingsWithdrawn: monthlyCashFlow.household.savingsWithdrawn,
          recordedLiquidBalance: recordedCash.total,
          negativeLiquidAccounts,
          warningCount: cashWarnings.length,
          closed: reconciled.closed,
          staleClosedCount: reconciled.staleClosedCount,
          source: "recorded_transactions",
        },
        settlement,
        settlementIntegrity: { balanced, discrepancy: settlementDiscrepancy },
      },
    });
  } catch (err) {
    console.error("Dashboard Summary Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

router.get("/trend", requireAuth, requireFamily, async (req, res) => {
  try {

    const selectedMonth = String(req.query.month || "");
    const selected = parseMonth(selectedMonth);
    const now = selected ? new Date(selected.y, selected.m - 1, 1) : new Date();
    const months = [];

    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      months.push(m);
    }

    const result = [];

    for (const m of months) {
      const persistedEntries = await LedgerEntry.find({ familyId: req.familyId, month: m });
      const { entries, summary: budgetAllocation } = await loadSharedBudgetMonth(req.familyId, m, persistedEntries);
      const sv2 = await computeSavingsV2(req.familyId, m);

      const budget = summarizeDashboardBudget({ entries, savingsContribution: sv2.monthNet });
      const { income, living, debt, investment, available, finalBalance, savingsRate } = budget;

      // legacy
      const expense = living + debt + budget.components.ledgerInvestment;

      result.push({
        month: m,
        scheduledLargePurchaseAllocation: budgetAllocation.scheduledLargePurchaseAllocation,
        income: round2(income),
        living: round2(living),
        debt: round2(debt),
        investment: round2(investment),
        available: round2(available),
        finalBalance: round2(finalBalance),
        savingsRate: round2(savingsRate),
        // legacy keys for older charts
        expense: round2(expense),
        savings: round2(sv2.monthNet),
        regularDebt: budget.components.regularDebt,
        scheduledPurchases: budget.components.scheduledLargePurchaseAllocation,
      });
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error("Dashboard Trend Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

export default router;