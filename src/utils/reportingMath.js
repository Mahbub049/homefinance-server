/** Pure report projections: distinguish allocated budget, posted cash, and assets. */
import { summarizeDashboardBudget } from './dashboardBudgetMath.js';
import { LIQUID_TYPES, toCents, fromCents } from './reconciledAccountMath.js';

const liquidTypes = new Set(LIQUID_TYPES);
export const reportMoney = (amount) => fromCents(toCents(amount));

/** Transfers between tracked savings/investment accounts are NOT new deposits. */
export function reportSavingsFlow(accounts = [], transactions = []) {
  const byId = new Map(accounts.map((a) => [String(a._id ?? a.accountId), a]));
  const typeOf = (id) => byId.get(String(id ?? ''))?.type;
  let deposited = 0, withdrawn = 0;
  for (const tx of transactions) {
    if (tx.txType !== 'transfer') continue;
    const from = typeOf(tx.fromAccountId);
    const to = typeOf(tx.toAccountId);
    const amount = toCents(tx.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (liquidTypes.has(from) && (to === 'savings' || to === 'investment')) deposited += amount;
    else if ((from === 'savings' || from === 'investment') && liquidTypes.has(to)) withdrawn += amount;
  }
  return { in: fromCents(deposited), out: fromCents(withdrawn), net: fromCents(deposited - withdrawn) };
}

export function makeMonthlyReport({ month, budgetEntries = [], transactions = [], accounts = [], cashFlow, openingBalance = null, closingBalance = null, budgetIssues = [] }) {
  const savings = reportSavingsFlow(accounts, transactions);
  const budget = summarizeDashboardBudget({ entries: budgetEntries, savingsContribution: savings.net });
  const cash = cashFlow.household;
  const transfers = transactions.filter((tx) => tx.txType === 'transfer')
    .reduce((sum, tx) => sum + toCents(tx.amount), 0);
  return {
    month, income: budget.income, expense: budget.components.budgetExpenses,
    transfer: fromCents(transfers),
    // The former field name remains for existing chart integrations; value is ACTUAL cash movement.
    netCashflow: cash.remainingFromMonth,
    cashIncome: cash.income, cashExpenses: cash.expenses,
    cashCardRepayments: cash.cardRepayments,
    cashSaved: cash.savedOrInvested, cashWithdrawn: cash.savingsWithdrawn,
    budgetRemaining: budget.finalBalance,
    budgetAllocated: budget.components.budgetOutgoingsWithSavings,
    regularLiving: budget.components.budgetExpenses - budget.components.regularDebt - budget.components.scheduledLargePurchaseAllocation,
    regularDebt: budget.components.regularDebt,
    sharedAllocation: budget.components.scheduledLargePurchaseAllocation,
    savingsIn: savings.in, savingsOut: savings.out, savingsGrowth: savings.net,
    savingsRate: budget.income > 0 ? reportMoney(savings.in / budget.income * 100) : 0,
    openingBalance, closingBalance,
    warningCount: (cashFlow.issues || []).length + budgetIssues.length,
  };
}

export function sumYearReport(months = []) {
  const keys = ['income','expense','transfer','netCashflow','cashIncome','cashExpenses','cashCardRepayments',
    'cashSaved','cashWithdrawn','budgetRemaining','budgetAllocated','regularLiving','regularDebt',
    'sharedAllocation','savingsIn','savingsOut','savingsGrowth'];
  const totals = Object.fromEntries(keys.map((k) => [k, fromCents(months.reduce((s, m) => s + toCents(m[k]), 0))]));
  totals.savingsRate = totals.income > 0 ? reportMoney(totals.savingsIn / totals.income * 100) : 0;
  totals.warningCount = months.reduce((s, m) => s + (m.warningCount || 0), 0);
  return totals;
}

/** Our legacy Account.owner enum is separate from User IDs; never infer cash ownership from split shares. */
export function memberOwnerKey(name = '') {
  const cleaned = String(name).toLowerCase().trim();
  if (/\bmahbub\b/.test(cleaned)) return 'Mahbub';
  if (/\bmirza\b/.test(cleaned)) return 'Mirza';
  return null;
}
