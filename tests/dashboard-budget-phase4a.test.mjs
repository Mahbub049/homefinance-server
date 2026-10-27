import test from "node:test";
import assert from "node:assert/strict";
import { summarizeDashboardBudget } from "../src/utils/dashboardBudgetMath.js";

const row = (amountTotal, financialType, extra = {}) => ({ amountTotal, financialType, ...extra });

test("October allocation is separated from actual debt and savings", () => {
  const result = summarizeDashboardBudget({
    entries: [row(131090, "income"), row(122986.45, "living"),
      row(12583.33, "debt", { isBudgetAllocation: true, sourceType: "shared_purchase_schedule" })],
    savingsContribution: 15000,
  });
  assert.equal(result.income, 131090);
  assert.equal(result.components.regularDebt, 0);
  assert.equal(result.components.scheduledLargePurchaseAllocation, 12583.33);
  assert.equal(result.components.budgetExpenses, 135569.78);
  assert.equal(result.finalBalance, -19479.78);
});

test("regular debt is distinct from virtual large purchase shares", () => {
  const result = summarizeDashboardBudget({ entries: [row(10000, "income"), row(1000, "debt"),
    row(2000, "debt", { isBudgetAllocation: true })] });
  assert.equal(result.components.regularDebt, 1000);
  assert.equal(result.components.scheduledLargePurchaseAllocation, 2000);
  assert.equal(result.debt, 3000);
  assert.equal(result.finalBalance, 7000);
});

test("savings withdrawals release cash; do not create negative household expense", () => {
  const result = summarizeDashboardBudget({ entries: [row(20000, "income"), row(6000, "living")], savingsContribution: -1500 });
  assert.equal(result.components.budgetExpenses, 6000);
  assert.equal(result.components.savingsContribution, -1500);
  assert.equal(result.finalBalance, 15500);
});

test("ledger investment is separately retained from account savings transfers", () => {
  const result = summarizeDashboardBudget({ entries: [row(50000, "income"), row(3000, "investment")], savingsContribution: 5000 });
  assert.equal(result.components.ledgerInvestment, 3000);
  assert.equal(result.components.netSavingsAndInvestment, 8000);
  assert.equal(result.finalBalance, 42000);
});

test("empty budget reports zero values", () => {
  const result = summarizeDashboardBudget({});
  assert.equal(result.finalBalance, 0);
  assert.equal(result.savingsRate, 0);
});
