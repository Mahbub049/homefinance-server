/** Pure monthly allocation reconciliation. This is a reporting projection,
 * not a write to LedgerEntry or a second physical transaction. */
import { idString, roundCurrency } from "./sharedPurchaseSchedule.js";

export function isLegacySharedBudgetLedger(entry) {
  return String(entry?.sourceType || "") === "shared_purchase_installment" ||
    String(entry?.module || "") === "shared_purchase";
}

export function buildSharedBudgetView({ month, ledgerEntries = [], installments = [], purchases = [] }) {
  const purchaseById = new Map(purchases.map((p) => [idString(p._id), p]));
  const regularEntries = ledgerEntries.filter((e) => !isLegacySharedBudgetLedger(e));
  const excludedSharedEntries = ledgerEntries.filter(isLegacySharedBudgetLedger);
  const perMember = {};
  const virtualRows = [];
  const issues = [];
  let scheduled = 0;

  for (const item of installments) {
    if (item.month !== month) continue;
    const p = purchaseById.get(idString(item.purchaseId));
    const amount = roundCurrency(item.amount);
    if (!p) {
      issues.push({ code: "MISSING_SHARED_PURCHASE", installmentId: idString(item._id) });
      continue;
    }
    if (!Number.isFinite(Number(item.amount)) || amount <= 0) {
      issues.push({ code: "INVALID_SHARED_ALLOCATION", installmentId: idString(item._id) });
      continue;
    }
    const userId = idString(item.userId);
    const category = p.categoryId;
    const sourceId = idString(item._id);
    perMember[userId] = roundCurrency((perMember[userId] || 0) + amount);
    scheduled = roundCurrency(scheduled + amount);
    virtualRows.push({
      _id: `scheduled_${sourceId}`,
      virtual: true,
      isBudgetAllocation: true,
      entryType: "expense",
      financialType: "debt",
      module: "shared_purchase",
      sourceType: "shared_purchase_schedule",
      sourceId,
      month,
      date: item.dueDate,
      categoryId: category || null,
      paidByUserId: null, // liability is NOT evidence this member paid cash
      receivedByUserId: null,
      affectsSettlement: false, // repayment is independently managed
      amountTotal: amount,
      note: `${p.title || "Large purchase"} · scheduled monthly allocation (not a payment)`,
      splits: [{ userId: item.userId, shareAmount: amount }],
    });
  }
  const postedShared = roundCurrency(excludedSharedEntries
    .filter((e) => e.entryType === "expense")
    .reduce((s, e) => s + Number(e.amountTotal || 0), 0));
  const ordinaryExpense = roundCurrency(regularEntries
    .filter((e) => e.entryType === "expense")
    .reduce((s, e) => s + Number(e.amountTotal || 0), 0));

  return {
    entries: [...regularEntries, ...virtualRows],
    regularEntries,
    virtualRows,
    summary: {
      ordinaryPostedExpense: ordinaryExpense,
      legacySharedPostedExcluded: postedShared,
      scheduledLargePurchaseAllocation: scheduled,
      allBudgetExpenses: roundCurrency(ordinaryExpense + scheduled),
      changeFromPostedLedger: roundCurrency(scheduled - postedShared),
      byMember: perMember,
      issues,
      kind: "monthly_budget_allocation_not_cash_flow",
    },
  };
}

