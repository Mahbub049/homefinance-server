// Pure invariants for new shared-purchase writes. Read-only legacy records are not migrated.
import { isCardCandidate } from './creditCardStatements.js';

export const FIRST_EDITABLE_PURCHASE_MONTH = '2026-10';
export const LIQUID_PURCHASE_ACCOUNT_TYPES = Object.freeze(['cash', 'bank', 'wallet']);

export function purchaseWriteError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function ensureEditablePurchaseMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw purchaseWriteError('Invalid purchase/payment month');
  }
  if (month < FIRST_EDITABLE_PURCHASE_MONTH) {
    throw purchaseWriteError('Months before October 2026 are protected; older purchase records are not changed.', 409);
  }
  return month;
}

export function requireLiquidPurchaseAccount(account) {
  if (!account || account.isActive === false || !LIQUID_PURCHASE_ACCOUNT_TYPES.includes(account.type)) {
    throw purchaseWriteError('Select an active cash, bank or mobile wallet account. Savings and investments cannot fund this purchase/reimbursement.');
  }
  if (isCardCandidate(account)) {
    throw purchaseWriteError('A credit-card account is not a spendable payment source for this purchase. Use an ordinary cash, bank or wallet account.');
  }
  return account;
}

export function requirePendingInstallmentForPayment(installment) {
  if (!installment) throw purchaseWriteError('Installment not found', 404);
  if (!installment.paymentRequired) throw purchaseWriteError('This is a monthly allocation; no reimbursement is required.');
  if (installment.status !== 'pending' || installment.paymentTransactionId || installment.paidAt || installment.ledgerEntryId) {
    throw purchaseWriteError('This installment is already paid or has a historical linked record. Refresh or review it before another payment.', 409);
  }
  return installment;
}

export function requireSafePlanRemoval(purchase, installments) {
  ensureEditablePurchaseMonth(String(purchase?.startMonth || ''));
  for (const item of installments) {
    ensureEditablePurchaseMonth(String(item.month || ''));
    if (item.status === 'paid' || item.paymentTransactionId || item.paidAt || item.fromAccountId || item.toAccountId) {
      throw purchaseWriteError('This purchase has recorded reimbursements. Undo each eligible recent payment first; older payments cannot be deleted.', 409);
    }
    if (item.paymentRequired && item.ledgerEntryId) {
      throw purchaseWriteError('An unpaid installment has a legacy Ledger link. Review it before deleting the purchase.', 409);
    }
  }
}

export function requireLinkedDocument(document, { sourceType, sourceId, amount = null, label = 'Linked financial record' }) {
  if (!document || String(document.sourceType || '') !== String(sourceType) ||
      String(document.sourceId || '') !== String(sourceId || '')) {
    throw purchaseWriteError(`${label} is missing or does not match this purchase. No records were changed.`, 409);
  }
  if (amount !== null && Math.abs(Number(document.amount) - Number(amount)) > 0.009) {
    throw purchaseWriteError(`${label} amount differs from the purchase. No records were changed.`, 409);
  }
  return document;
}
