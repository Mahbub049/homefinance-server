import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeMonthlyReport, sumYearReport, reportSavingsFlow, memberOwnerKey } from '../src/utils/reportingMath.js';
import { calculateMonthlyLiquidFlow } from '../src/utils/monthlyLiquidFlow.js';
import { buildSharedBudgetView } from '../src/utils/sharedBudgetMath.js';

const accounts = [
  { _id: 'mb', type: 'bank', owner: 'Mahbub' },
  { _id: 'mi', type: 'bank', owner: 'Mirza' },
  { _id: 'save', type: 'savings', owner: 'Mahbub' },
  { _id: 'invest', type: 'investment', owner: 'Mirza' },
];
function tx(extra) { return { _id: String(Math.random()), ...extra }; }
const routeDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/routes');

test('splitting a 60 taka payment into two real 30 outflows deducts just 60 total', () => {
  const transactions = [tx({ txType: 'expense', amount: 60, paymentMode: 'split', paymentParts: [
    { accountId: 'mb', amount: 30 }, { accountId: 'mi', amount: 30 },
  ] })];
  const cash = calculateMonthlyLiquidFlow(accounts, transactions);
  assert.equal(cash.household.expenses, 60);
  assert.equal(cash.byOwner.Mahbub.remainingFromMonth, -30);
  assert.equal(cash.byOwner.Mirza.remainingFromMonth, -30);
});

test('bank-to-bank transfer cancels at household level while changing member flow', () => {
  const cash = calculateMonthlyLiquidFlow(accounts, [tx({ txType: 'transfer', amount: 4625, fromAccountId: 'mb', toAccountId: 'mi' })]);
  assert.equal(cash.household.remainingFromMonth, 0);
  assert.equal(cash.byOwner.Mahbub.remainingFromMonth, -4625);
  assert.equal(cash.byOwner.Mirza.remainingFromMonth, 4625);
});

test('savings-to-investment switch does not create new savings deposit', () => {
  const result = reportSavingsFlow(accounts, [tx({ txType: 'transfer', amount: 5000, fromAccountId: 'save', toAccountId: 'invest' })]);
  assert.deepEqual(result, { in: 0, out: 0, net: 0 });
});

test('savings deposits/withdrawals affect cash but not household expense', () => {
  const transactions = [
    tx({ txType: 'income', amount: 60000, toAccountId: 'mb' }),
    tx({ txType: 'expense', amount: 30000, fromAccountId: 'mb' }),
    tx({ txType: 'transfer', amount: 10000, fromAccountId: 'mb', toAccountId: 'save' }),
  ];
  const cashFlow = calculateMonthlyLiquidFlow(accounts, transactions);
  const row = makeMonthlyReport({ month: '2026-10', transactions, accounts, cashFlow,
    budgetEntries: [{ entryType: 'income', financialType: 'income', amountTotal: 60000 }, { entryType: 'expense', financialType: 'living', amountTotal: 30000 }],
    openingBalance: 8000, closingBalance: 28000 });
  assert.equal(row.netCashflow, 20000);
  assert.equal(row.savingsIn, 10000);
  assert.equal(row.expense, 30000);
  assert.equal(row.budgetRemaining, 20000);
  assert.equal(row.closingBalance, 28000);
});

test('scheduled large purchase adds to budget, but not cash expenses', () => {
  const shared = buildSharedBudgetView({ month: '2026-10', installments: [
    { _id: 'a', month: '2026-10', purchaseId: 'ac', userId: 'mah', amount: 4625 },
    { _id: 'b', month: '2026-10', purchaseId: 'ac', userId: 'mim', amount: 4625 },
  ], purchases: [{ _id: 'ac', title: 'AC' }] });
  const cashFlow = calculateMonthlyLiquidFlow(accounts, []);
  const row = makeMonthlyReport({ month: '2026-10', cashFlow, accounts, budgetEntries: shared.entries });
  assert.equal(row.expense, 9250);
  assert.equal(row.sharedAllocation, 9250);
  assert.equal(row.netCashflow, 0);
});

test('year totals round up only monthly metrics, never sum account snapshot balances', () => {
  const sample = [
    { income: 50000, expense: 30000, netCashflow: 10000, savingsIn: 10000, openingBalance: 5000, closingBalance: 15000 },
    { income: 60000, expense: 40000, netCashflow: 15000, savingsIn: 5000, openingBalance: 15000, closingBalance: 30000 },
  ];
  const result = sumYearReport(sample);
  assert.equal(result.income, 110000);
  assert.equal(result.expense, 70000);
  assert.equal(result.netCashflow, 25000);
  assert.equal(result.openingBalance, undefined);
  assert.equal(result.closingBalance, undefined);
});

test('member owner mappings are explicit and never map Joint to a member', () => {
  assert.equal(memberOwnerKey('Mahbub Sarwar'), 'Mahbub');
  assert.equal(memberOwnerKey('Jannatul Ferdous Mirza'), 'Mirza');
  assert.equal(memberOwnerKey('Another Household Member'), null);
});

test('annual and monthly export requests are read only and do not run cleanup writes', () => {
  for (const file of ['yearOverview.route.js', 'individualSummary.route.js', 'export.route.js']) {
    const source = readFileSync(resolve(routeDir, file), 'utf8');
    assert.ok(!source.includes('cleanupPendingInstallmentLedgers'), `${file} must not clean data during GET`);
    assert.match(source, /router\.get/);
    assert.doesNotMatch(source, /\b(?:LedgerEntry|Transaction|Account|Split|MonthlyBalance)\.(?:deleteMany|updateMany|insertMany|findOneAndUpdate|create)\(/);
  }
});

test('individual reports include shared virtual rows and posted monthly cash calculation', () => {
  const source = readFileSync(resolve(routeDir, 'individualSummary.route.js'), 'utf8');
  assert.match(source, /budgetView\.virtualRows/);
  assert.match(source, /cleanId\(split\.userId\)/);
  assert.match(source, /calculateMonthlyLiquidFlow/);
  assert.match(source, /loadReconciledMonth/);
});
