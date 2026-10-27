import test from "node:test";
import assert from "node:assert/strict";
import { summarizePurchaseInstallments, WALLET_SHARED_REIMBURSEMENT_FIELDS, validReimbursement } from "../src/utils/sharedPurchaseSchedule.js";

const purchase = { _id: "ac", payerUserId: "mim" };
const schedule = (months = 8) => Array.from({ length: months }, (_, index) => {
  const month = `2026-${String(index + 1).padStart(2,"0")}`;
  return [
    { _id: `owner-${month}`, userId: "mim", month, amount: 4625, paymentRequired: false, status: "allocated" },
    { _id: `repay-${month}`, userId: "mah", month, amount: 4625, paymentRequired: true, status: "pending" },
  ];
}).flat();
const paid = (row, month = "2026-01") => ({...row, status: "paid", paidAt: `${month}-15T12:00:00.000Z`, paymentTransactionId: `tx-${row._id}`, fromAccountId: "mah-bank", toAccountId: "mim-bank" });
const transfer = (row) => ({_id: row.paymentTransactionId, txType: "transfer", sourceType: "shared_purchase_reimbursement", sourceId: row._id, amount: row.amount, paidByUserId: "mah", receivedByUserId: "mim", fromAccountId: "mah-bank", toAccountId: "mim-bank"});

test("74K/8 months schedules both members at 4625, even when one has not reimbursed", () => {
  const r = summarizePurchaseInstallments(schedule(), "2026-01", purchase);
  assert.equal(r.summary.totalAllocation, 74000);
  assert.equal(r.summary.scheduledAllocationThisMonth, 9250);
  assert.equal(r.summary.scheduledReimbursementThisMonth, 4625);
  assert.equal(r.summary.dueThisMonth, 4625);
  assert.equal(r.summary.dueThroughMonth, 4625);
  assert.equal(r.summary.outstandingAllSchedule, 37000);
});
test("Unpaid earlier installments remain overdue in later month, future ones not due yet", () => {
  const r = summarizePurchaseInstallments(schedule(), "2026-03", purchase);
  assert.equal(r.summary.overdueBeforeMonth, 9250);
  assert.equal(r.summary.dueThisMonth, 4625);
  assert.equal(r.summary.dueThroughMonth, 13875);
  assert.equal(r.summary.futureUnpaid, 23125);
});
test("Verified repayment clears debt without reducing scheduled allocation", () => {
  const rows = schedule(); const item = paid(rows[1]); rows[1] = item;
  const r = summarizePurchaseInstallments(rows, "2026-01", purchase, new Map([[item.paymentTransactionId, transfer(item)]]));
  assert.equal(r.summary.scheduledAllocationThisMonth, 9250);
  assert.equal(r.summary.dueThisMonth, 0);
  assert.equal(r.summary.receivedThisMonth, 4625);
  assert.equal(r.summary.outstandingAllSchedule, 32375);
});
test("Later payment does not erase historical due before the payment", () => {
  const rows = schedule(); const item = paid(rows[1], "2026-03"); rows[1] = item;
  const tx = new Map([[item.paymentTransactionId, transfer(item)]]);
  assert.equal(summarizePurchaseInstallments(rows, "2026-02", purchase, tx).summary.overdueBeforeMonth, 4625);
  assert.equal(summarizePurchaseInstallments(rows, "2026-03", purchase, tx).summary.receivedThisMonth, 4625);
});
test("Stale paid flag without matching transfer is not accepted as a repayment", () => {
  const rows = schedule(); rows[1] = paid(rows[1]);
  const r = summarizePurchaseInstallments(rows, "2026-01", purchase);
  assert.equal(r.summary.invalidPaymentRecords, 1);
  assert.equal(r.summary.dueThisMonth, 4625);
  assert.equal(r.summary.receivedLifetime, 0);
});
test("Personal large purchase has allocations but no settlement debt", () => {
  const rows = schedule().filter((row) => !row.paymentRequired);
  const r = summarizePurchaseInstallments(rows, "2026-04", purchase);
  assert.equal(r.summary.scheduledAllocationThisMonth, 4625);
  assert.equal(r.summary.receivableTotal, 0);
  assert.equal(r.summary.dueThroughMonth, 0);
});


test("Wallet projection includes every field required for a verified shared reimbursement", () => {
  const fields = new Set(WALLET_SHARED_REIMBURSEMENT_FIELDS.split(/\s+/));
  for (const required of [
    "purchaseId", "userId", "amount", "paymentRequired", "status",
    "paidAt", "paymentTransactionId", "fromAccountId", "toAccountId",
  ]) {
    assert.ok(fields.has(required), `Wallet is missing ${required} from installment query`);
  }
  const original = paid(schedule()[1]);
  const projection = Object.fromEntries(
    [...fields].map((field) => [field, original[field]])
  );
  projection._id = original._id;
  assert.ok(validReimbursement(projection, purchase, transfer(original)));
  // This was the real bug: old route omitted paymentRequired, falsely counting paid dues.
  delete projection.paymentRequired;
  assert.equal(validReimbursement(projection, purchase, transfer(original)), false);
});

test("Four paid 4,625 AC reimbursements leave only October's 4,625 due", () => {
  const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"];
  const rows = months.flatMap((month, i) => [
    { _id: `mim-${month}`, purchaseId: "ac", userId: "mim", month,
      amount: 4625, paymentRequired: false, status: "allocated" },
    { _id: `mah-${month}`, purchaseId: "ac", userId: "mah", month,
      amount: 4625, paymentRequired: true, status: "pending" },
  ]);
  const txMap = new Map();
  for (let i = 0; i < 4; i += 1) {
    const idx = i * 2 + 1;
    rows[idx] = paid(rows[idx], months[i]);
    txMap.set(rows[idx].paymentTransactionId, transfer(rows[idx]));
  }
  const result = summarizePurchaseInstallments(rows, "2026-10", purchase, txMap);
  assert.equal(result.summary.receivedLifetime, 18500);
  assert.equal(result.summary.overdueBeforeMonth, 0);
  assert.equal(result.summary.dueThisMonth, 4625);
  assert.equal(result.summary.dueThroughMonth, 4625);
  assert.equal(result.summary.futureUnpaid, 13875);
  assert.equal(result.summary.outstandingAllSchedule, 18500);
});
