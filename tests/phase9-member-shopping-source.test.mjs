import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Checklist endpoints use authenticated family scoping', () => {
  const route = read('src/routes/groceryChecklist.route.js');
  assert.match(route, /router\.use\(requireAuth, requireFamily\)/);
  assert.match(route, /familyId: req\.familyId/);
  assert.match(route, /findOneAndUpdate\(/);
  assert.match(route, /findOneAndDelete\(/);
});
test('Checklist does not write expense or transaction records', () => {
  const route = read('src/routes/groceryChecklist.route.js');
  assert.doesNotMatch(route,/LedgerEntry|Transaction\.|SavingsTransaction|Split\./);
});
test('Checklist fields can be left blank and checked is boolean', () => {
  const model = read('src/models/GroceryChecklistItem.js');
  assert.match(model, /name: \{ type: String, default: ''/);
  assert.match(model, /quantity: \{ type: String, default: ''/);
  assert.match(model, /checked: \{ type: Boolean, default: false/);
});
test('Member expense sorting honors manually chosen limit', () => {
  const route = read('src/routes/individualSummary.route.js');
  assert.match(route, /req\.query\.topLimit/);
  assert.match(route, /\.slice\(0, topLimit\)/);
});
test('Shopping checklist API is connected', () => {
  const app = read('src/app.js');
  assert.match(app, /app\.use\("\/api\/grocery-checklist", groceryChecklistRouter\)/);
});
