import { createHash } from 'node:crypto';
import { accountIdOf, toCents, fromCents, validMonth } from './reconciledAccountMath.js';

export const CARRY_FORWARD_FIRST_EDITABLE_MONTH = '2026-10';
export const BLOCKING_RECONCILIATION_CODES = new Set([
  'INVALID_SPLIT_FUNDING', 'UNKNOWN_ACCOUNT', 'INVALID_TRANSACTION_AMOUNT',
  'UNKNOWN_TRANSACTION_TYPE', 'DUPLICATE_ACCOUNT', 'SNAPSHOT_ACCOUNT_MISSING',
  'CLOSED_SNAPSHOT_ACCOUNT_MISSING',
]);

export function getDhakaCurrentMonth(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit',
  }).format(now).slice(0, 7);
}
export function mayCloseMonth(month, now = new Date()) {
  return validMonth(month) && month < getDhakaCurrentMonth(now);
}
export function writableMonth(month) {
  return validMonth(month) && month >= CARRY_FORWARD_FIRST_EDITABLE_MONTH;
}
export function snapshotTotal(rows = []) {
  return fromCents(rows.reduce((sum, row) => sum + toCents(row.balance), 0));
}
export function manualClosingOverrides(systemRows, raw = []) {
  if (!Array.isArray(raw)) throw new Error('accountBalances must be an array.');
  const allowed = new Set(systemRows.map((row) => accountIdOf(row.accountId)));
  const entries = new Map();
  for (const row of raw) {
    const id = accountIdOf(row?.accountId);
    if (!id || !allowed.has(id)) throw new Error('Unknown or missing account in closing balances. Refresh the month.');
    if (entries.has(id)) throw new Error('Duplicate account in closing balances.');
    if (row.balance === null || row.balance === undefined || row.balance === '' || typeof row.balance === 'boolean') {
      throw new Error('Each manually adjusted balance must be a valid number.');
    }
    const amount = Number(row.balance);
    if (!Number.isFinite(amount) || Math.abs(amount) > 1e12 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
      throw new Error('Account balance must be finite and have at most 2 decimal places.');
    }
    entries.set(id, fromCents(toCents(amount)));
  }
  const accounts = systemRows.map((row) => {
    const id = accountIdOf(row.accountId);
    const sys = fromCents(toCents(row.systemBalance ?? row.balance));
    const balance = entries.has(id) ? entries.get(id) : sys;
    return {
      accountId: row.accountId, name: row.name || '', type: row.type || '', owner: row.owner || '',
      balance, systemBalance: sys, manualEdited: toCents(balance) !== toCents(sys),
    };
  });
  return { accounts, total: snapshotTotal(accounts), manualAdjusted: accounts.some((r) => r.manualEdited) };
}
export function fingerprintReconciliation(reconciled) {
  const rows = (reconciled.systemClosing.accounts || []).map((r) => [
    accountIdOf(r.accountId), toCents(r.balance), r.type || '', r.owner || '',
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const issues = (reconciled.issues || []).map((i) => [i.code, i.transactionId || '', i.accountId || '', i.count || 0]);
  return createHash('sha256').update(JSON.stringify({
    month: reconciled.month, anchor: reconciled.anchorMonth, rows, issues,
    opening: toCents(reconciled.opening.total),
  })).digest('hex');
}
export function blockersFromIssues(issues = []) {
  return issues.filter((issue) => BLOCKING_RECONCILIATION_CODES.has(issue.code));
}
export function snapshotConflict(doc, expectedVersion) {
  // The client must explicitly acknowledge the exact saved snapshot seen in GET.
  return String(doc?.updatedAt?.toISOString?.() || '') !== String(expectedVersion || '');
}
