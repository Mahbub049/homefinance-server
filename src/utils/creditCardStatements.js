/**
 * Phase 4C-A: manually verified MONTH-END credit-card statement balances.
 * They are a separate liability observation; saving them does NOT create an
 * expense, income, EMI installment, Ledger entry or bank transfer.
 */
import { toCents, fromCents, accountIdOf, validMonth } from './reconciledAccountMath.js';

export const isCardCandidate = (account) => /\bcredit[\s-]*card\b/i.test(String(account?.name || ''));

export function validateStatement({month, amount}) {
  if (!validMonth(month)) return 'Month must be YYYY-MM';
  if (amount == null || String(amount).trim() === '' || !Number.isFinite(Number(amount)) || Number(amount) < 0 || Number(amount) > 1e10) {
    return 'Outstanding amount must be a non-negative number';
  }
  if (Math.abs(Number(amount) * 100 - Math.round(Number(amount) * 100)) > 1e-6) {
    return 'Outstanding amount cannot have more than two decimal places';
  }
  return null;
}

/**
 * Missing statements are UNKNOWN, not zero. Exact selected month only:
 * do not silently carry a stale debt snapshot into future months.
 */
export function cardStatementCoverage(accounts = [], statements = [], month) {
  const indexed = new Map(statements.filter((s) => String(s.month) === month)
    .map((s) => [accountIdOf(s.accountId), s]));
  let total = 0, present = 0;
  const cards = accounts.map((acc) => {
    const id = accountIdOf(acc.accountId || acc._id);
    const statement = indexed.get(id);
    const valid = statement && validateStatement({month: statement.month, amount: statement.outstanding}) === null;
    if (valid) { total += toCents(statement.outstanding); present++; }
    return {
      accountId: id,
      name: String(acc.name || ''),
      owner: String(acc.owner || ''),
      outstanding: valid ? fromCents(toCents(statement.outstanding)) : null,
      note: valid ? String(statement.note || '') : '',
      status: valid ? 'recorded' : 'missing',
    };
  });
  const complete = cards.length > 0 && present === cards.length;
  return {
    month,
    candidateCount: cards.length,
    recordedCount: present,
    missingCount: cards.length - present,
    recordedOutstanding: fromCents(total),
    // Null for missing coverage. A true 0 is a useful explicit statement.
    totalOutstanding: complete ? fromCents(total) : null,
    complete,
    cards,
  };
}
