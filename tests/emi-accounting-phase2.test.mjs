import test from 'node:test';
import assert from 'node:assert/strict';
import { newPlanRegularAmount, regularAmount, amountForIndex, validatePlanSplit, splitInstallment, summarizeEmiDues } from '../src/utils/emiAccounting.js';

const a = '000000000000000000000001';
const b = '000000000000000000000002';
const p = (patch = {}) => ({ _id: '000000000000000000000003', productName: 'Test EMI', months: 3, startMonth: '2026-08', totalPayable: 1000.20, monthlyAmount: 334, splitType: 'fixed', fixed: [{userId:a,amount:167},{userId:b,amount:167}], ...patch });

test('legacy plan keeps its original schedule; last is adjusted', () => {
  assert.equal(regularAmount(p()), 334);
  assert.deepEqual([0,1,2].map(i=>amountForIndex(p(),i)), [334,334,332.20]);
});
test('new plans distribute exact cents and never produce negative final installment', () => {
  assert.equal(newPlanRegularAmount(1000.20,3), 333.40);
  assert.throws(() => newPlanRegularAmount(.03,12), /too small/);
  const small = p({totalPayable:.12, months:12, monthlyAmount:.01});
  assert.equal(amountForIndex(small,11), .01);
});
test('fixed split of final adjusted installment remains exactly balanced', () => {
  const shares = splitInstallment(p(),332.20,[a,b]);
  assert.deepEqual(shares.map(s=>s.shareAmount),[166.10,166.10]);
  assert.equal(shares.reduce((sum,s)=>sum+s.shareAmount,0),332.20);
});
test('unequal fixed split stays proportional in final period', () => {
  const plan = p({fixed:[{userId:a,amount:200},{userId:b,amount:134}]});
  const shares = splitInstallment(plan, 332.20,[a,b]);
  assert.equal(Math.round(shares.reduce((sum,s)=>sum+s.shareAmount,0)*100),33220);
  assert.ok(shares[0].shareAmount > shares[1].shareAmount);
});
test('fixed amounts validated against regular installment, not last installment', () => {
  assert.doesNotThrow(()=>validatePlanSplit(p(),[a,b],334));
  assert.throws(()=>validatePlanSplit(p({fixed:[{userId:a,amount:166},{userId:b,amount:167}]}),[a,b],334),/add up/);
});
test('invalid member, duplicate member, bad ratio are rejected before recording payment', () => {
  assert.throws(()=>validatePlanSplit(p({fixed:[{userId:a,amount:167},{userId:a,amount:167}]}),[a,b],334),/duplicate/);
  assert.throws(()=>validatePlanSplit({splitType:'personal',personalUserId:'wrong'},[a,b],334),/valid family/);
  assert.throws(()=>validatePlanSplit({splitType:'ratio',ratios:[{userId:a,ratio:60},{userId:b,ratio:30}]},[a,b],334),/100/);
});
test('regular and final installments sum to total payable', () => {
  for (let months of [1,3,6,9,12,18,24,36]) {
    const totalPayable = 47126.53;
    const monthlyAmount = newPlanRegularAmount(totalPayable, months);
    const plan = p({months,totalPayable,monthlyAmount});
    assert.equal(Math.round(Array.from({length:months},(_,i)=>amountForIndex(plan,i)).reduce((x,y)=>x+y,0)*100), Math.round(totalPayable*100));
  }
});
test('past unpaid EMI includes ungenerated bills; future bills excluded', () => {
  const summary = summarizeEmiDues([p()],[], '2026-09');
  assert.equal(summary.dueThrough, 668);
  assert.equal(summary.unpaidThrough, 668);
  assert.equal(summary.overdue, 334);
  assert.equal(summary.entries.length,2);
});
test('past paid installments clear due when paid by selected month',()=>{
  const inst = [{planId:p()._id,month:'2026-08',status:'paid',paidAt:'2026-08-21T00:00:00Z'}];
  const summary = summarizeEmiDues([p()],inst,'2026-09');
  assert.equal(summary.unpaidThrough,334);
  assert.equal(summary.overdue,0);
});
test('future-dated payment does not change historic as-of arrears',()=>{
  const inst = [{planId:p()._id,month:'2026-08',status:'paid',paidAt:'2026-10-21T00:00:00Z'}];
  const september = summarizeEmiDues([p()],inst,'2026-09');
  assert.equal(september.unpaidThrough,668);
  assert.equal(september.overdue,334);
  const october = summarizeEmiDues([p()],inst,'2026-10');
  assert.equal(october.unpaidThrough,666.20);
});
