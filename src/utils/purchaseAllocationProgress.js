/** Read-only monthly view for Shared/Large Purchases.
 * Allocations are NOT bank withdrawals and are not proof of installment payment.
 */
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100);
const money = (c) => Math.round(c) / 100;
export function summarizeAllocationProgress(rows = [], selectedMonth) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(selectedMonth))) {
    throw new Error('Selected month must be YYYY-MM');
  }
  const priorMonths = new Set();
  let previous = 0, current = 0, future = 0;
  for (const row of rows) {
    const amount = cents(row.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (row.month < selectedMonth) {
      previous += amount;
      priorMonths.add(row.month);
    } else if (row.month === selectedMonth) current += amount;
    else future += amount;
  }
  return {
    previousMonths: [...priorMonths].sort(),
    previousAmount: money(previous),
    currentAmount: money(current),
    throughAmount: money(previous + current),
    futureAmount: money(future),
  };
}
