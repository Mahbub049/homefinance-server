import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculateAccountPeriod } from '../src/utils/reconciledAccountMath.js';
import { calculateMonthlyLiquidFlow } from '../src/utils/monthlyLiquidFlow.js';
import { reconcileWalletMonth } from '../src/utils/walletReconciliation.js';
import { calculateOrdinaryExpenseShares } from '../src/utils/expenseFunding.js';

const accounts = [
  { _id: 'ma', name: 'Mahbub Bank', owner: 'Mahbub', type: 'bank', openingBalance: 1000 },
  { _id: 'mi', name: 'Mim Bank', owner: 'Mirza', type: 'bank', openingBalance: 2000 },
  { _id: 'dps', name: 'DPS', owner: 'Mahbub', type: 'savings', openingBalance: 0 },
];
const transactions = [
  { _id:'income', txType: 'income', amount: 60000, toAccountId: 'ma' },
  { _id:'rickshaw', txType: 'expense', amount: 60, paymentMode: 'split', paymentParts: [
    { userId: 'mah', accountId: 'ma', amount: 30 }, { userId: 'mim', accountId: 'mi', amount: 30 },
  ] },
  { _id:'savings', txType: 'transfer', amount: 10000, fromAccountId: 'ma', toAccountId: 'dps' },
  { _id:'reimbursement', txType: 'transfer', amount: 4625, fromAccountId: 'ma', toAccountId: 'mi' },
];
function build({ txs = transactions, opening = accounts, issues = [], users = [
  { expenseNet: 0, net: 0 }, { expenseNet: 0, net: 0 },
], summaries = [{ pendingPay: 0, pendingReceive: 0 }, { pendingPay: 0, pendingReceive: 0 }], settlements = [], verifiedSettlementIds = [], recordedIncome = 60000 } = {}) {
  const period = calculateAccountPeriod(opening, null, txs);
  const flow = calculateMonthlyLiquidFlow(opening, txs);
  const statement = {
    opening: { accounts: opening.map(a => ({ accountId: a._id, owner:a.owner, type:a.type, balance:a.openingBalance })) },
    systemClosing: { accounts: period.accounts },
    closing: { accounts: period.accounts },
    closed: false, issues,
  };
  return reconcileWalletMonth({ month: '2026-10', accountStatement: statement,
    monthlyFlow: flow, users, settlementSummary:summaries, settlements, verifiedSettlementIds,
    expenseIntegrity: { balanced: true, discrepancy: 0 }, recordedIncome });
}
test('split 30+30, DPS 10000 and reimbursement 4625 conserve household cash', () => {
  const r=build();
  assert.equal(r.status, 'internally_consistent');
  assert.equal(r.checks.monthCashMovement, 49940);
  assert.equal(r.checks.openingLiquid, 3000);
  assert.equal(r.checks.calculatedClosingLiquid, 52940);
  assert.equal(r.checks.cashDifference, 0);
});
test('personal cash changes after reimbursement but household total is unchanged', () => {
  const withTransfer=calculateMonthlyLiquidFlow(accounts, transactions);
  const withoutTransfer=calculateMonthlyLiquidFlow(accounts, transactions.filter(t=>t._id!=='reimbursement'));
  assert.equal(withTransfer.household.remainingFromMonth, withoutTransfer.household.remainingFromMonth);
  assert.equal(withTransfer.byOwner.Mahbub.remainingFromMonth - withoutTransfer.byOwner.Mahbub.remainingFromMonth, -4625);
  assert.equal(withTransfer.byOwner.Mirza.remainingFromMonth - withoutTransfer.byOwner.Mirza.remainingFromMonth, 4625);
});
test('account mismatch causes a blocking issue', () => {
  const r=build();
  const after=reconcileWalletMonth({
    month:'2026-10', accountStatement:{
      opening:{accounts:[{ accountId:'ma',owner:'Mahbub',type:'bank',balance:1000}]},
      systemClosing:{accounts:[{ accountId:'ma',owner:'Mahbub',type:'bank',balance:1200}]},
      closing:{accounts:[{ accountId:'ma',owner:'Mahbub',type:'bank',balance:1200}]},
      issues: [],
    }, monthlyFlow:{household:{remainingFromMonth:300},byOwner:{Mahbub:{remainingFromMonth:300}},issues:[]},
    users: [],settlementSummary:[],settlements:[], verifiedSettlementIds:[] });
  assert.equal(after.status,'needs_correction');
  assert.equal(after.checks.cashDifference,-100);
  assert.ok(after.issues.some(i=>i.code==='ACCOUNT_VS_MONTH_FLOW'));
  assert.equal(r.status,'internally_consistent');
});
test('negative account warning is advisory, not bank verification', () => {
  const r=build({opening:accounts.map(a=>a._id==='mi'?{...a,openingBalance:-50000}:a)});
  assert.equal(r.status,'needs_review');
  assert.ok(r.issues.some(i=>i.code==='NEGATIVE_ACCOUNT_BALANCE'));
});
test('missing settlement-linked transfer blocks reconciliation', () => {
  const r=build({settlements:[{_id:'sett1', settlementType:'wallet',status:'settled',transactionId:'missing'}]});
  assert.equal(r.status, 'needs_correction');
  assert.ok(r.issues.some(i=>i.code==='UNVERIFIED_WALLET_SETTLEMENT'));
});
test('verified Wallet settlement is accepted, and duplicate use of same transfer is detected', () => {
  const ok=build({settlements:[{_id:'a',settlementType:'wallet',status:'settled',transactionId:'t1'}],verifiedSettlementIds:['a']});
  assert.equal(ok.status, 'internally_consistent');
  const bad=build({settlements:[{_id:'a',settlementType:'wallet',status:'settled',transactionId:'t1'},
    {_id:'b',settlementType:'wallet',status:'settled',transactionId:'t1'}],verifiedSettlementIds:['a','b']});
  assert.ok(bad.issues.some(i=>i.code==='DUPLICATE_SETTLEMENT_TRANSFER'));
});
test('zero sum is enforced for ordinary and final settlements', () => {
  const r=build({users:[{expenseNet:-50,net:-50},{expenseNet:20,net:20}]});
  assert.ok(r.issues.some(i=>i.code==='ORDINARY_SETTLEMENT_NOT_ZERO_SUM'));
  assert.ok(r.issues.some(i=>i.code==='FINAL_SETTLEMENT_NOT_ZERO_SUM'));
});
test('payable and receivable must balance', () => {
  const r=build({summaries:[{pendingPay:30,pendingReceive:0},{pendingPay:0,pendingReceive:29}]});
  assert.equal(r.status,'needs_correction');
  assert.ok(r.issues.some(i=>i.code==='SETTLEMENT_DIRECTIONS_MISMATCH'));
});
test('missing cash link or split shows account error without rewriting data', () => {
  const broken=[{_id:'broken',txType:'expense',amount:60,paymentMode:'split', paymentParts:[{accountId:'ma',amount:20}]}];
  const r=build({txs:broken,recordedIncome:0});
  assert.equal(r.status,'needs_correction');
  assert.ok(r.issues.some(i=>i.code==='INVALID_SPLIT_FUNDING'));
});
test('manual close adjustment is disclosed but does not rewrite earlier history', () => {
  const period=calculateAccountPeriod(accounts,null,transactions);
  const flow=calculateMonthlyLiquidFlow(accounts,transactions);
  const data={month:'2026-10',accountStatement:{
    opening:{accounts:accounts.map(a=>({accountId:a._id,type:a.type,owner:a.owner,balance:a.openingBalance}))},
    systemClosing:{accounts:period.accounts},
    closing:{accounts:period.accounts.map(a=>a.accountId==='ma'?{...a,balance:a.balance+10}:a)},closed:true,issues:[],
  },monthlyFlow:flow,users:[],settlementSummary:[],settlements:[],verifiedSettlementIds:[]};
  const r=reconcileWalletMonth(data);
  assert.equal(r.status,'needs_review');
  assert.ok(r.issues.some(i=>i.code==='MANUAL_CLOSING_DIFFERENCE'));
});
test('split funding 30+30 and shares 30+30 have no settlement', () => {
  const r=calculateOrdinaryExpenseShares({
    entries:[{_id:'ledger1',entryType:'expense',sourceType:'transaction',sourceId:'rickshaw',amountTotal:60}],
    transactions:[transactions.find(t=>t._id==='rickshaw')],
    splits:[{ledgerEntryId:'ledger1',userId:'mah',shareAmount:30},{ledgerEntryId:'ledger1',userId:'mim',shareAmount:30}],
    userIds:['mah','mim'],
  });
  assert.equal(r.balanced,true); assert.equal(r.paidMap.mah-r.shareMap.mah,0);
  assert.equal(r.paidMap.mim-r.shareMap.mim,0);
});
test('Wallet GET does not auto-delete old installments; writes are atomic and idempotent', () => {
  const route=fs.readFileSync(new URL('../src/routes/wallet.route.js',import.meta.url),'utf8');
  const get=route.slice(route.indexOf('router.get("/summary"'),route.indexOf('router.post("/settlements"'));
  assert.ok(!get.includes('cleanupPendingInstallmentLedgers('));
  assert.ok(route.includes("createIdempotentFinancialPosting(req, op"));
  assert.ok(route.includes('await Family.updateOne('));
  assert.ok(route.includes('await runAtomicPosting('));
  assert.ok(route.includes("month < '2026-10'"));
});
test('closed month guard checks historical closingBalance as well as closedAt', () => {
  const source=fs.readFileSync(new URL('../src/utils/postingPreflight.js',import.meta.url),'utf8');
  assert.ok(source.includes('closingBalance: { $ne: null }'));
  assert.ok(source.includes('closedAt: { $ne: null }'));
});
test('balanced payer-vs-share totals must not hide an underfunded source transaction', () => {
  const r=calculateOrdinaryExpenseShares({
    entries:[{_id:'ledger_bad',entryType:'expense',sourceType:'transaction',sourceId:'txbad',amountTotal:60}],
    transactions:[{_id:'txbad',txType:'expense',paymentMode:'split',amount:60,
      paymentParts:[{userId:'mah',accountId:'ma',amount:15},{userId:'mim',accountId:'mi',amount:15}]}],
    splits:[{ledgerEntryId:'ledger_bad',userId:'mah',shareAmount:15},{ledgerEntryId:'ledger_bad',userId:'mim',shareAmount:15}],
    userIds:['mah','mim'],
  });
  assert.equal(r.paidTotal,r.shareTotal);
  assert.equal(r.balanced,false);
  assert.ok(r.issues.some(i=>i.code==='LEDGER_SHARE_TOTAL_MISMATCH'));
  assert.ok(r.issues.some(i=>i.code==='EXPENSE_FUNDING_MISMATCH'));
});
test('missing linked expense transaction is flagged instead of inventing a payer', () => {
  const r=calculateOrdinaryExpenseShares({
    entries:[{_id:'ledger_missing',entryType:'expense',sourceType:'transaction',sourceId:'gone',amountTotal:10}],
    transactions:[],splits:[{ledgerEntryId:'ledger_missing',userId:'mah',shareAmount:10}],userIds:['mah'],
  });
  assert.equal(r.paidTotal,0);
  assert.equal(r.balanced,false);
  assert.ok(r.issues.some(i=>i.code==='MISSING_LINKED_EXPENSE_TRANSACTION'));
});
