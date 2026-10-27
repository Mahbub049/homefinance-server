import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEmiRecords } from '../src/utils/emiIntegrity.js';

const fid = 'p1';
const plan = { _id:fid, totalPayable:1000, status:'active', productName:'Chair' };
const inst = { _id:'i1', planId:fid, month:'2026-10', amount:500, status:'paid', transactionId:'t1', ledgerEntryId:'l1' };
const tx = { _id:'t1', sourceId:'i1', amount:500 };
const ledger = { _id:'l1', sourceType:'transaction', sourceId:'t1', amountTotal:500 };
const split = [{ ledgerEntryId:'l1', userId:'user1', shareAmount:250 },{ ledgerEntryId:'l1', userId:'user2', shareAmount:250 }];
const inspect = (overrides={}) => auditEmiRecords({plans:[plan],installments:[inst],transactions:[tx],ledgerEntries:[ledger],splits:split,...overrides});

test('consistent paid installment passes read-only audit', () => assert.equal(inspect().issueCount,0));
test('missing paid transaction is reported', () => assert.ok(inspect({transactions:[]}).byCode.paid_missing_transaction));
test('misallocated split is reported', () => assert.ok(inspect({splits:[{ledgerEntryId:'l1',shareAmount:400}]}).byCode.split_mismatch));
test('closed plan with unpaid balance is flagged', () => assert.ok(inspect({plans:[{...plan,status:'closed'}]}).byCode.closed_with_balance));
test('fully-paid open plan is flagged', () => assert.ok(inspect({plans:[{...plan,totalPayable:500}]}).byCode.fully_paid_active));
test('pending installment with linked payment is flagged', () => assert.ok(inspect({installments:[{...inst,status:'pending'}]}).byCode.pending_with_payment));
test('orphaned transaction is flagged', () => assert.ok(inspect({installments:[]}).byCode.orphan_transaction));
test('double source payments are flagged', () => assert.ok(inspect({transactions:[tx,{...tx,_id:'t2'}]}).byCode.duplicate_transaction));
test('report never mutates input data', () => {
  const original=JSON.stringify(inst); inspect(); assert.equal(JSON.stringify(inst),original);
});
