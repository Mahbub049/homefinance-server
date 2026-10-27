/**
 * Phase 8: read-only, cent-based consistency checks across Wallet, Ledger,
 * posted account movements, Carry Forward and member settlement. No writes.
 * A matched calculation means the *records agree*, not the bank has confirmed it.
 */
import { toCents, fromCents, LIQUID_TYPES } from './reconciledAccountMath.js';

const liquidTypes = new Set(LIQUID_TYPES);
const sum = (list, fn) => (list || []).reduce((total, item) => total + toCents(fn(item)), 0);
const idOf = (value) => String(value?._id ?? value ?? '');

export function reconcileWalletMonth({
  month, accountStatement, monthlyFlow, expenseIntegrity, users = [],
  settlementSummary = [], settlements = [], verifiedSettlementIds = [],
  recordedIncome = null,
}) {
  const issues = [];
  const add = (code, level, message, details = {}) => issues.push({ code, level, message, ...details });
  const opening = (accountStatement?.opening?.accounts || []).filter(r => liquidTypes.has(r.type));
  const systemClosing = (accountStatement?.systemClosing?.accounts || []).filter(r => liquidTypes.has(r.type));
  const finalClosing = (accountStatement?.closing?.accounts || []).filter(r => liquidTypes.has(r.type));
  const openingTotal = sum(opening, r => r.balance);
  const calculatedClosing = sum(systemClosing, r => r.balance);
  const savedClosing = sum(finalClosing, r => r.balance);
  const monthlyNet = toCents(monthlyFlow?.household?.remainingFromMonth);
  const cashDifference = calculatedClosing - openingTotal - monthlyNet;
  if (Math.abs(cashDifference) > 1) {
    add('ACCOUNT_VS_MONTH_FLOW', 'blocking', 'Monthly cash movements do not match the account opening-to-closing change.', { difference: fromCents(cashDifference) });
  }
  const snapshotDifference = savedClosing - calculatedClosing;
  if (accountStatement?.closed && Math.abs(snapshotDifference) > 1) {
    add('MANUAL_CLOSING_DIFFERENCE', 'review', 'The saved closing balance differs from transaction-calculated cash. Check approved manual closing adjustments.', { difference: fromCents(snapshotDifference) });
  }
  const flowsByOwner = monthlyFlow?.byOwner || {};
  const owners = new Set([...opening, ...systemClosing].map(r => r.owner || 'Unassigned'));
  for (const owner of owners) {
    const begin = sum(opening.filter(r => (r.owner || 'Unassigned') === owner), r => r.balance);
    const end = sum(systemClosing.filter(r => (r.owner || 'Unassigned') === owner), r => r.balance);
    const expected = toCents(flowsByOwner[owner]?.remainingFromMonth);
    if (Math.abs(end - begin - expected) > 1) {
      add('OWNER_FLOW_MISMATCH', 'blocking', `${owner}: recorded owner cash movement does not equal account movement.`, { owner, difference: fromCents(end - begin - expected) });
    }
  }
  for (const row of finalClosing) {
    if (toCents(row.balance) < 0) {
      add('NEGATIVE_ACCOUNT_BALANCE', 'review', `${row.name || 'Account'} has a negative calculated liquid balance. Check opening balances and missing postings.`, { accountId: idOf(row.accountId), balance: row.balance });
    }
  }
  for (const error of accountStatement?.issues || []) {
    const advisory = ['STALE_CLOSED_MONTH', 'MANUAL_CLOSING_ADJUSTMENT'].includes(error.code);
    add(error.code || 'ACCOUNT_ISSUE', advisory ? 'review' : 'blocking', `Account reconciliation issue: ${error.code || 'unknown'}.`, { accountId: idOf(error.accountId), transactionId: idOf(error.transactionId) });
  }
  for (const error of monthlyFlow?.issues || []) {
    add(error.code || 'FLOW_ISSUE', 'blocking', `Monthly cash-flow issue: ${error.code || 'unknown'}.`, { transactionId: idOf(error.transactionId) });
  }
  if (expenseIntegrity?.balanced === false) {
    add('EXPENSE_SHARE_MISMATCH', 'blocking', 'Ledger expense funding, source transactions or assigned member shares do not reconcile.', { difference: Number(expenseIntegrity.discrepancy || 0) });
    for (const detail of expenseIntegrity?.issues || []) {
      add(detail.code, 'blocking', `Expense source-integrity issue: ${detail.code}.`, { ledgerEntryId: detail.ledgerEntryId });
    }
  }
  const expenseNetSum = sum(users, u => u.expenseNet);
  if (Math.abs(expenseNetSum) > 1) {
    add('ORDINARY_SETTLEMENT_NOT_ZERO_SUM', 'blocking', 'Member ordinary settlements do not cancel out.', { difference: fromCents(expenseNetSum) });
  }
  const finalNetSum = sum(users, u => u.net);
  if (Math.abs(finalNetSum) > 1) {
    add('FINAL_SETTLEMENT_NOT_ZERO_SUM', 'blocking', 'Member final settlement positions do not cancel out.', { difference: fromCents(finalNetSum) });
  }
  const pendingPay = sum(settlementSummary, r => r.pendingPay);
  const pendingReceive = sum(settlementSummary, r => r.pendingReceive);
  if (Math.abs(pendingPay - pendingReceive) > 1) {
    add('SETTLEMENT_DIRECTIONS_MISMATCH', 'blocking', 'Member amounts payable and receivable do not match.', { difference: fromCents(pendingPay - pendingReceive) });
  }
  const verified = new Set(verifiedSettlementIds.map(idOf));
  const seenTransferIds = new Set();
  for (const record of settlements) {
    if (record.settlementType !== 'wallet' || record.status !== 'settled') continue;
    const txId = idOf(record.transactionId);
    if (!txId || !verified.has(idOf(record._id))) {
      add('UNVERIFIED_WALLET_SETTLEMENT', 'blocking', 'A Wallet settlement has no matching, verified cash transfer.', { settlementId: idOf(record._id) });
    }
    if (txId && seenTransferIds.has(txId)) {
      add('DUPLICATE_SETTLEMENT_TRANSFER', 'blocking', 'Multiple Wallet settlements reference the same transfer.', { transactionId: txId });
    }
    if (txId) seenTransferIds.add(txId);
  }
  const recordedIncomeCents = recordedIncome == null ? null : toCents(recordedIncome);
  const liquidIncomeCents = toCents(monthlyFlow?.household?.income);
  if (recordedIncomeCents != null && Math.abs(recordedIncomeCents - liquidIncomeCents) > 1) {
    add('INCOME_VS_LIQUID_POSTING', 'review', 'Ledger income differs from income credited to tracked liquid accounts. Check missing or non-liquid funding.', { difference: fromCents(recordedIncomeCents - liquidIncomeCents) });
  }
  const blocking = issues.filter(i => i.level === 'blocking').length;
  const review = issues.filter(i => i.level === 'review').length;
  return {
    month, status: blocking ? 'needs_correction' : review ? 'needs_review' : 'internally_consistent',
    blocking, review, issues,
    checks: { openingLiquid: fromCents(openingTotal), monthCashMovement: fromCents(monthlyNet),
      expectedClosingLiquid: fromCents(openingTotal + monthlyNet), calculatedClosingLiquid: fromCents(calculatedClosing),
      reportedClosingLiquid: fromCents(savedClosing), cashDifference: fromCents(cashDifference),
      ordinarySettlementSum: fromCents(expenseNetSum), finalSettlementSum: fromCents(finalNetSum),
      pendingPay: fromCents(pendingPay), pendingReceive: fromCents(pendingReceive) },
    disclaimer: 'Internal consistency only. Balances are not verified with banks. Scheduled/unpaid EMI and purchases do not reduce cash before a recorded payment.',
  };
}
