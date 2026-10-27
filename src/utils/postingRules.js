// Pure financial posting invariants, deliberately independent of MongoDB.
// Used by Fixed Expenses, Grocery and Savings. No historical data is migrated.
export function monthOf(dateLike) {
  const date = new Date(dateLike);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

export function postingError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function positiveMoney(value, label = 'Amount') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) / 100 <= 0) {
    throw postingError(`${label} must be a finite amount greater than zero`);
  }
  if (Math.abs(n * 100 - Math.round(n * 100)) > 0.000001) {
    throw postingError(`${label} must not have more than two decimal places`);
  }
  return Math.round(n * 100) / 100;
}

export function nonnegativeMoney(value, label) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0 || Math.abs(n * 100 - Math.round(n * 100)) > 0.000001) {
    throw postingError(`${label} must be a nonnegative amount with at most two decimal places`);
  }
  return Math.round(n * 100) / 100;
}

export function memberAccountOwner(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n.includes('mahbub')) return 'Mahbub';
  if (n.includes('mirza')) return 'Mirza';
  return null;
}

export function ownerAllowed(accountOwner, memberName) {
  const owner = String(accountOwner || '');
  if (owner === 'Joint') return true;
  const person = memberAccountOwner(memberName);
  return Boolean(person && owner === person);
}

export function assertExpenseSplit(rows, total, validUserIds) {
  if (!Array.isArray(rows) || rows.length === 0) throw postingError('At least one member share is required');
  const allowed = new Set(validUserIds.map(String));
  const used = new Set();
  let cents = 0;
  for (const row of rows) {
    const id = String(row.userId || '');
    if (!allowed.has(id) || used.has(id)) throw postingError('Split includes an invalid or duplicate family member');
    used.add(id);
    const share = nonnegativeMoney(row.shareAmount, 'Member share');
    cents += Math.round(share * 100);
  }
  if (cents !== Math.round(positiveMoney(total) * 100)) throw postingError('Member shares must total the complete expense');
  return rows;
}

export function assertSavingsAccountTypes(from, to) {
  if (!from || !['cash','bank','wallet'].includes(from.type)) {
    throw postingError('Deposit source must be an active cash, bank or mobile wallet account');
  }
  if (!to || !['savings','investment'].includes(to.type)) {
    throw postingError('Deposit destination must be an active savings or investment account');
  }
  if (String(from._id) === String(to._id)) throw postingError('Source and destination accounts must be different');
}
