import test from "node:test";
import assert from "node:assert/strict";
import { buildSharedBudgetView } from "../src/utils/sharedBudgetMath.js";

const month = "2026-10";
const purchases = [
  {_id:"air", title:"Air Conditioner", categoryId:"category", payerUserId:"mim"},
  {_id:"phone", title:"Xiaomi 17T", categoryId:"category", payerUserId:"mah"},
];
const installments = [
  {_id:"ac-mah", purchaseId:"air", userId:"mah", month, dueDate:"2026-10-07", amount:4625, paymentRequired:true, status:"pending"},
  {_id:"ac-mim", purchaseId:"air", userId:"mim", month, dueDate:"2026-10-07", amount:4625, paymentRequired:false, status:"allocated"},
  {_id:"phone-mah", purchaseId:"phone", userId:"mah", month, dueDate:"2026-10-06", amount:3333.33, paymentRequired:false, status:"allocated"},
];
const posted = [
  {_id:"living",entryType:"expense",financialType:"living",amountTotal:10000,sourceType:"transaction"},
  {_id:"income",entryType:"income",financialType:"income",amountTotal:131090,sourceType:"transaction"},
  {_id:"ac-payer-posted",entryType:"expense",financialType:"debt",amountTotal:4625,sourceType:"shared_purchase_installment"},
  {_id:"phone-posted",entryType:"expense",financialType:"debt",amountTotal:3333.33,module:"shared_purchase"},
];
const view=(rows=installments, entries=posted)=>buildSharedBudgetView({month, ledgerEntries:entries, installments:rows,purchases});

test("October allocation combines 9250 AC and 3333.33 phone regardless of payment",()=>{
  const r=view();
  assert.equal(r.summary.scheduledLargePurchaseAllocation,12583.33);
  assert.equal(r.summary.allBudgetExpenses,22583.33);
  assert.equal(r.summary.byMember.mah,7958.33);
  assert.equal(r.summary.byMember.mim,4625);
});
test("Legacy posted installment ledger expense is replaced, not double counted",()=>{
  const r=view();
  assert.equal(r.summary.legacySharedPostedExcluded,7958.33);
  assert.equal(r.summary.changeFromPostedLedger,4625);
  assert.equal(r.entries.filter(e=>e.isBudgetAllocation).length,3);
  assert.equal(r.entries.filter(e=>e.sourceType==='shared_purchase_installment').length,0);
});
test("Repayment on same month does not add another budget expense",()=>{
  const rows=installments.map(e=> e._id==='ac-mah'?{...e,status:'paid'}:e);
  const paidPosted={_id:'paid-ledger',entryType:'expense',amountTotal:4625,sourceType:'shared_purchase_installment'};
  assert.equal(view(rows,[...posted,paidPosted]).summary.allBudgetExpenses,22583.33);
});
test("Each synthetic installment has one member share, no real cash payer",()=>{
  const r=view();
  for(const row of r.virtualRows){
    assert.equal(row.affectsSettlement,false);
    assert.equal(row.paidByUserId,null);
    assert.equal(row.splits.length,1);
    assert.equal(row.splits[0].shareAmount,row.amountTotal);
  }
});
test("Invalid orphan schedule reports warning instead of phantom expense",()=>{
  const bad=[...installments,{_id:'bad',purchaseId:'nonexistent',month,amount:4625,userId:'mah'}];
  const r=view(bad);
  assert.equal(r.summary.allBudgetExpenses,22583.33);
  assert.equal(r.summary.issues.length,1);
});
test("No schedules does not change ordinary ledger spending",()=>{
  const r=view([], [{_id:'r',entryType:'expense',amountTotal:9980,module:'manual'}]);
  assert.equal(r.summary.allBudgetExpenses,9980);
  assert.equal(r.summary.scheduledLargePurchaseAllocation,0);
});

import { idString } from "../src/utils/sharedPurchaseSchedule.js";
test("BSON-like ids use printable hex representation rather than raw .id bytes",()=>{
  const hex="507f1f77bcf86cd799439011";
  const objectId={toHexString:()=>hex,id:Buffer.alloc(12,0x01)};
  assert.equal(idString(objectId),hex);
  assert.equal(idString({_id:objectId}),hex);
});
