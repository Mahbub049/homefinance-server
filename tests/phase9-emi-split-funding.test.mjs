import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmiPaymentFunding, parseEmiPaymentDate } from '../src/utils/emiPaymentFunding.js';
const familyMembers = [
  {userId:{_id:'person1',name:'Mahbub Sarwar'}},
  {userId:{_id:'person2',name:'Jannatul Ferdous Mirza'}},
];
const accounts = [
  {_id:'bank1',name:'EBL Account',type:'bank',owner:'Mahbub',isActive:true},
  {_id:'bank2',name:'TBL Account',type:'bank',owner:'Mirza',isActive:true},
  {_id:'bank3',name:'Joint Bank',type:'bank',owner:'Joint',isActive:true},
  {_id:'dps',name:'DPS',type:'savings',owner:'Mahbub',isActive:true},
];
const base = {familyMembers,accounts,totalAmount:3404};
const split = {paymentMode:'split',paymentParts:[
  {userId:'person1',accountId:'bank1',amount:1702},
  {userId:'person2',accountId:'bank2',amount:1702},
]};
test('single payment remains supported',()=>{
 const p=normalizeEmiPaymentFunding({...base,paidByUserId:'person1',fromAccountId:'bank1'});
 assert.equal(p.paymentMode,'single');assert.equal(p.fromAccountId,'bank1');assert.equal(p.paymentParts[0].amount,3404);
});
test('two member split represents exactly one EMI expense',()=>{
 const p=normalizeEmiPaymentFunding({...base,...split});
 assert.equal(p.paymentMode,'split');assert.equal(p.paidByUserId,null);
 assert.equal(p.fromAccountId,null);assert.deepEqual(p.paymentParts.map(x=>x.amount),[1702,1702]);
});
test('unequal split is valid and sums to installment',()=>{
 const p=normalizeEmiPaymentFunding({...base,...split,paymentParts:[{userId:'person1',accountId:'bank1',amount:2104},{userId:'person2',accountId:'bank2',amount:1300}]});
 assert.equal(p.paymentParts.reduce((t,x)=>t+x.amount,0),3404);
});
test('rejects underpay and overpay',()=>{
 for(const b of [1701,1703]) assert.throws(()=>normalizeEmiPaymentFunding({...base,...split,paymentParts:[split.paymentParts[0],{...split.paymentParts[1],amount:b}]}),/সমান/);
});
test('rejects a payer using another member account',()=>{
 assert.throws(()=>normalizeEmiPaymentFunding({...base,...split,paymentParts:[{userId:'person1',accountId:'bank2',amount:1702},{userId:'person2',accountId:'bank1',amount:1702}]}),/নয়/);
});
test('rejects duplicate member or duplicate account funding',()=>{
 assert.throws(()=>normalizeEmiPaymentFunding({...base,...split,paymentParts:[{userId:'person1',accountId:'bank1',amount:1702},{userId:'person1',accountId:'bank3',amount:1702}]}),/একজন/);
 assert.throws(()=>normalizeEmiPaymentFunding({...base,...split,paymentParts:[{userId:'person1',accountId:'bank3',amount:1702},{userId:'person2',accountId:'bank3',amount:1702}]}),/একই অ্যাকাউন্ট/);
});
test('rejects savings account or more than 2-decimal amounts',()=>{
 assert.throws(()=>normalizeEmiPaymentFunding({...base,paidByUserId:'person1',fromAccountId:'dps'}),/নগদ/);
 assert.throws(()=>normalizeEmiPaymentFunding({...base,...split,paymentParts:[{userId:'person1',accountId:'bank1',amount:1702.001},{userId:'person2',accountId:'bank2',amount:1701.999}]}),/দশমিক/);
});
test('payment date is parsed without changing the calendar day',()=>{
 assert.equal(parseEmiPaymentDate('2026-10-30').toISOString().slice(0,10),'2026-10-30');
 assert.throws(()=>parseEmiPaymentDate('2026-02-30'),/তারিখ/);
 assert.throws(()=>parseEmiPaymentDate('not-a-date'),/তারিখ/);
});
