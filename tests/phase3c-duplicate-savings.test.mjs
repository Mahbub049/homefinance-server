import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  stableJSON, financialPayloadHash, requireIdempotencyKey,
} from '../src/utils/idempotencyPayload.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', 'src', p), 'utf8');
const base = path.resolve(here, '..', '..', 'client', 'src', 'pages');
const grocery = read('routes/grocery.route.js');
const savings = read('routes/savings.route.js');
const posting = read('utils/idempotentFinancialPosting.js');
const requestModel = read('models/FinancialPostingRequest.js');
const clientGrocery = existsSync(path.join(base, 'Grocery.jsx')) ? readFileSync(path.join(base, 'Grocery.jsx'), 'utf8') : null;
const clientSavings = existsSync(path.join(base, 'Savings.jsx')) ? readFileSync(path.join(base, 'Savings.jsx'), 'utf8') : null;

test('Stable hashing ignores property order', () => {
  const a = {amount: 2500, split: {type: 'personal', userId: 'ab'}, items: [{name: 'Milk', qty: 2}]};
  const b = {items: [{qty: 2, name: 'Milk'}], split: {userId: 'ab', type: 'personal'}, amount: 2500};
  assert.equal(stableJSON(a), stableJSON(b));
  assert.equal(financialPayloadHash(a), financialPayloadHash(b));
});
test('Different payload creates different hashes even with same price', () => {
  assert.notEqual(financialPayloadHash({amount: 1000, note:'A'}), financialPayloadHash({amount:1000, note:'B'}));
});
test('Request keys must be sufficiently long to avoid collisions', () => {
  assert.equal(requireIdempotencyKey({'idempotency-key':'12345678-1234-4234-8234-123456789012'}).length,36);
  for (const value of [undefined,'','hi','abc!12345678901234567890']) {
    assert.throws(() => requireIdempotencyKey({'idempotency-key':value}), /Idempotency-Key/);
  }
});
test('Request receipt is unique for family, operation and key and stores payload hash', () => {
  assert.match(requestModel, /financialPostingRequestSchema\.index\(/);
  assert.match(requestModel, /familyId: 1, operation: 1, key: 1/);
  assert.match(requestModel, /unique: true/);
  assert.match(requestModel, /payloadHash/);
  assert.match(posting, /FinancialPostingRequest\.collection\.createIndex/);
});
test('Receipt and finance writes commit in one atomic database transaction', () => {
  assert.match(posting, /runAtomicPosting\(async/);
  assert.match(posting, /FinancialPostingRequest\.create/);
  assert.match(posting, /FinancialPostingRequest\.updateOne/);
});
test('Conflicting reuse of the same request key is rejected', () => {
  assert.match(posting, /record\.payloadHash !== payloadHash/);
  assert.match(posting, /error\.status = 409/);
});
test('Grocery checks for committed retry before preflight', () => {
  const start = grocery.indexOf('router.post("/"');
  const body = grocery.slice(start, grocery.indexOf('router.put("/:id"', start));
  assert.ok(body.indexOf('existingFinancialPosting') < body.indexOf('prepareGroceryPayload'));
  assert.match(body, /createIdempotentFinancialPosting/);
});
test('Savings replay avoids inserting a duplicate deposit', () => {
  const start = savings.indexOf('router.post("/deposit"');
  const body = savings.slice(start);
  assert.ok(body.indexOf('existingFinancialPosting') < body.indexOf('verifySavingsPosting'));
  assert.match(body, /createIdempotentFinancialPosting/);
  assert.match(body, /txType: "transfer"/);
  assert.doesNotMatch(body, /LedgerEntry\.create/);
});
test('Savings internal account transfer does not inflate deposit and withdrawal totals', () => {
  assert.match(savings, /\$and: \["\$toSavings", \{ \$not: \["\$fromSavings"\] \}\]/);
  assert.match(savings, /\$and: \["\$fromSavings", \{ \$not: \["\$toSavings"\] \}\]/);
});
test('Client sends stable request IDs for retries and prevents rapid double-click', { skip: !(clientGrocery && clientSavings) }, () => {
  for (const client of [clientGrocery, clientSavings]) {
    assert.match(client, /crypto\.randomUUID\(\)/);
    assert.match(client, /'Idempotency-Key'/);
    assert.match(client, /InFlight\.current/);
  }
});
