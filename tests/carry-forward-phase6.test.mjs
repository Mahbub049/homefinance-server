import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateAccountPeriod, summarizeLiquidBalances } from '../src/utils/reconciledAccountMath.js';
import {
  getDhakaCurrentMonth, mayCloseMonth, writableMonth, snapshotTotal,
  manualClosingOverrides, fingerprintReconciliation, blockersFromIssues, snapshotConflict,
} from '../src/utils/carryForwardRules.js';
const accounts = [
  { _id: 'ma', name: 'Mahbub cash', type: 'bank', owner: 'Mahbub', openingBalance: 500 },
  { _id: 'mi', name: 'Mim bank', type: 'bank', owner: 'Mirza', openingBalance: 200 },
  { _id: 'dp', name: 'DPS', type: 'savings', owner: 'Mahbub', openingBalance: 0 },
];
const system = calculateAccountPeriod(accounts, null, [
  { _id: 'income', txType: 'income', amount: 3000, toAccountId: 'ma' },
  { _id: 'transfer', txType: 'transfer', amount: 1000, fromAccountId: 'ma', toAccountId: 'dp' },
  { _id: 'expense', txType: 'expense', amount: 60, paymentMode: 'split', paymentParts: [
    { accountId: 'ma', amount: 30 }, { accountId: 'mi', amount: 30 },
  ] },
]);
const rows = system.accounts;
test('liquid cash roll forward splits a 60 expense 30 each and excludes DPS', () => {
  assert.equal(summarizeLiquidBalances(rows).total, 2640);
  assert.equal(system.closingTotal, 3640);
});
test('manual closing changes only specified account; untouched accounts remain live', () => {
  const revised = manualClosingOverrides(rows, [{ accountId: 'ma', balance: 2500.25 }]);
  assert.equal(revised.accounts.find((r) => r.accountId === 'ma').balance, 2500.25);
  assert.equal(revised.accounts.find((r) => r.accountId === 'mi').balance, 170);
  assert.equal(revised.accounts.find((r) => r.accountId === 'dp').balance, 1000);
  assert.equal(revised.manualAdjusted, true);
  assert.equal(revised.total, 3670.25);
});
test('empty override resets every account to live calculated system balance', () => {
  const r = manualClosingOverrides(rows, []);
  assert.equal(r.total, system.closingTotal);
  assert.equal(r.manualAdjusted, false);
});
test('invalid, duplicate, unknown and fractional-account overrides rejected', () => {
  assert.throws(() => manualClosingOverrides(rows, [{ accountId: 'ma', balance: 'abc' }]));
  assert.throws(() => manualClosingOverrides(rows, [{ accountId: 'mi', balance: '' }]));
  assert.throws(() => manualClosingOverrides(rows, [{ accountId: 'ma', balance: 2.345 }]));
  assert.throws(() => manualClosingOverrides(rows, [{ accountId: 'ma', balance: Infinity }]));
  assert.throws(() => manualClosingOverrides(rows, [{ accountId: 'new', balance: 1 }]));
  assert.throws(() => manualClosingOverrides(rows, [{ accountId: 'ma', balance: 1 }, { accountId: 'ma', balance: 1 }]));
});
test('snapshot totals sum integer cents including negatives', () => {
  assert.equal(snapshotTotal([{ balance: -5.91 }, { balance: 6.01 }]), 0.10);
});
test('October is writable but cannot close before November in Dhaka', () => {
  assert.equal(getDhakaCurrentMonth(new Date('2026-10-31T17:59:59Z')), '2026-10');
  assert.equal(getDhakaCurrentMonth(new Date('2026-10-31T18:00:00Z')), '2026-11');
  assert.equal(mayCloseMonth('2026-10', new Date('2026-10-31T17:59:59Z')), false);
  assert.equal(mayCloseMonth('2026-10', new Date('2026-10-31T18:00:00Z')), true);
  assert.equal(writableMonth('2026-09'), false);
  assert.equal(writableMonth('2026-10'), true);
});
test('reconciliation fingerprint independent of displayed account row order', () => {
  const r = { month: '2026-10', anchorMonth: '2026-09', opening: { total: 700 }, systemClosing: { accounts: rows }, issues: [] };
  assert.equal(fingerprintReconciliation(r), fingerprintReconciliation({ ...r, systemClosing: { accounts: [...rows].reverse() } }));
  assert.notEqual(fingerprintReconciliation(r), fingerprintReconciliation({ ...r, systemClosing: { accounts: rows.map((a,i) => i === 0 ? { ...a, balance: a.balance+1 } : a) } }));
});
test('unsafe funds prevent month closure but cosmetic warnings do not', () => {
  assert.equal(blockersFromIssues([{ code: 'INVALID_SPLIT_FUNDING' }, { code: 'NEGATIVE_ACCOUNT' }]).length, 1);
});
test('snapshot optimistic concurrency version detects changed closing snapshot', () => {
  const doc = { updatedAt: new Date('2026-10-27T00:00:00.000Z') };
  assert.equal(snapshotConflict(doc, '2026-10-27T00:00:00.000Z'), false);
  assert.equal(snapshotConflict(doc, '2026-10-26T00:00:00.000Z'), true);
});
test('Carry Forward GET has no write calls; POST has saved version + revision confirmation', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const route = fs.readFileSync(path.join(here, '../src/routes/monthBalance.route.js'), 'utf8');
  const get = route.slice(route.indexOf("router.get('/'"), route.indexOf('async function writeSnapshot'));
  assert.doesNotMatch(get, /\.create\(|\.save\(|\.findOneAndUpdate\(|cleanupPendingInstallmentLedgers/);
  assert.match(route, /expectedFingerprint/);
  assert.match(route, /REVISE \$\{month\}/);
  assert.match(route, /findOneAndUpdate/);
});
