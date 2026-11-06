import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../src/routes/transaction.route.js', import.meta.url), 'utf8');
const receipt = readFileSync(new URL('../src/models/ManualTransactionBatch.js', import.meta.url), 'utf8');
const idempotency = readFileSync(new URL('../src/models/FinancialPostingRequest.js', import.meta.url), 'utf8');

const batch = route.slice(route.indexOf('router.post("/batch"'), route.indexOf('// Manual creation is fully atomic:'));

test('batch endpoint is declared before /:id and shares the manual transaction validator', () => {
  assert.ok(batch.length > 0);
  assert.ok(route.indexOf('router.post("/batch"') < route.indexOf('router.put("/:id"'));
  assert.match(batch, /await validateTransactionInput\(req, \{ \.\.\.entries\[i\], date \}\)/);
  assert.match(batch, /row: i \+ 1/);
});

test('bulk input is bounded and always shares the selected valid calendar date', () => {
  assert.match(route, /const MAX_DAILY_ENTRIES = 30/);
  assert.match(batch, /entries\.length < 2 \|\| entries\.length > MAX_DAILY_ENTRIES/);
  assert.match(batch, /new Date\(`\$\{date\}T12:00:00Z`\)\.toISOString\(\)\.slice\(0, 10\) === date/);
  assert.match(batch, /month < '2026-10'/);
});

test('the whole batch saves atomically, with exactly one ledger sync for every source transaction', () => {
  assert.match(batch, /createIdempotentFinancialPosting\(req, 'manual\.transaction\.batch', async \(\) => \{/);
  assert.match(batch, /await requireOpenMonth\(req\.familyId, month\)/);
  assert.match(batch, /for \(const payload of validated\) \{/);
  assert.match(batch, /await Transaction\.create\(/);
  assert.match(batch, /await syncTransactionLedger\(\{ req, tx, payload \}\)/);
  assert.match(batch, /ManualTransactionBatch\.create\(/);
  assert.ok(batch.indexOf('Transaction.create') > batch.indexOf('createIdempotentFinancialPosting'));
  assert.ok(batch.indexOf('syncTransactionLedger') < batch.indexOf('ManualTransactionBatch.create'));
});

test('replayed requests return the original batch receipt without new account debits', () => {
  assert.match(idempotency, /'manual\.transaction\.batch'/);
  assert.match(batch, /_id: result\.resultId, familyId: req\.familyId/);
  assert.match(batch, /savedCount: receipt\.transactionIds\.length/);
  assert.match(batch, /replayed: result\.replayed/);
  assert.match(receipt, /transactionIds:/);
});
