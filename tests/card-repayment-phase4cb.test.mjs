import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCardRepayment, validateCardFunding, activePaymentSummary } from '../src/utils/creditCardPayments.js';
import { calculateMonthlyLiquidFlow } from '../src/utils/monthlyLiquidFlow.js';

const payment = {date:'2026-10-27',month:'2026-10',amount:4625,note:'Receipt #123'};
const options = {today: '2026-10-27'};
const card = {_id:'card',name:'One Bank Credit Card',type:'bank',owner:'Mahbub'};
const bank = {_id:'bank',name:'EBL Bank',type:'bank',owner:'Mahbub',isActive:true};

test('actual payment: valid value preserves two decimal places and posting month', () => {
  const {data,error} = validateCardRepayment({...payment,amount:'4625.25'},options);
  assert.equal(error,undefined); assert.equal(data.month,'2026-10'); assert.equal(data.amount,4625.25);
});
test('rejects invalid dates, future, out-of-period, old historical months', () => {
  for (const change of [{date:'2026-02-30',month:'2026-02'}, {date:'2026-09-20',month:'2026-09'}, {date:'2026-10-28'}, {date:'2026-10-10',month:'2026-11'}]) {
    assert.ok(validateCardRepayment({...payment,...change},options).error);
  }
});
test('rejects zero, negative, fractional cents and NaN amounts', () => {
  for (const amount of ['',0,-1,'2.005','x']) assert.ok(validateCardRepayment({...payment,amount},options).error);
});
test('funding accepts verified card holder bank account', () => {
  assert.equal(validateCardFunding(card, bank), null);
});
test('funding blocks unrelated person and another credit-card account', () => {
  assert.match(validateCardFunding(card, {...bank,owner:'Mirza'}), /card holder/);
  assert.match(validateCardFunding(card, {...bank,name:'Other Credit Card'}), /funding account/);
});
test('funding accepts joint cash account but rejects inactive account', () => {
  assert.equal(validateCardFunding(card, {...bank,type:'cash',owner:'Joint'}),null);
  assert.ok(validateCardFunding(card,{...bank,isActive:false}));
});
test('voided repayments do not count in active monthly totals', () => {
  assert.deepEqual(activePaymentSummary([{amount:4625,status:'posted'}, {amount:100,status:'voided'}, {amount:123.45,status:'posted'}]),{count:2,amount:4748.45});
});
test('card repayment reduces actual cash once, not an income or transfer', () => {
  const accounts = [{_id:'a',type:'bank',owner:'Mahbub'},{_id:'card',type:'bank',owner:'Mahbub'}];
  const tx = [{_id:'repay',txType:'expense',amount:1234.5,fromAccountId:'a',sourceType:'credit_card_repayment'}];
  const data = calculateMonthlyLiquidFlow(accounts,tx);
  assert.equal(data.household.remainingFromMonth,-1234.5);
  assert.equal(data.household.expenses,1234.5);
  assert.equal(data.household.otherExpenses,0);
  assert.equal(data.household.cardRepayments,1234.5);
  assert.equal(data.byOwner.Mahbub.cardRepayments,1234.5);
});
test('card repayments remain accounted as cash outflows only without Ledger allocations', () => {
  const route = readFileSync(new URL('../src/routes/creditCardPayment.route.js', import.meta.url),'utf8');
  assert.match(route,/budgetImpact: false, ledgerEligible: false, settlementImpact: false/);
  assert.match(route,/createIdempotentFinancialPosting\(req, 'creditCard.payment'/);
  assert.match(route,/await runAtomicPosting/);
  assert.doesNotMatch(route,/LedgerEntry\.create/);
});
test('idempotency operation is recognized and payment API is mounted', () => {
  const model = readFileSync(new URL('../src/models/FinancialPostingRequest.js', import.meta.url),'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url),'utf8');
  assert.match(model,/creditCard\.payment/);
  assert.match(app,/\/api\/credit-card-payments/);
});
