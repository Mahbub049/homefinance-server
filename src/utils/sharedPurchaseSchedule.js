/**
 * Shared/Large Purchase schedule reporting (READ MODEL ONLY).
 * A purchase has one real upfront debit. Every person's scheduled allocation
 * exists independently of their reimbursement. A reimbursement moves cash
 * between family members and never creates a second household purchase.
 */
// Shared purchase Wallet verification must select every property consumed by
// validReimbursement(). In particular paymentRequired is NOT optional: if the
// Mongo projection omits it, every already-paid installment appears unpaid.
export const WALLET_SHARED_REIMBURSEMENT_FIELDS =
  "purchaseId userId amount paymentRequired status paidAt paymentTransactionId fromAccountId toAccountId";

export const roundCurrency = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

export function idString(value) {
  if (!value) return "";
  if (typeof value !== "object") return String(value);
  // BSON ObjectId.id is a binary buffer, NOT the printable hex ID.
  if (typeof value.toHexString === "function") return value.toHexString();
  if (value._id && value._id !== value) return idString(value._id);
  if (typeof value.id === "string") return value.id;
  const printed = typeof value.toString === "function" ? value.toString() : "";
  return printed === "[object Object]" ? "" : printed;
}

export function validReimbursement(installment, purchase, transaction) {
  if (!installment?.paymentRequired || installment.status !== "paid" || !installment.paidAt || !transaction) return false;
  const amount = roundCurrency(installment.amount);
  return (
    transaction.txType === "transfer" &&
    transaction.sourceType === "shared_purchase_reimbursement" &&
    idString(transaction.sourceId) === idString(installment._id) &&
    idString(transaction.paidByUserId) === idString(installment.userId) &&
    idString(transaction.receivedByUserId) === idString(purchase.payerUserId) &&
    idString(transaction.fromAccountId) === idString(installment.fromAccountId) &&
    idString(transaction.toAccountId) === idString(installment.toAccountId) &&
    Math.abs(roundCurrency(transaction.amount) - amount) < 0.01
  );
}

function paidMonth(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function summarizePurchaseInstallments(installments, selectedMonth, purchase, transactionsById = new Map()) {
  const summary = {
    totalAllocation: 0,
    receivableTotal: 0,
    receivedLifetime: 0,
    outstandingAllSchedule: 0,
    scheduledAllocationThisMonth: 0,
    scheduledReimbursementThisMonth: 0,
    dueThisMonth: 0,
    overdueBeforeMonth: 0,
    dueThroughMonth: 0,
    futureUnpaid: 0,
    receivedThisMonth: 0,
    invalidPaymentRecords: 0,
    paidCount: 0,
    paymentCount: 0,
  };
  const rows = [];

  for (const row of installments) {
    const amount = roundCurrency(row.amount);
    const tx = transactionsById.get(idString(row.paymentTransactionId));
    const verified = validReimbursement(row, purchase, tx);
    const paidAsOfMonth = verified && paidMonth(row.paidAt) <= selectedMonth;
    const paymentMonth = verified ? paidMonth(row.paidAt) : "";
    const due = row.month <= selectedMonth && !paidAsOfMonth;
    const mismatch = row.paymentRequired && row.status === "paid" && !verified;
    const enriched = {
      ...row,
      paymentVerified: verified,
      needsPaymentReview: mismatch,
      unpaidAsOfMonth: Boolean(row.paymentRequired && due),
      paidAsOfMonth,
    };
    rows.push(enriched);
    summary.totalAllocation = roundCurrency(summary.totalAllocation + amount);

    if (row.month === selectedMonth) {
      summary.scheduledAllocationThisMonth = roundCurrency(summary.scheduledAllocationThisMonth + amount);
    }
    if (!row.paymentRequired) continue;

    summary.paymentCount += 1;
    summary.receivableTotal = roundCurrency(summary.receivableTotal + amount);
    if (row.month === selectedMonth) {
      summary.scheduledReimbursementThisMonth = roundCurrency(summary.scheduledReimbursementThisMonth + amount);
    }
    if (verified) {
      summary.paidCount += 1;
      summary.receivedLifetime = roundCurrency(summary.receivedLifetime + amount);
      if (paymentMonth === selectedMonth) {
        summary.receivedThisMonth = roundCurrency(summary.receivedThisMonth + amount);
      }
    } else {
      summary.outstandingAllSchedule = roundCurrency(summary.outstandingAllSchedule + amount);
    }
    if (mismatch) summary.invalidPaymentRecords += 1;
    if (due) {
      summary.dueThroughMonth = roundCurrency(summary.dueThroughMonth + amount);
      if (row.month === selectedMonth) {
        summary.dueThisMonth = roundCurrency(summary.dueThisMonth + amount);
      } else {
        summary.overdueBeforeMonth = roundCurrency(summary.overdueBeforeMonth + amount);
      }
    } else if (row.month > selectedMonth && !paidAsOfMonth) {
      summary.futureUnpaid = roundCurrency(summary.futureUnpaid + amount);
    }
  }

  summary.progress = summary.receivableTotal > 0
    ? roundCurrency(summary.receivedLifetime / summary.receivableTotal * 100) : 100;
  return { summary, installments: rows };
}
