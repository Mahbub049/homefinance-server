import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEmiRecords, isPossibleCreditCardAccount } from '../src/utils/emiIntegrity.js';

const plan = { _id: 'p1', productName: 'Washing Machine', status: 'closed', totalPayable: 1200 };
const paid = { _id: 'i1', planId: 'p1', month: '2026-09', status: 'paid', amount: 100, transactionId: 't1', ledgerEntryId: 'l1' };
const tx = { _id: 't1', txType: 'expense', sourceId: 'i1', amount: 100, fromAccountId: 'a1' };
const ledger = { _id: 'l1', sourceType: 'transaction', sourceId: 't1', amountTotal: 100 };
const split = { ledgerEntryId: 'l1', userId: 'm1', shareAmount: 100 };
const account = { _id: 'a1', name: 'EBL Savings Bank', type: 'bank' };
const audit = (change = {}) => auditEmiRecords({
  plans: [plan], installments: [paid], transactions: [tx], ledgerEntries: [ledger], splits: [split], accounts: [account], ...change,
});

test('closed, partly-recorded plan is a warning rather than proof of bank debt', () => {
  const r = audit();
  assert.equal(r.issueCount, 1);
  assert.equal(r.byCode.closed_with_balance, 1);
  assert.equal(r.severitySummary.warning, 1);
  assert.match(r.issues[0].detail, /not proof of an unpaid bank bill/i);
  assert.equal(r.planSummaries[0].unresolvedScheduledBalance, 1100);
  assert.equal(r.planSummaries[0].verifiedLinkedAmount, 100);
});

test('legacy paid record with missing linked payment is separate from verified cash', () => {
  const r = audit({ transactions: [] });
  assert.equal(r.planSummaries[0].recordedPaidAmount, 100);
  assert.equal(r.planSummaries[0].verifiedLinkedAmount, 0);
  assert.equal(r.planSummaries[0].recordedUnverifiedAmount, 100);
  assert.ok(r.issues.find(x => x.code === 'paid_missing_transaction').suggestedAction.includes('external payment'));
});

test('credit-card-like cash account is flagged, not silently reclassified or deducted', () => {
  const card = { _id: 'a1', name: 'One Bank Credit Card', type: 'bank' };
  assert.equal(isPossibleCreditCardAccount(card), true);
  const r = audit({ accounts: [card] });
  assert.equal(r.byCode.possible_credit_card_account, 1);
  assert.equal(r.planSummaries[0].verifiedLinkedAmount, 100);
  assert.equal(card.type, 'bank');
});

test('generic debit card or ordinary bank is not wrongly treated as credit', () => {
  assert.equal(isPossibleCreditCardAccount({ name: 'Visa debit card' }), false);
  assert.equal(isPossibleCreditCardAccount({ name: 'EBL Account' }), false);
});

test('a duplicated ledger for one EMI payment is flagged with critical severity', () => {
  const r = audit({ ledgerEntries: [ledger, { ...ledger, _id: 'l2' }] });
  assert.equal(r.byCode.duplicate_ledger, 1);
  assert.ok(r.severitySummary.critical > 0);
});

test('plan grouping retains issues and sums without changing input', () => {
  const before = JSON.stringify([plan, paid, tx, ledger, split]);
  const r = audit({ asOfMonth: '2026-10' });
  assert.equal(r.planSummaries[0].planId, 'p1');
  assert.equal(r.planSummaries[0].issueCount, 1);
  assert.equal(JSON.stringify([plan, paid, tx, ledger, split]), before);
  assert.equal(r.readOnly, true);
  assert.throws(() => audit({ asOfMonth: '2026-99' }), /Invalid reconciliation month/);
});

test('payment and ledger evidence linked to a different installment is not verified', () => {
  const r = audit({ transactions: [{ ...tx, sourceId: 'i2' }] });
  assert.equal(r.byCode.wrong_transaction_source, 1);
  assert.equal(r.planSummaries[0].verifiedLinkedAmount, 0);
});
