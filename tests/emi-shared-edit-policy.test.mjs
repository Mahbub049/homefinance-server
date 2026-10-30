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
test('shared purchase metadata edit never updates the monetary fields',()=>{
 const marker=shared.indexOf("router.put('/:purchaseId/details'");
 assert.ok(marker>=0);
 const code=shared.slice(marker,shared.indexOf("router.delete('/:purchaseId'",marker));
 assert.match(code,/\['title','note'\]/);
 assert.match(code,/purchase\.title=title;purchase\.note=note/);
 assert.doesNotMatch(code,/purchase\.(totalAmount|months|shares|payerAccountId)\s*=/);
});
