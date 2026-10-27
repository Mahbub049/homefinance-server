import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEmiDues } from '../src/utils/emiAccounting.js';

const mk = (id, amount, status, splitType = 'equal') => ({
  _id: id, productName: id, months: 12, startMonth: '2026-08',
  totalPayable: amount * 12, monthlyAmount: amount, status, splitType,
});
const active = [
  mk('bed',5584,'active'), mk('phone',5165,'active','personal'),
  mk('wardrobe',2950,'active'), mk('cabinet',3404,'active'),
  mk('table',1746,'active','personal'),
];
const closed = mk('washing-machine',4934,'closed');

test('closed EMI excluded from October scheduled active liability', () => {
  const result = summarizeEmiDues([...active, closed], [], '2026-10');
  assert.equal(result.dueThisMonth, 18849);
  assert.equal(result.excludedClosedThisMonth, 4934);
  assert.equal(result.excludedClosedPlans[0].productName,'washing-machine');
  assert.equal(result.unpaidCount, 15);
  assert.equal(result.entries.some(e => e.planId === 'washing-machine'), false);
});

test('active share calculation for screenshot: 12880 plus 5969 equals 18849', () => {
  const mahbub = 2792+5165+1475+1702+1746;
  const mim = 2792+1475+1702;
  assert.equal(mahbub, 12880);
  assert.equal(mim, 5969);
  assert.equal(mahbub + mim, 18849);
  assert.equal(mahbub+4934/2, 15347);
  assert.equal(mim+4934/2, 8436);
});

test('closed plan remains explicitly visible for historical reconciliation', () => {
  const result = summarizeEmiDues([closed], [], '2026-10');
  assert.equal(result.dueThisMonth, 0);
  assert.equal(result.unpaidThrough, 0);
  assert.equal(result.excludedClosedThisMonth,4934);
  assert.equal(result.excludedClosedPlans[0].unverifiedUnpaidThrough,3*4934);
});

test('recorded paid closed installments not treated as missing historical payments', () => {
  const result = summarizeEmiDues([closed], [
    {planId:'washing-machine', month:'2026-08', status:'paid', paidAt:'2026-08-10T00:00:00.000Z'},
  ], '2026-10');
  assert.equal(result.excludedClosedPlans[0].unverifiedUnpaidThrough,2*4934);
});

test('a previously closed plan restored to active returns to current obligations', () => {
  const result = summarizeEmiDues([{...closed,status:'active'}], [], '2026-10');
  assert.equal(result.dueThisMonth,4934);
  assert.equal(result.excludedClosedThisMonth,0);
});
