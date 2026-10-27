import test from 'node:test';
import assert from 'node:assert/strict';
import { expensePayments, validatePaymentAllocation, reconcileLedgerMembers } from '../src/utils/ledgerReconciliation.js';

const M = 'mahbub', F = 'mim';
const members = [{ userId: M, name: 'Mahbub' }, { userId: F, name: 'Mim' }];
const entry = (amount, shares, opt = {}) => ({
  _id: 'ledger1', entryType: 'expense', sourceType: 'transaction', sourceId: 'tx1',
  amountTotal: amount, splits: shares.map(([userId,shareAmount]) => ({userId, shareAmount})), ...opt
});
const tx = (amount, parts = []) => ({
  _id: 'tx1', txType: 'expense', amount, paymentMode: parts.length ? 'split' : 'single',
  paidByUserId: parts.length ? null : M, fromAccountId: parts.length ? null : 'a',
  paymentParts: parts,
});
const reconcile = (entries, transactions) => reconcileLedgerMembers({ members, entries, transactions });

test('split bill 30+30 funding with 30+30 cost share owes zero', () => {
  const data = reconcile([entry(60, [[M,30],[F,30]])], [tx(60,[
    { userId:M, accountId:'bank1',amount:30 }, { userId:F, accountId:'bank2',amount:30 }
  ])]);
  assert.equal(data.paidTotal,60);
  assert.equal(data.allocatedTotal,60);
  assert.equal(data.ordinarySettlementSum,0);
  assert.deepEqual(data.rows.map(x=>x.ordinarySettlementNet),[0,0]);
  assert.deepEqual(data.issues,[]);
});
test('one payer shared 60: payer receives 30 and other owes 30', () => {
  const data = reconcile([entry(60, [[M,30],[F,30]])],[tx(60)]);
  assert.deepEqual(data.rows.map(x=>x.ordinarySettlementNet),[30,-30]);
  assert.equal(data.ordinarySettlementSum,0);
});
test('fixed 50.01+50.00 cost and exact split payments preserve cents', () => {
  const data = reconcile([entry(100.01, [[M,50.01],[F,50]])], [tx(100.01,[
    {userId:M,accountId:'a',amount:50.01}, {userId:F,accountId:'b',amount:50}
  ])]);
  assert.equal(data.ordinarySettlementSum,0);
  assert.deepEqual(data.issues,[]);
});
test('scheduled large purchase is budget-only, not an ordinary expense or cash payer', () => {
  const data = reconcile([entry(4625, [[M,4625]], {virtual:true,affectsSettlement:false})],[]);
  assert.equal(data.paidTotal,0);assert.equal(data.allocatedTotal,0);assert.equal(data.ordinarySettlementSum,0);
});
test('reimbursement transfer is not counted as an extra household expense', () => {
  const data = reconcile([entry(60,[[M,30],[F,30]])],[tx(60),{_id:'r',txType:'transfer',amount:30}]);
  assert.equal(data.paidTotal,60);assert.equal(data.ordinarySettlementSum,0);
});
test('cash outflow missing a linked ledger is flagged instead of silently counted', () => {
  const data = reconcile([], [tx(60)]);
  assert.equal(data.paidTotal,0);
  assert.ok(data.issues.some(x=>x.code==='UNLINKED_EXPENSE'));
});
test('expense split mismatches create explicit reconciliation issues', () => {
  const data = reconcile([entry(60,[[M,30],[F,20]])],[tx(60)]);
  assert.ok(data.issues.some(x=>x.code==='SPLIT_TOTAL_MISMATCH'));
  assert.ok(data.issues.some(x=>x.code==='CASH_VS_SHARE_GAP'));
});
test('payment part must have account/member and sum to total', () => {
  assert.deepEqual(validatePaymentAllocation(tx(60,[{userId:M,accountId:'a',amount:30}])).issues,['PAYMENT_TOTAL_MISMATCH']);
  assert.ok(validatePaymentAllocation(tx(60,[{userId:M,amount:60}])).issues.includes('INVALID_PAYMENT_PART'));
});
test('single payer funding is not duplicated by embedded paymentParts', () => {
  const one = {...tx(60),paymentParts:[{userId:M,accountId:'a',amount:60}]};
  assert.equal(expensePayments(one).length,1);
});
test('managed EMI and upfront large purchases excluded when settlementImpact disabled', () => {
  const data = reconcile([], [{...tx(74000),sourceType:'shared_purchase_upfront',budgetImpact:false}]);
  assert.equal(data.paidTotal,0);
});
