import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const emi=fs.readFileSync(new URL('../src/routes/emi.route.js',import.meta.url),'utf8');
const shared=fs.readFileSync(new URL('../src/routes/sharedPurchase.route.js',import.meta.url),'utf8');
test('EMI delete requires history protection and explicit route',()=>{
 assert.match(emi,/router\.delete\('\/plans\/:id'/);
 assert.match(emi,/EMIInstallment\.exists/);
 assert.match(emi,/writableMonth\(plan\.startMonth\)/);
 assert.match(emi,/runAtomicPosting/);
});
test('shared purchase revision protects upfront money and paid history',()=>{
 const marker=shared.indexOf("router.put('/:purchaseId/details'");
 assert.ok(marker>=0);
 const code=shared.slice(marker,shared.indexOf("router.delete('/:purchaseId'",marker));
 assert.match(code,/expectedUpdatedAt/);
 assert.match(code,/runAtomicPosting/);
 assert.match(code,/requireOpenPurchaseMonths/);
 assert.match(code,/canReviseFuture/);
 assert.match(code,/futureRemainder/);
 assert.match(code,/purchase\.months=priorMonths\+remainingMonths/);
 assert.doesNotMatch(code,/purchase\.(totalAmount|payerAccountId|payerUserId|purchaseDate)\s*=/);
});
