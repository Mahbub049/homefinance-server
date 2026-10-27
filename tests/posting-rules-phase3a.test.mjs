import test from 'node:test';
import assert from 'node:assert/strict';
import { monthOf, validMonth, positiveMoney, nonnegativeMoney,
  memberAccountOwner, ownerAllowed, assertExpenseSplit, assertSavingsAccountTypes } from '../src/utils/postingRules.js';

test('strict YYYY-MM month values', () => {
  assert.equal(validMonth('2026-10'), true);
  assert.equal(validMonth('2026-13'), false);
  assert.equal(validMonth('2026-1'), false);
  assert.equal(validMonth('2026-10x'), false);
});
test('expense date uses actual posting month', () => {
  assert.equal(monthOf(new Date(2026, 9, 27)), '2026-10');
  assert.equal(monthOf('not a date'), null);
});
test('positive money validates precision and rejects infinity', () => {
  assert.equal(positiveMoney('4625'), 4625);
  assert.equal(positiveMoney('13.95'), 13.95);
  assert.throws(() => positiveMoney(Infinity), /finite/);
  assert.throws(() => positiveMoney(0), /greater than zero/);
  assert.throws(() => positiveMoney(12.345), /decimal/);
});
test('nonnegative charge accepts zero but rejects NaN and negatives', () => {
  assert.equal(nonnegativeMoney('', 'Delivery'), 0);
  assert.equal(nonnegativeMoney(0.50, 'Delivery'), .5);
  assert.throws(() => nonnegativeMoney('NaN', 'Delivery'), /nonnegative/);
  assert.throws(() => nonnegativeMoney(-1, 'VAT'), /nonnegative/);
});
test('member ownership resolves known app members', () => {
  assert.equal(memberAccountOwner('Mahbub Sarwar'), 'Mahbub');
  assert.equal(memberAccountOwner('Jannatul Ferdous Mirza'), 'Mirza');
  assert.equal(ownerAllowed('Mahbub', 'Mahbub Sarwar'), true);
  assert.equal(ownerAllowed('Mirza', 'Mahbub Sarwar'), false);
  assert.equal(ownerAllowed('Joint', 'Mahbub Sarwar'), true);
  assert.equal(ownerAllowed('Mahbub', 'Unknown Person'), false);
});
test('fixed expense split must fully match cash expense', () => {
  const rows = [{userId:'a',shareAmount:30},{userId:'b',shareAmount:30}];
  assert.equal(assertExpenseSplit(rows,60,['a','b']),rows);
  assert.throws(() => assertExpenseSplit(rows,70,['a','b']), /total/);
  assert.throws(() => assertExpenseSplit([{userId:'a',shareAmount:60}],60,['b']), /invalid/);
});
test('fractional penny and duplicate user shares are rejected', () => {
  assert.throws(()=>assertExpenseSplit([{userId:'a',shareAmount:12.345}],12.35,['a']),/decimal/);
  assert.throws(()=>assertExpenseSplit([{userId:'a',shareAmount:10},{userId:'a',shareAmount:10}],20,['a']),/duplicate/);
});
test('savings only moves liquid -> savings/investment', () => {
  assert.doesNotThrow(()=>assertSavingsAccountTypes({_id:'1',type:'bank'}, {_id:'2',type:'savings'}));
  assert.doesNotThrow(()=>assertSavingsAccountTypes({_id:'1',type:'wallet'}, {_id:'2',type:'investment'}));
  assert.throws(()=>assertSavingsAccountTypes({_id:'1',type:'savings'}, {_id:'2',type:'bank'}),/source/);
  assert.throws(()=>assertSavingsAccountTypes({_id:'1',type:'cash'}, {_id:'1',type:'savings'}),/different/);
});
