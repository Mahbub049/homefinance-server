import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const route = readFileSync(new URL('../src/routes/transaction.route.js', import.meta.url),'utf8');
const ledger = readFileSync(new URL('../src/routes/ledger.route.js', import.meta.url),'utf8');
const model = readFileSync(new URL('../src/models/FinancialPostingRequest.js', import.meta.url),'utf8');
test('new manual transaction requires a reusable idempotency key', () => {
  assert.match(route,/createIdempotentFinancialPosting\(req, 'manual\.transaction\.create'/);
  assert.match(model,/'manual\.transaction\.create'/);
});
test('manual insert and linked ledger writes happen inside idempotent transaction callback', () => {
  const begin = route.indexOf("createIdempotentFinancialPosting(req, 'manual.transaction.create'");
  const end = route.indexOf('return tx._id', begin);
  const portion = route.slice(begin,end);
  assert.match(portion,/Transaction\.create\(/);
  assert.match(portion,/syncTransactionLedger\(/);
});
test('updates/deletes use atomic transaction boundary', () => {
  const updateBlock = route.slice(route.indexOf('router.put('), route.indexOf('// Delete manual'));
  const deleteBlock = route.slice(route.indexOf('// Delete manual'));
  assert.match(updateBlock,/runAtomicPosting\(/);
  assert.match(updateBlock,/syncTransactionLedger\(/);
  assert.match(deleteBlock,/runAtomicPosting\(/);
  assert.match(deleteBlock,/Split\.deleteMany/);
});
test('closed months are checked on edits and deletion', () => {
  assert.match(route,/requireOpenMonth\(req\.familyId, existing\.month\)/);
  assert.match(route,/requireOpenMonth\(req\.familyId, payload\.month\)/);
  assert.match(route,/requireOpenMonth\(req\.familyId, tx\.month\)/);
});
test('generic ledger-only financial creation is blocked', () => {
  assert.match(ledger,/Direct Ledger-only financial postings are disabled/);
});
test('generic ledger deletion is atomic and respects owning modules', () => {
  assert.match(ledger,/sourceOwnerOfLedger/);
  assert.match(ledger,/Delete or reverse it from its original section/);
  assert.match(ledger,/await runAtomicPosting/);
});
test('historical repair is gated by month and explicit confirmation', () => {
  assert.ok((ledger.match(/REPAIR_CURRENT_MONTH/g)||[]).length >= 2);
  assert.ok((ledger.match(/Historical months are preserved/g)||[]).length >= 2);
});
test('loading ledger does not silently delete historical installment records', () => {
  assert.doesNotMatch(ledger,/cleanupPendingInstallmentLedgers/);
});
