// Integer-cents schedule; never reassign amounts from protected/paid months.
export const cents = v => Math.round(Number(v || 0) * 100);
export function splitCents(total, months) {
  const value = Number(total);
  if (!Number.isInteger(value) || value <= 0 || !Number.isInteger(months) || months < 1 || months > 120) {
    throw new Error('Invalid future installment amount or duration');
  }
  const per = Math.floor(value / months);
  return Array.from({length: months}, (_, index) => (index === months - 1 ? value - per * (months - 1) : per) / 100);
}
export function futureRemainder(shareAmount, preserved) {
  const remaining = cents(shareAmount) - (preserved || []).reduce((sum, p) => sum + cents(p.amount), 0);
  if (remaining <= 0) throw new Error('No positive amount remains for this member');
  return remaining;
}
export function isPostedInstallment(item) {
  return item.status === 'paid' || Boolean(item.paymentTransactionId || item.paidAt || item.fromAccountId || item.toAccountId);
}
export function canReviseFuture(item) {
  return !isPostedInstallment(item) && (!item.paymentRequired || !item.ledgerEntryId);
}
