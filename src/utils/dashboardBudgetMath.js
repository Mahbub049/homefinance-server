/**
 * Phase 4A — read-only monthly budget summary.
 * Scheduled Shared/Large Purchases are an allocation, not a payment or an EMI.
 * Savings transfers change liquidity, not household spending; show them separately.
 * No database calls or mutations.
 */
const cents = (value) => Math.round(Number(value || 0) * 100);
const money = (value) => value / 100;

export function summarizeDashboardBudget({ entries = [], savingsContribution = 0 } = {}) {
  const totals = {
    income: 0, living: 0, regularDebt: 0,
    scheduledPurchases: 0, ledgerInvestment: 0,
  };
  for (const entry of entries) {
    const amount = cents(entry.amountTotal);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (entry.isBudgetAllocation === true || entry.sourceType === "shared_purchase_schedule") {
      // An actual unpaid budget obligation is not a new bank payment.
      totals.scheduledPurchases += amount;
      continue;
    }
    const financialType = entry.financialType || (entry.entryType === "income" ? "income" : "living");
    if (financialType === "income") totals.income += amount;
    else if (financialType === "living") totals.living += amount;
    else if (financialType === "debt") totals.regularDebt += amount;
    else if (financialType === "investment") totals.ledgerInvestment += amount;
  }
  const savings = cents(savingsContribution); // negative = withdrawals exceed deposits
  const budgetExpense = totals.living + totals.regularDebt + totals.scheduledPurchases;
  const netInvestment = totals.ledgerInvestment + savings;
  const allocated = budgetExpense + netInvestment;
  const available = totals.income - budgetExpense;
  const budgetRemaining = available - netInvestment;
  return {
    income: money(totals.income),
    living: money(totals.living),
    debt: money(totals.regularDebt + totals.scheduledPurchases), // backwards compatible with older clients
    investment: money(netInvestment),
    available: money(available),
    finalBalance: money(budgetRemaining),
    savingsRate: totals.income > 0 ? Math.round(netInvestment * 10000 / totals.income) / 100 : 0,
    components: {
      regularDebt: money(totals.regularDebt),
      scheduledLargePurchaseAllocation: money(totals.scheduledPurchases),
      ledgerInvestment: money(totals.ledgerInvestment),
      savingsContribution: money(savings),
      netSavingsAndInvestment: money(netInvestment),
      budgetExpenses: money(budgetExpense),
      budgetOutgoingsWithSavings: money(allocated),
    },
  };
}
