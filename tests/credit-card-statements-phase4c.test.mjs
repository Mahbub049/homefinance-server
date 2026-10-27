import test from 'node:test';
import assert from 'node:assert/strict';
import { cardStatementCoverage, isCardCandidate, validateStatement } from '../src/utils/creditCardStatements.js';
import { assemblePosition } from '../src/utils/financialPosition.js';
const account = (id, name) => ({accountId:id,name,owner:'Mahbub',type:'bank',balance:0});
test('Only card-like names eligible for provisional card statement registration', () => {
  assert.equal(isCardCandidate(account('1','One Bank Credit Card')), true);
  assert.equal(isCardCandidate(account('2','EBL Account')), false);
});
test('Missing exact-month statements never become zero liability', () => {
  const card = account('a','One Bank Credit Card');
  const data = cardStatementCoverage([card], [{accountId:'a',month:'2026-09',outstanding:3333}],'2026-10');
  assert.equal(data.totalOutstanding,null); assert.equal(data.recordedCount,0); assert.equal(data.missingCount,1);
});
test('Zero owed is explicitly reported as zero, not unknown', () => {
  const data = cardStatementCoverage([account('a','Bank Credit Card')], [{accountId:'a',month:'2026-10',outstanding:0}],'2026-10');
  assert.equal(data.complete,true); assert.equal(data.totalOutstanding,0);
});
test('Partial multi-card coverage is never reported as all debt', () => {
  const data = cardStatementCoverage([account('a','ABC Credit Card'),account('b','XYZ Credit Card')], [{accountId:'a',month:'2026-10',outstanding:1450.23}], '2026-10');
  assert.equal(data.complete,false); assert.equal(data.totalOutstanding,null); assert.equal(data.recordedOutstanding,1450.23);
});
test('Multiple complete statements sum precisely to cents', () => {
  const data = cardStatementCoverage([account('a','ABC Credit Card'),account('b','XYZ Credit Card')], [
    {accountId:'a',month:'2026-10',outstanding:1450.13}, {accountId:'b',month:'2026-10',outstanding:3.27}
  ], '2026-10');
  assert.equal(data.totalOutstanding,1453.4);
});
test('Invalid, negative and overly precise amounts rejected', () => {
  assert.match(validateStatement({month:'2026-10',amount:-1}),/non-negative/);
  assert.match(validateStatement({month:'2026-10',amount:1.123}),/decimal/);
  assert.match(validateStatement({month:'2026-13',amount:1}),/YYYY-MM/);
  assert.match(validateStatement({month:'2026-10',amount:Infinity}),/non-negative/);
  assert.match(validateStatement({month:'2026-10',amount:''}),/non-negative/);
});
test('Statements change reported debt only, not account balances or verified net worth', () => {
  const rows = [account('a','One Bank Credit Card'), {accountId:'b',name:'Cash',type:'cash',balance:1000}];
  const position = assemblePosition(rows,{remainingEMI:100}, {month:'2026-10',issues:[]}, [{accountId:'a',month:'2026-10',outstanding:200}]);
  assert.equal(position.assets.trackedAccountTotal,1000);
  assert.equal(position.liabilities.creditCardOutstanding,200);
  assert.equal(position.netWorth,null);
  assert.equal(position.position.afterRegisteredEMIIllustration,900);
});
