import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeAllocationProgress } from '../src/utils/purchaseAllocationProgress.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const client = path.join(here, '..', '..', 'client', 'src', 'pages');
const load = (p) => fs.readFileSync(p, 'utf8');

test('Xiaomi-style personal plan shows two prior months of allocations without new cash debits', () => {
  const rows = Array.from({length:12}, (_, i) => {
    const m = i + 8;
    return {month:`${2026 + Math.floor((m - 1) / 12)}-${String(((m - 1) % 12) + 1).padStart(2, '0')}`,
      amount:i === 11 ? 3333.37 : 3333.33, paymentRequired:false};
  });
  const result = summarizeAllocationProgress(rows, '2026-10');
  assert.deepEqual(result.previousMonths, ['2026-08', '2026-09']);
  assert.equal(result.previousAmount, 6666.66);
  assert.equal(result.currentAmount, 3333.33);
  assert.equal(result.throughAmount, 9999.99);
  assert.equal(result.futureAmount, 30000.01);
});

test('shared allocation progress counts both members without changing settlement', () => {
  const rows = [{month:'2026-09', amount:4625},{month:'2026-09',amount:4625},
    {month:'2026-10',amount:4625},{month:'2026-10',amount:4625}];
  const s = summarizeAllocationProgress(rows,'2026-10');
  assert.equal(s.previousAmount, 9250);
  assert.equal(s.currentAmount, 9250);
});

test('payment client sends both route identifiers AND idempotency header', () => {
  const page = load(path.join(client, 'SharedPurchases.jsx'));
  assert.match(page, /purchaseId: idOf\(selectedPlan\._id\)/);
  assert.match(page, /installmentId: idOf\(selectedInstallment\._id\)/);
  assert.match(page, /'Idempotency-Key': paymentRequestKey\.current/);
  assert.match(page, /'Idempotency-Key': createRequestKey\.current/);
});

test('backend still validates identifiers and uses idempotent atomic payment', () => {
  const route = load(path.join(src,'routes','sharedPurchase.route.js'));
  assert.match(route, /identifiers must match the payment request/);
  assert.match(route, /createIdempotentFinancialPosting\(req, 'sharedPurchase\.pay'/);
  assert.match(route, /summarizeAllocationProgress\(rawRows, month\)/);
});

test('Dashboard read model exposes actual EMI, upfront, and ordinary cash outflow', () => {
  const route = load(path.join(src, 'routes', 'dashboard.route.js'));
  assert.match(route, /emiPaid: monthlyCashFlow\.household\.emiPaid/);
  assert.match(route, /sharedPurchasePaidUpfront: monthlyCashFlow\.household\.sharedPurchasePaidUpfront/);
});
