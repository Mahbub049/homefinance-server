import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  FIRST_EDITABLE_PURCHASE_MONTH, ensureEditablePurchaseMonth,
  requireLiquidPurchaseAccount, requirePendingInstallmentForPayment,
  requireSafePlanRemoval, requireLinkedDocument,
} from '../src/utils/sharedPurchaseSafety.js';

const source = readFileSync(new URL('../src/routes/sharedPurchase.route.js', import.meta.url), 'utf8');
const clientPath = new URL('../../client/src/pages/SharedPurchases.jsx', import.meta.url);
const client = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : null;

test('historical month safety starts with October 2026', () => {
  assert.equal(FIRST_EDITABLE_PURCHASE_MONTH, '2026-10');
  assert.equal(ensureEditablePurchaseMonth('2026-10'), '2026-10');
  assert.throws(() => ensureEditablePurchaseMonth('2026-09'), { status: 409 });
  assert.throws(() => ensureEditablePurchaseMonth('2026-13'), { status: 400 });
});

test('purchase and repayment may use only active liquid accounts', () => {
  for (const type of ['cash', 'bank', 'wallet']) {
    assert.equal(requireLiquidPurchaseAccount({ type, isActive: true }).type, type);
  }
  for (const type of ['savings', 'investment']) {
    assert.throws(() => requireLiquidPurchaseAccount({ type, isActive: true }), { status: 400 });
  }
  assert.throws(() => requireLiquidPurchaseAccount({ type: 'cash', isActive: false }), { status: 400 });
  assert.throws(() => requireLiquidPurchaseAccount({ name: 'One Bank Credit Card', type: 'bank', isActive: true }), { status: 400 });
});

test('already-paid or partial legacy repayment cannot be posted twice', () => {
  assert.equal(requirePendingInstallmentForPayment({ status: 'pending', paymentRequired: true }).status, 'pending');
  for (const extra of [
    { status: 'paid' },
    { paymentTransactionId: 'tx' },
    { ledgerEntryId: 'ledger' },
    { paidAt: new Date() },
  ]) {
    assert.throws(() => requirePendingInstallmentForPayment({ status: 'pending', paymentRequired: true, ...extra }), { status: 409 });
  }
  assert.throws(() => requirePendingInstallmentForPayment({ paymentRequired: false, status: 'allocated' }), { status: 400 });
});

test('purchase deletion cannot remove reimbursements or older installments', () => {
  const purchase = { startMonth: '2026-10' };
  assert.doesNotThrow(() => requireSafePlanRemoval(purchase, [
    { month: '2026-10', paymentRequired: true, status: 'pending' },
    { month: '2026-11', paymentRequired: false, status: 'allocated', ledgerEntryId: 'ledger-2' },
  ]));
  assert.throws(() => requireSafePlanRemoval(purchase, [{ month: '2026-10', status: 'paid', paymentRequired: true }]), { status: 409 });
  assert.throws(() => requireSafePlanRemoval(purchase, [{ month: '2026-09', status: 'pending', paymentRequired: true }]), { status: 409 });
  assert.throws(() => requireSafePlanRemoval(purchase, [{ month: '2026-10', status: 'pending', ledgerEntryId: 'legacy', paymentRequired: true }]), { status: 409 });
});

test('linked source identity is checked before deleting financial records', () => {
  assert.doesNotThrow(() => requireLinkedDocument({ sourceType: 'shared_purchase', sourceId: 'p', amount: 74000 }, {
    sourceType: 'shared_purchase', sourceId: 'p', amount: 74000,
  }));
  assert.throws(() => requireLinkedDocument({ sourceType: 'manual', sourceId: 'p' }, { sourceType: 'shared_purchase', sourceId: 'p' }), { status: 409 });
  assert.throws(() => requireLinkedDocument(null, { sourceType: 'shared_purchase', sourceId: 'p' }), { status: 409 });
});

test('GET shared purchase list has no clean-up or write operations', () => {
  const getSource = source.split('router.get("/",')[1]?.split('router.post("/",')[0] || '';
  assert.ok(getSource.length > 0);
  assert.doesNotMatch(getSource, /cleanupPendingInstallmentLedgers|\.create\(|\.save\(|\.updateOne\(|\.deleteOne\(|\.deleteMany\(|\.bulkWrite\(/);
});

test('all financial purchase mutators are transactional and create/pay are idempotent', () => {
  assert.match(source, /createIdempotentFinancialPosting\(req, 'sharedPurchase\.create'/);
  assert.match(source, /createIdempotentFinancialPosting\(req, 'sharedPurchase\.pay'/);
  const deletions = source.split("router.delete('/:purchaseId/installments")[1] || '';
  assert.match(deletions, /runAtomicPosting\(async \(\) =>/);
  assert.match(source, /modifiedCount !== 1/);
  if (client !== null) assert.match(client, /'Idempotency-Key'/);
});
