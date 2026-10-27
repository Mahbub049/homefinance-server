import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrackedBalances, summarizeRegisteredEmiBalance, assemblePosition } from '../src/utils/financialPosition.js';
const acc = (name, type, balance) => ({ name, type, balance });
test('cash and savings included exactly once, including closed/inactive accounts supplied by reconciled snapshot', () => {
  const a = classifyTrackedBalances([acc('Cash', 'cash', 2000), acc('Bank', 'bank', 8000), acc('DPS', 'savings', 5000), acc('Fund', 'investment', 1500)]);
  assert.equal(a.liquidCash, 10000); assert.equal(a.savingsAndInvestments, 6500); assert.equal(a.trackedAccountTotal, 16500);
});
test('credit-card-looking bank account quarantined instead of counted as verified cash or invented liability', () => {
  const a = classifyTrackedBalances([acc('EBL', 'bank', 5000), acc('One Bank Credit Card', 'bank', -20000)]);
  assert.equal(a.liquidCash, 5000); assert.equal(a.cardReviewCount, 1); assert.equal(a.cardReviewRecordedBalance, -20000);
});
test('negative bank balances remain visible rather than silently floored at zero', () => {
  const a = classifyTrackedBalances([acc('Wallet', 'wallet', 200), acc('EBL', 'bank', -350)]);
  assert.equal(a.liquidCash, -150); assert.equal(a.negativeLiquidCount, 1);
});
test('paid future installments are excluded from earlier month', () => {
  const plans = [{_id:'1',status:'active',startMonth:'2026-08',totalPayable:10000}];
  const pays = [{planId:'1',status:'paid',amount:2500,month:'2026-09',paidAt:'2026-09-12'}, {planId:'1',status:'paid',amount:2500,month:'2026-10',paidAt:'2026-11-01'}];
  const out = summarizeRegisteredEmiBalance(plans,pays,'2026-10');
  assert.equal(out.remainingEMI,7500);
});
test('future EMI plans not included before they start', () => {
  const out = summarizeRegisteredEmiBalance([{_id:'a',status:'active',startMonth:'2026-11',totalPayable:15000}], [], '2026-10');
  assert.equal(out.remainingEMI,0);
});
test('closed legacy EMI not reopened as active liability', () => {
  const out = summarizeRegisteredEmiBalance([{_id:'1',status:'closed',startMonth:'2026-01',totalPayable:5000}], [], '2026-10');
  assert.equal(out.remainingEMI,0); assert.equal(out.closedPlansNeedingReview,1);
});
test('position reports never mislabel provisional tracking as verified net worth', () => {
  const result = assemblePosition([acc('Bank','bank',500),acc('DPS','savings',1000)], {remainingEMI:200,totalPaidActive:0}, {closed:false,issues:[]});
  assert.equal(result.position.trackedAccountTotal,1500);
  assert.equal(result.position.afterRegisteredEMIIllustration,1300);
  assert.equal(result.netWorth,null); assert.equal(result.status,'provisional');
});
test('savings transfer does not get added again from ledger investments', () => {
  const a = classifyTrackedBalances([acc('Bank','bank',400),acc('DPS','savings',100)]);
  assert.equal(a.trackedAccountTotal,500);
});
