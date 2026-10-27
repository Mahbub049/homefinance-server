import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMonthlyLiquidFlow } from '../src/utils/monthlyLiquidFlow.js';
import { summarizeDashboardBudget } from '../src/utils/dashboardBudgetMath.js';
import { calculateOrdinaryExpenseShares } from '../src/utils/expenseFunding.js';
import { buildSharedBudgetView } from '../src/utils/sharedBudgetMath.js';
import { calculateAccountPeriod } from '../src/utils/reconciledAccountMath.js';
import { reportSavingsFlow } from '../src/utils/reportingMath.js';
import { guardHistoricalAccountUpdate, sensitiveAccountChanges, parseOpeningBalance } from '../src/utils/accountHistoryRules.js';

const accounts = [
  { _id: 'a', type: 'bank', owner: 'Mahbub', openingBalance: 0 },
  { _id: 'b', type: 'bank', owner: 'Mirza', openingBalance: 0 },
  { _id: 'dps', type: 'savings', owner: 'Mahbub', openingBalance: 0 },
  { _id: 'dps2', type: 'savings', owner: 'Mirza', openingBalance: 0 },
];
const tx = (id, txType, amount, fields = {}) => ({ _id: id, txType, amount, month: '2026-10', ...fields });

// These are executable financial invariants for Phase 9's Bangla interface.
test('both members paying 30 of a 60 rickshaw expense changes family monthly cash -60', () => {
  const result = calculateMonthlyLiquidFlow(accounts, [tx('r', 'expense', 60, {
    paymentMode: 'split', paymentParts: [{ userId: 'u1', accountId: 'a', amount: 30 }, { userId: 'u2', accountId: 'b', amount: 30 }],
  })]);
  assert.equal(result.household.remainingFromMonth, -60);
  assert.equal(result.byOwner.Mahbub.remainingFromMonth, -30);
  assert.equal(result.byOwner.Mirza.remainingFromMonth, -30);
  assert.equal(result.issues.length, 0);
});

test('paying 60 entirely by Mahbub for an equal-share expense yields 30 receivable', () => {
  const entry = { _id: 'L', entryType: 'expense', amountTotal: 60, sourceType: 'transaction', sourceId: 'r' };
  const result = calculateOrdinaryExpenseShares({
    entries: [entry], splits: [{ ledgerEntryId: 'L', userId: 'u1', shareAmount: 30 }, { ledgerEntryId: 'L', userId: 'u2', shareAmount: 30 }],
    transactions: [tx('r', 'expense', 60, { paidByUserId: 'u1', paymentMode: 'single' })], userIds: ['u1', 'u2'],
  });
  assert.equal(result.paidMap.u1 - result.shareMap.u1, 30);
  assert.equal(result.paidMap.u2 - result.shareMap.u2, -30);
  assert.equal(result.balanced, true);
});

test('a 5k reimbursement moves ownership of cash without adding family income or spend', () => {
  const result = calculateMonthlyLiquidFlow(accounts, [tx('transfer', 'transfer', 5000, { fromAccountId: 'a', toAccountId: 'b' })]);
  assert.equal(result.household.remainingFromMonth, 0);
  assert.equal(result.byOwner.Mahbub.remainingFromMonth, -5000);
  assert.equal(result.byOwner.Mirza.remainingFromMonth, 5000);
});

test('a same-member liquid transfer creates no new monthly saving or spending', () => {
  const onePersonAccounts = [...accounts, { _id: 'bkash', owner: 'Mahbub', type: 'wallet' }];
  const result = calculateMonthlyLiquidFlow(onePersonAccounts, [tx('move', 'transfer', 1000, { fromAccountId: 'a', toAccountId: 'bkash' })]);
  assert.equal(result.household.remainingFromMonth, 0);
  assert.equal(result.byOwner.Mahbub?.remainingFromMonth ?? 0, 0);
});

