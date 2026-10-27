import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = file => fs.readFileSync(path.join(here, '..', 'src', file), 'utf8');
const fixed = read('routes/fixed.route.js');
const grocery = read('routes/grocery.route.js');
const savings = read('routes/savings.route.js');
const atomic = read('utils/financialPostingTransaction.js');
function endpoint(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `Missing endpoint ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b >= 0, `Missing endpoint after ${start}`);
  return source.slice(a, b);
}

test('Fixed direct template posting creates all linked records atomically', () => {
  const body = endpoint(fixed, 'router.post("/templates/:id/add"', 'router.get("/instances"');
  assert.match(body, /runAtomicPosting\(async/);
  assert.match(body, /FixedInstance\.exists/);
  assert.ok(body.indexOf('await runAtomicPosting') < body.indexOf('return res.json({ ok: true'));
});
test('Fixed generated instance posting uses an atomic transaction and rejects reposts', () => {
  const body = endpoint(fixed, 'router.post("/instances/:id/post"', 'router.put("/instances/:id"');
  assert.match(body, /runAtomicPosting\(async/);
  assert.match(body, /currentInstance\.status !== "pending"/);
  assert.match(body, /currentInstance\.transactionId/);
});
test('Fixed instance edits put cash, ledger and split updates in one transaction', () => {
  const body = endpoint(fixed, 'router.put("/instances/:id"', 'router.delete("/instances/:id"');
  assert.match(body, /runAtomicPosting\(async/);
  for (const n of ['await tx.save()', 'await entry.save()', 'await Split.deleteMany', 'await inst.save()']) {
    assert.ok(body.includes(n), `${n} missing`);
  }
});
test('Fixed instance deletion reconciles ledger and cash changes together', () => {
  const body = endpoint(fixed, 'router.delete("/instances/:id"', 'export default router;');
  assert.match(body, /runAtomicPosting\(async/);
  for (const n of ['Split.deleteMany', 'LedgerEntry.deleteOne', 'Transaction.deleteOne', 'FixedInstance.deleteOne']) {
    assert.ok(body.includes(n), `${n} missing`);
  }
});
test('Grocery creation is a single financial event', () => {
  const body = endpoint(grocery, 'router.post("/"', 'router.put("/:id"');
  assert.match(body, /createIdempotentFinancialPosting\(req, 'grocery\.create', async/);
  for (const n of ['Transaction.create', 'LedgerEntry.create', 'replaceSplits', 'GroceryTransaction.create', 'GroceryItem.insertMany']) {
    assert.ok(body.includes(n), `${n} missing`);
  }
});
test('Grocery updates are atomic, including replacement of line items', () => {
  const body = endpoint(grocery, 'router.put("/:id"', 'router.delete("/:id"');
  assert.match(body, /runAtomicPosting\(async/);
  for (const n of ['Transaction.updateOne', 'LedgerEntry.updateOne', 'replaceSplits', 'GroceryItem.deleteMany', 'GroceryItem.insertMany']) {
    assert.ok(body.includes(n), `${n} missing`);
  }
  assert.doesNotMatch(body, /return res\.status\(404\).*inside/);
});
test('Grocery deletion removes all linked records atomically', () => {
  const body = endpoint(grocery, 'router.delete("/:id"', 'export default router;');
  assert.match(body, /runAtomicPosting\(async/);
  for (const n of ['GroceryItem.deleteMany', 'Split.deleteMany', 'LedgerEntry.deleteOne', 'Transaction.deleteOne', 'GroceryTransaction.deleteOne']) {
    assert.ok(body.includes(n), `${n} missing`);
  }
});
test('Atomic posting never uses a partial-write fallback on standalone MongoDB', () => {
  assert.match(atomic, /mongoose\.connection\.transaction/);
  assert.match(atomic, /transactionAsyncLocalStorage/);
  assert.match(atomic, /failure\.status = 503/);
});
test('Savings deposits remain one transfer, not a second expense or ledger entry', () => {
  const body = endpoint(savings, 'router.post("/deposit"', 'export default router;');
  assert.match(body, /txType: "transfer"/);
  assert.match(body, /budgetImpact: false/);
  assert.match(body, /ledgerEligible: false/);
  assert.doesNotMatch(body, /LedgerEntry\.create/);
});
