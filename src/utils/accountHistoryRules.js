/**
 * Phase 9 / Step 01: guard account identity and opening-balance assumptions.
 * Never rewrite historical financial attribution by editing a live account's
 * opening balance, account kind or ownership. Rename/deactivate separately.
 * Pure, database-free policy helper.
 */
export const accountBalanceCents = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
};

export function parseOpeningBalance(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw Object.assign(new Error('Opening balance must be a valid number.'), { status: 400 });
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n * 100)) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) {
    throw Object.assign(new Error('Opening balance must be a valid amount with at most two decimal places.'), { status: 400 });
  }
  return Math.round(n * 100) / 100;
}

export function sensitiveAccountChanges(account, updates = {}) {
  const changes = [];
  if (updates.type !== undefined && updates.type !== account.type) changes.push('type');
  if (updates.owner !== undefined && updates.owner !== account.owner) changes.push('owner');
  if (updates.openingBalance !== undefined && accountBalanceCents(updates.openingBalance) !== accountBalanceCents(account.openingBalance)) changes.push('openingBalance');
  return changes;
}

export function guardHistoricalAccountUpdate(account, updates, hasHistory) {
  const changes = sensitiveAccountChanges(account, updates);
  if (hasHistory && changes.length) {
    const error = new Error('This account has saved transactions or closing history. Its opening balance, owner and account type cannot be changed retroactively. Rename or deactivate it instead; use a recorded adjustment for a real balance correction.');
    error.status = 409;
    error.fields = changes;
    throw error;
  }
  return changes;
}
