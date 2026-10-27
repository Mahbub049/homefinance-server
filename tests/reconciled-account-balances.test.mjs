import test from "node:test";
import assert from "node:assert/strict";
import { calculateAccountPeriod, summarizeLiquidBalances, nextMonth, accountIdOf } from "../src/utils/reconciledAccountMath.js";
const accounts = [
  { _id: "mah", name: "Mahbub bank", owner: "Mahbub", type: "bank", openingBalance: 0 },
  { _id: "mim", name: "Mim bank", owner: "Mirza", type: "bank", openingBalance: 0 },
  { _id: "dps", name: "DPS", owner: "Mahbub", type: "savings", openingBalance: 0 },
  { _id: "joint", name: "Joint cash", owner: "Joint", type: "cash", openingBalance: 500 },
];
const tx = (id, txType, amount, fromAccountId, toAccountId, other = {}) => ({ _id: id, txType, amount, fromAccountId, toAccountId, ...other });
test("60K salary, 30K spend, 5K EMI, 10K DPS, 4625 reimbursement = 10375 liquid", () => {
  const flows = [
    tx("salary", "income", 60000, null, "mah"),
    tx("spend", "expense", 30000, "mah"),
    tx("emi", "expense", 5000, "mah"),
    tx("savings", "transfer", 10000, "mah", "dps"),
    tx("pay", "transfer", 4625, "mah", "mim"),
  ];
  const period = calculateAccountPeriod(accounts, [], flows);
  assert.equal(period.issues.length, 0);
  assert.equal(period.accounts.find((r) => r.accountId === "mah").balance, 10375);
  assert.equal(summarizeLiquidBalances(period.accounts).total, 15500); // reimbursement moves cash to Mim, +500 joint opening
  assert.equal(period.closingTotal, 25500); // includes 10K DPS asset
});
test("60 split funded 30 each deducts each once, even with personal cost split", () => {
  const result = calculateAccountPeriod(accounts, [], [tx("split", "expense", 60, null, null, {
    paymentMode: "split", paymentParts: [{ accountId: "mah", amount: 30 }, { accountId: "mim", amount: 30 }],
  })]);
  assert.equal(result.accounts.find((r) => r.accountId === "mah").balance, -30);
  assert.equal(result.accounts.find((r) => r.accountId === "mim").balance, -30);
  assert.equal(result.liquidMovement, -60);
});
test("AC upfront and reimbursement move money without repeated household expense", () => {
  const result = calculateAccountPeriod(accounts, [], [
    tx("ac", "expense", 74000, "mim"),
    tx("repay", "transfer", 4625, "mah", "mim"),
  ]);
  assert.equal(result.accounts.find((r) => r.accountId === "mim").balance, -69375);
  assert.equal(result.accounts.find((r) => r.accountId === "mah").balance, -4625);
  assert.equal(result.liquidMovement, -74000);
});
test("monthly roll-forward uses previous closing as opening, even with gaps", () => {
  const prior = [{ accountId: "mah", balance: 1200 }, { accountId: "mim", balance: 100 }];
  const period = calculateAccountPeriod(accounts, prior, [tx("expense", "expense", 200, "mah")]);
  assert.equal(period.accounts.find((r) => r.accountId === "mah").balance, 1000);
  assert.equal(period.accounts.find((r) => r.accountId === "mim").balance, 100);
  assert.equal(nextMonth("2026-12"), "2027-01");
});
test("malformed split refuses to invent a valid full cash movement", () => {
  const period = calculateAccountPeriod(accounts, [], [tx("bad", "expense", 60, null, null, {
    paymentMode: "split", paymentParts: [{ accountId: "mah", amount: 20 }],
  })]);
  assert.equal(period.issues[0].code, "INVALID_SPLIT_FUNDING");
  assert.equal(period.liquidMovement, 0);
});
test("unknown account remains an explicit reconciliation warning", () => {
  const period = calculateAccountPeriod(accounts, [], [tx("x", "expense", 75, "missing")]);
  assert.equal(period.issues[0].code, "UNKNOWN_ACCOUNT");
});
test("savings and investment accounts excluded from spendable cash without losing total assets", () => {
  const period = calculateAccountPeriod(accounts, [], [tx("salary", "income", 10000, null, "mah"), tx("dps", "transfer", 10000, "mah", "dps")]);
  const liquid = summarizeLiquidBalances(period.accounts);
  assert.equal(liquid.owners.Mahbub, 0);
  assert.equal(liquid.joint, 500);
  assert.equal(period.closingTotal, 10500);
});

test("BSON ObjectId-like values use hex strings rather than the binary .id field", () => {
  const fake = { id: Buffer.from([0, 255]), toHexString() { return "0123456789abcdef01234567"; } };
  assert.equal(accountIdOf(fake), "0123456789abcdef01234567");
});
