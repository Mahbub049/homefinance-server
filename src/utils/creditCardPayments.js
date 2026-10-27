/**
 * Phase 4C-B: conservative cash-side recording of credit-card repayments.
 * A repayment is a reduction in bank/cash, never another household purchase.
 * Month-end statements are independent bank snapshots and are NOT
 * automatically reduced by repayments already reflected in those statements.
 */
import { toCents, fromCents, validMonth } from './reconciledAccountMath.js';
import { isCardCandidate } from './creditCardStatements.js';

export const FIRST_SAFE_MONTH = '2026-10';
export const REPAYMENT_SOURCE = 'credit_card_repayment';

export function dateParts(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return { month: date.slice(0, 7), at: parsed };
}

export function dhakaToday(now = new Date()) {
  return new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function validateCardRepayment(input, options = {}) {
  const date = dateParts(input?.date);
  if (!date || !validMonth(date.month)) return { error: 'Enter a valid payment date (YYYY-MM-DD).' };
  if (date.month < FIRST_SAFE_MONTH) return { error: 'Historical months before October 2026 are read-only.' };
  if (input.month && input.month !== date.month) return { error: 'Payment date must belong to the selected month.' };
  if (input.date > (options.today || dhakaToday())) return { error: 'Record the payment only after money was actually paid.' };
  const amount = input?.amount;
  if (amount === '' || amount == null || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 1e10)
    return { error: 'Payment must be a positive amount.' };
  if (Math.abs(Number(amount) * 100 - Math.round(Number(amount) * 100)) > 1e-6)
    return { error: 'Payment amount cannot have more than two decimal places.' };
  const note = String(input?.note || '').trim();
  if (note.length > 240) return { error: 'Note must be 240 characters or fewer.' };
  return { data: { date: date.at, dateText: input.date, month: date.month, amount: fromCents(toCents(amount)), note } };
}

export function validateCardFunding(card, funding) {
  if (!card || !isCardCandidate(card)) return 'Select a valid credit-card account.';
  if (!funding || funding.isActive === false || !['cash', 'bank', 'wallet'].includes(funding.type) || isCardCandidate(funding))
    return 'Select an active cash, bank or mobile-wallet funding account (not a credit card).';
  if (String(card._id) === String(funding._id)) return 'Credit card and payment source must be different accounts.';
  // Cross-person repayment needs explicit household settlement accounting,
  // which this release deliberately does not attempt to infer.
  if (card.owner !== 'Joint' && funding.owner !== 'Joint' && String(card.owner) !== String(funding.owner))
    return 'Use the card holder’s account or a joint account. Cross-person card payments need separate settlement support.';
  return null;
}

export function activePaymentSummary(rows = []) {
  let cents = 0;
  let count = 0;
  for (const row of rows) {
    if (row.status === 'voided') continue;
    cents += toCents(row.amount);
    count += 1;
  }
  return { count, amount: fromCents(cents) };
}
