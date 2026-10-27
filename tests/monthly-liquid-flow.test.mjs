import test from "node:test";
import assert from "node:assert/strict";
import { calculateMonthlyLiquidFlow } from "../src/utils/monthlyLiquidFlow.js";
import { calculateAccountPeriod } from "../src/utils/reconciledAccountMath.js";

const accounts = [
  { _id: "mah", owner: "Mahbub", type: "bank", openingBalance: 7500 },
  { _id: "mim", owner: "Mirza", type: "wallet", openingBalance: 1500 },
  { _id: "joint", owner: "Joint", type: "cash", openingBalance: 3000 },
  { _id: "dps", owner: "Mahbub", type: "savings", openingBalance: 0 },
  { _id: "investment", owner: "Mirza", type: "investment", openingBalance: 0 },
];
const tx = (_id, txType, amount, fromAccountId, toAccountId, extra = {}) => ({ _id, txType, amount, fromAccountId, toAccountId, ...extra });
test("This month's remaining is salary minus paid expenses EMI and savings regardless of opening cash", () => {
  const rows = [tx("1", "income", 60000, null, "mah"), tx("2", "expense", 30000, "mah"), tx("3", "expense", 5000, "mah", null, { sourceType: "emi_installment" }), tx("4", "transfer", 10000, "mah", "dps")];
  const r = calculateMonthlyLiquidFlow(accounts, rows);
  assert.equal(r.household.remainingFromMonth, 15000);
  assert.equal(r.byOwner.Mahbub.remainingFromMonth, 15000);
  const period = calculateAccountPeriod(accounts, null, rows);
  assert.equal(period.liquidClosing - period.liquidOpening, r.household.remainingFromMonth);
  assert.equal(r.household.emiPaid, 5000);
  assert.equal(r.household.savedOrInvested, 10000);
});
test("Repayment shifts member remaining, not household remaining", () => {
  const rows = [tx("a", "income", 60000, null, "mah"), tx("b", "income", 60000, null, "mim"), tx("c", "expense", 600, "mim"), tx("d", "transfer", 300, "mah", "mim", { sourceType: "shared_purchase_reimbursement" })];
  const r = calculateMonthlyLiquidFlow(accounts, rows);
  assert.equal(r.household.remainingFromMonth, 119400);
  assert.equal(r.byOwner.Mahbub.remainingFromMonth, 59700);
  assert.equal(r.byOwner.Mirza.remainingFromMonth, 59700);
  assert.equal(r.byOwner.Mahbub.transfersOut, 300);
});
test("74K upfront purchase charged once, installment reimbursements not new household expense", () => {
  const rows = [tx("p", "expense", 74000, "mim", null, { sourceType: "shared_purchase" }), tx("r", "transfer", 4625, "mah", "mim", { sourceType: "shared_purchase_reimbursement" })];
  const r = calculateMonthlyLiquidFlow(accounts, rows);
  assert.equal(r.household.expenses, 74000);
  assert.equal(r.household.sharedPurchasePaidUpfront, 74000);
  assert.equal(r.household.remainingFromMonth, -74000);
  assert.equal(r.byOwner.Mahbub.remainingFromMonth, -4625);
  assert.equal(r.byOwner.Mirza.remainingFromMonth, -69375);
});
test("Split 30/30 allocates actual cash outflows to both, not doubled", () => {
  const rows = [tx("split", "expense", 60, null, null, { paymentMode: "split", paymentParts: [{ accountId: "mah", amount: 30 }, { accountId: "mim", amount: 30 }] })];
  const r = calculateMonthlyLiquidFlow(accounts, rows);
  assert.equal(r.household.expenses, 60);
  assert.equal(r.byOwner.Mahbub.remainingFromMonth, -30);
  assert.equal(r.byOwner.Mirza.remainingFromMonth, -30);
});
test("Liquid to liquid self-transfer is excluded; joint transfer owner attribution preserved", () => {
  const rows = [tx("i", "transfer", 250, "mah", "joint"), tx("ii", "transfer", 400, "mah", "mah")];
  const r = calculateMonthlyLiquidFlow(accounts, rows);
  assert.equal(r.household.remainingFromMonth, 0);
  assert.equal(r.byOwner.Mahbub.remainingFromMonth, -250);
  assert.equal(r.byOwner.Joint.remainingFromMonth, 250);
});
test("Withdrawal from savings improves liquid cash but isn't counted as earned income", () => {
  const r = calculateMonthlyLiquidFlow(accounts, [tx("d", "transfer", 1200, "dps", "mah")]);
  assert.equal(r.household.income, 0);
  assert.equal(r.household.savingsWithdrawn, 1200);
  assert.equal(r.household.remainingFromMonth, 1200);
});
test("Invalid funding and missing accounts visibly flag the amount as unverified", () => {
  const r = calculateMonthlyLiquidFlow(accounts, [tx("bad", "expense", 60, null, null, { paymentMode: "split", paymentParts: [{ accountId: "mah", amount: 30 }] }), tx("unmatched", "income", 100, null, "nope")]);
  assert.equal(r.issues.length, 2);
  assert.equal(r.household.remainingFromMonth, 0);
});
test("Transfer to investment is not expense but decreases liquid monthly remainder", () => {
  const r = calculateMonthlyLiquidFlow(accounts, [tx("income", "income", 500, null, "mim"), tx("save", "transfer", 200, "mim", "investment")]);
  assert.equal(r.household.remainingFromMonth, 300);
  assert.equal(r.household.expenses, 0);
  assert.equal(r.household.savedOrInvested, 200);
});
