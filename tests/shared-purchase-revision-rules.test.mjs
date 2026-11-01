import test from 'node:test';
import assert from 'node:assert/strict';
import {cents,splitCents,futureRemainder,canReviseFuture,isPostedInstallment} from '../src/utils/sharedPurchaseRevisionRules.js';
test('Remainder preserves earlier allocations and totals exactly',()=>{
  const prior=[{amount:4625},{amount:4625},{amount:4625},{amount:4625}];
  const rest=futureRemainder(37000,prior);
  assert.equal(rest,1850000);
  const parts=splitCents(rest,3);
  assert.equal(parts.length,3);
  assert.equal(parts.reduce((s,v)=>s+cents(v),0),1850000);
});
test('40,000 split among 12 months without lost pennies',()=>{
 const parts=splitCents(4000000,12);
 assert.equal(parts.length,12);assert.equal(parts.reduce((s,v)=>s+cents(v),0),4000000);
});
test('Cannot replan paid installments or linked reimbursement history',()=>{
 for(const it of [{status:'paid'},{status:'pending',paymentTransactionId:'x'},{status:'pending',paidAt:new Date()},{paymentRequired:true,ledgerEntryId:'legacy'}]){
   assert.equal(canReviseFuture(it),false);
 }
 assert.equal(isPostedInstallment({status:'paid'}),true);
});
test('Own future allocation and pending unpaid reimbursement can be rescheduled',()=>{
 assert.equal(canReviseFuture({paymentRequired:false,status:'allocated',ledgerEntryId:'ownledger'}),true);
 assert.equal(canReviseFuture({paymentRequired:true,status:'pending',ledgerEntryId:null}),true);
});
test('No zero or negative remainder can be reallocated',()=>{
 assert.throws(()=>futureRemainder(4625,[{amount:4625}]),/No positive/);
 assert.throws(()=>splitCents(0,6),/Invalid/);
});
test('Rounding is exact in integer cents',()=>{
 const x=splitCents(10001,3);assert.deepEqual(x,[33.33,33.33,33.35]);
});
