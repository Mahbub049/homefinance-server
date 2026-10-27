import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateOrdinaryExpenseShares, buildLedgerPaymentRows,
  fundedRowsForLedgerEntry,
} from "../src/utils/expenseFunding.js";
import { accountRowsFromMovements } from "../src/utils/accountArithmetic.js";

const mahbub = "mahbub";
const mim = "mim";
const expense = (amount, id = "le1", overrides = {}) => ({
  _id: id, entryType: "expense", amountTotal: amount, sourceType: "transaction", sourceId: "tx1", ...overrides,
});
const split = (uid, amount, entryId = "le1") => ({ ledgerEntryId: entryId, userId: uid, shareAmount: amount });
const transaction = (amount, overrides = {}) => ({
  _id: "tx1", txType: "expense", paymentMode: "single", amount, paidByUserId: mahbub, ...overrides,
});
const calc = (entries, splits, transactions) => calculateOrdinaryExpenseShares({
  entries, splits, transactions, userIds: [mahbub, mim],
});

test("T02: ৳60 rickshaw, each pays ৳30, equal responsibility => zero settlement", () => {
  const tx = transaction(60, { paymentMode: "split", paidByUserId: null, paymentParts: [
    { userId: mahbub, accountId: "a1", amount: 30 },
    { userId: mim, accountId: "a2", amount: 30 },
  ] });
  const result = calc([expense(60)], [split(mahbub, 30), split(mim, 30)], [tx]);
  assert.deepEqual(result.paidMap, { mahbub: 30, mim: 30 });
  assert.deepEqual(result.shareMap, { mahbub: 30, mim: 30 });
  assert.equal(result.paidTotal, 60);
  assert.equal(result.shareTotal, 60);
  assert.equal(result.settlementDiscrepancy, 0);
  assert.equal(result.balanced, true);
});

test("T03: one member pays 60 and cost is 50/50 => receiver +30, debtor -30", () => {
  const result = calc([expense(60)], [split(mahbub, 30), split(mim, 30)], [transaction(60)]);
  assert.equal(result.paidMap[mahbub] - result.shareMap[mahbub], 30);
  assert.equal(result.paidMap[mim] - result.shareMap[mim], -30);
  assert.equal(result.balanced, true);
});

test("personal expense: 100 fully paid by member who bears it, no settlement", () => {
  const result = calc([expense(100)], [split(mahbub, 100)], [transaction(100)]);
  assert.equal(result.paidMap[mahbub] - result.shareMap[mahbub], 0);
  assert.equal(result.balanced, true);
});

test("missing source-linked transaction must not invent a ledger payment", () => {
  const entry = expense(60, "le1", { paidByUserId: mahbub });
  const result = calc([entry], [split(mahbub, 30), split(mim, 30)], []);
  assert.equal(result.paidTotal, 0);
  assert.equal(result.balanced, false);
  assert.equal(result.settlementDiscrepancy, -60);
});

test("legacy standalone ledger entry can fallback to paidByUserId", () => {
  const entry = expense(50, "le1", { sourceType: "manual", sourceId: "le1", paidByUserId: mim });
  const result = calc([entry], [split(mim, 50)], []);
  assert.deepEqual(result.paidMap, { mahbub: 0, mim: 50 });
  assert.equal(result.balanced, true);
});

test("budget-only shared purchase must not create a cash payer", () => {
  const entry = expense(4625, "allocated", {
    affectsSettlement: false, paidByUserId: mim, sourceType: "shared_purchase_installment", sourceId: "s1",
  });
  assert.deepEqual(fundedRowsForLedgerEntry(entry, null), []);
  const result = calc([entry], [split(mim, 4625, "allocated")], []);
  assert.equal(result.paidTotal, 0);
  assert.equal(result.shareTotal, 0);
  assert.equal(result.balanced, true);
});

test("malformed split cannot masquerade as a full payer expense", () => {
  const tx = transaction(60, { paymentMode: "split", paidByUserId: mahbub, paymentParts: [] });
  assert.deepEqual(buildLedgerPaymentRows([expense(60)], [tx]).get("le1"), []);
});

test("fractional split keeps exact 2-decimal precision", () => {
  const tx = transaction(100.01, { paymentMode: "split", paymentParts: [
    { userId: mahbub, amount: 50.01 }, { userId: mim, amount: 50 },
  ] });
  const result = calc([expense(100.01)], [split(mahbub, 50.01), split(mim, 50)], [tx]);
  assert.equal(result.balanced, true);
  assert.equal(result.settlementDiscrepancy, 0);
});

test("account cash: paid 30/30 split reduces actual balances 30/30", () => {
  const accounts = [{ _id: "a1", openingBalance: 100 }, { _id: "a2", openingBalance: 200 }];
  const { accounts: rows, total } = accountRowsFromMovements(accounts, [], [], [
    { _id: "a1", total: 30 }, { _id: "a2", total: 30 },
  ]);
  assert.equal(rows[0].balance, 70);
  assert.equal(rows[1].balance, 170);
  assert.equal(total, 240);
});

test("T05: moving 10K from bank to DPS lowers liquid, not total assets", () => {
  const { accounts: rows } = accountRowsFromMovements([
    { _id: "bank", type: "bank", openingBalance: 60000 },
    { _id: "dps", type: "savings", openingBalance: 0 },
  ], [{ _id: "dps", total: 10000 }], [{ _id: "bank", total: 10000 }]);
  assert.equal(rows[0].balance, 50000);
  assert.equal(rows[1].balance, 10000);
  assert.equal(rows[0].balance + rows[1].balance, 60000);
});

test("T06 & T07: upfront AC deducts 74K immediately; reimbursement is zero-sum", () => {
  const accounts = [
    { _id: "mim", openingBalance: 90000 },
    { _id: "mahbub", openingBalance: 50000 },
  ];
  const before = accountRowsFromMovements(accounts, [], [{ _id: "mim", total: 74000 }]);
  assert.equal(before.accounts[0].balance, 16000);
  assert.equal(before.total, 66000);
  const after = accountRowsFromMovements(accounts, [{ _id: "mim", total: 4625 }], [
    { _id: "mim", total: 74000 }, { _id: "mahbub", total: 4625 },
  ]);
  assert.equal(after.accounts[0].balance, 20625);
  assert.equal(after.accounts[1].balance, 45375);
  assert.equal(after.total, 66000);
});

test("both expense sources add together, never duplicate the same expense", () => {
  const rows = accountRowsFromMovements([{ _id: "bank", openingBalance: 100 }], [],
    [{ _id: "bank", total: 20 }], [{ _id: "bank", total: 30 }]);
  assert.equal(rows.accounts[0].balance, 50);
});