test('monthly income 120k, paid living 50k, paid EMI 20k, savings 15k -> 35k liquid change', () => {
  const events = [
    tx('salary1', 'income', 60000, { toAccountId: 'a' }),
    tx('salary2', 'income', 60000, { toAccountId: 'b' }),
    tx('living', 'expense', 50000, { fromAccountId: 'a' }),
    tx('emi', 'expense', 20000, { fromAccountId: 'b', sourceType: 'emi_installment' }),
    tx('dps', 'transfer', 15000, { fromAccountId: 'a', toAccountId: 'dps' }),
  ];
  const result = calculateMonthlyLiquidFlow(accounts, events);
  assert.deepEqual([result.household.income, result.household.expenses, result.household.emiPaid,
    result.household.savedOrInvested, result.household.remainingFromMonth], [120000, 70000, 20000, 15000, 35000]);
});

test('EMI schedule alone does not count as paid debt', () => {
  const report = summarizeDashboardBudget({ entries: [{ entryType: 'income', financialType: 'income', amountTotal: 120000 }] });
  assert.equal(report.components.regularDebt, 0);
  assert.equal(report.finalBalance, 120000);
});

test('74k AC spread 8 months, equal co-owners: monthly budget 9250, not a new bank debit', () => {
  const month = '2026-10';
  const purchase = { _id: 'ac', title: 'AC' };
  const rows = [
    { _id: 'inst1', purchaseId: 'ac', userId: 'u1', amount: 4625, month },
    { _id: 'inst2', purchaseId: 'ac', userId: 'u2', amount: 4625, month },
  ];
  const budget = buildSharedBudgetView({ month, purchases: [purchase], installments: rows });
  const report = summarizeDashboardBudget({ entries: budget.entries });
  assert.equal(budget.summary.scheduledLargePurchaseAllocation, 9250);
  assert.equal(budget.summary.byMember.u1, 4625);
  assert.equal(budget.summary.byMember.u2, 4625);
  assert.equal(report.components.scheduledLargePurchaseAllocation, 9250);
  const upfront = calculateMonthlyLiquidFlow(accounts, [tx('buyAC', 'expense', 74000, { fromAccountId: 'a', sourceType: 'shared_purchase', budgetImpact: false })]);
  assert.equal(upfront.household.sharedPurchasePaidUpfront, 74000);
  assert.equal(upfront.household.remainingFromMonth, -74000);
});

test('DPS transfer is a savings contribution, and DPS to DPS is not another deposit', () => {
  const transfer = tx('dep', 'transfer', 15000, { fromAccountId: 'a', toAccountId: 'dps' });
  const internal = tx('dep2', 'transfer', 2000, { fromAccountId: 'dps', toAccountId: 'dps2' });
  assert.deepEqual(reportSavingsFlow(accounts, [transfer, internal]), { in: 15000, out: 0, net: 15000 });
});

test('carry-forward balances preserve 5k movement between personal accounts at household level', () => {
  const result = calculateAccountPeriod(accounts, [
    { accountId: 'a', balance: 10000 }, { accountId: 'b', balance: 20000 },
    { accountId: 'dps', balance: 0 }, { accountId: 'dps2', balance: 0 },
  ], [tx('move', 'transfer', 5000, { fromAccountId: 'a', toAccountId: 'b' })]);
  assert.equal(result.liquidOpening, 30000);
  assert.equal(result.liquidClosing, 30000);
  assert.equal(result.accounts.find((x) => x.accountId === 'a').balance, 5000);
  assert.equal(result.accounts.find((x) => x.accountId === 'b').balance, 25000);
});

test('account history blocks silent changes to owner, type and opening but allows harmless renaming', () => {
  const saved = { type: 'bank', owner: 'Mahbub', openingBalance: 1000 };
  assert.deepEqual(sensitiveAccountChanges(saved, { openingBalance: 1000, owner: 'Mahbub' }), []);
  assert.deepEqual(guardHistoricalAccountUpdate(saved, { name: 'New display name' }, true), []);
  assert.throws(() => guardHistoricalAccountUpdate(saved, { openingBalance: 2000 }, true), { status: 409 });
  assert.throws(() => guardHistoricalAccountUpdate(saved, { owner: 'Mirza' }, true), { status: 409 });
  assert.throws(() => guardHistoricalAccountUpdate(saved, { type: 'savings' }, true), { status: 409 });
  assert.equal(parseOpeningBalance('1000.50'), 1000.5);
  assert.throws(() => parseOpeningBalance('NaN'), { status: 400 });
  assert.throws(() => parseOpeningBalance('1.234'), { status: 400 });
});
