/**
 * Phase 4B: conservative, READ-ONLY financial position from a reconciled month.
 * Never treat card-named bank accounts as verified liquid cash. The app has no
 * credit-card posting/liability model, so no card liability is invented here.
 */
import { LIQUID_TYPES, toCents, fromCents } from './reconciledAccountMath.js';
import { cardStatementCoverage } from './creditCardStatements.js';

const LIQUID = new Set(LIQUID_TYPES);
const NONLIQUID = new Set(['savings', 'investment']);
const CARD_NAME = /\bcredit[\s-]*card\b/i;
const centsOf = (rows) => rows.reduce((sum, row) => sum + toCents(row.balance), 0);
const finite = (n) => Number.isFinite(Number(n));

export function classifyTrackedBalances(rows = []) {
  const liquid = [];
  const savings = [];
  const cardReview = [];
  const unclassified = [];
  const negativeLiquid = [];
  for (const row of rows) {
    if (!finite(row.balance)) { unclassified.push(row); continue; }
    // This name test is only a warning/quarantine; it is NOT an accounting
    // inference about card debt. Renaming accounts changes the review bucket.
    if (CARD_NAME.test(String(row.name || ''))) { cardReview.push(row); continue; }
    if (LIQUID.has(row.type)) {
      liquid.push(row);
      if (toCents(row.balance) < 0) negativeLiquid.push(row);
    } else if (NONLIQUID.has(row.type)) savings.push(row);
    else unclassified.push(row);
  }
  const liquidCents = centsOf(liquid);
  const savingsCents = centsOf(savings);
  return {
    liquidCash: fromCents(liquidCents),
    savingsAndInvestments: fromCents(savingsCents),
    trackedAccountTotal: fromCents(liquidCents + savingsCents),
    cardReviewCount: cardReview.length,
    cardReviewAccounts: cardReview.map((a) => ({ name: a.name, owner: a.owner, accountId: a.accountId, recordedBalance: Number(a.balance) })),
    cardReviewRecordedBalance: fromCents(centsOf(cardReview)),
    negativeLiquidCount: negativeLiquid.length,
    negativeLiquidAccounts: negativeLiquid.map((a) => ({ name: a.name, balance: Number(a.balance) })),
    unclassifiedAccountCount: unclassified.length,
  };
}

/** Active plans only. Registered paid amounts are scoped to as-of month.
 * These are planned/recorded financing obligations, NOT a verified bank debt.
 */
export function summarizeRegisteredEmiBalance(plans = [], installments = [], month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw new Error('Invalid month');
  const byPlan = new Map();
  for (const installment of installments) {
    const id = String(installment.planId?._id || installment.planId || '');
    if (!byPlan.has(id)) byPlan.set(id, []);
    byPlan.get(id).push(installment);
  }
  let remaining = 0, total = 0, paid = 0, missingPaidAt = 0, closedNeedsReview = 0;
  for (const plan of plans) {
    if (String(plan.startMonth || '') > month) continue;
    const totalCents = toCents(plan.totalPayable);
    if (totalCents < 0 || !finite(plan.totalPayable)) continue;
    const payments = byPlan.get(String(plan._id)) || [];
    let paidCents = 0;
    for (const inst of payments) {
      if (inst.status !== 'paid') continue;
      if (inst.paidAt) {
        const paidMonth = new Date(inst.paidAt).toISOString().slice(0, 7);
        if (paidMonth > month) continue;
      } else {
        // Keep legacy recorded payments visible, but report missing evidence.
        missingPaidAt++;
        if (String(inst.month || '') > month) continue;
      }
      paidCents += toCents(inst.amount);
    }
    const remainingCents = Math.max(0, totalCents - paidCents);
    if (plan.status === 'closed') {
      if (remainingCents > 0) closedNeedsReview++;
      continue; // Never re-open a manually closed historical plan.
    }
    total += totalCents;
    paid += paidCents;
    remaining += remainingCents;
  }
  return {
    remainingEMI: fromCents(remaining),
    totalPayableActive: fromCents(total),
    totalPaidActive: fromCents(paid),
    missingPaidAtCount: missingPaidAt,
    closedPlansNeedingReview: closedNeedsReview,
  };
}

export function assemblePosition(accounts, obligations, statement = {}, cardStatements = []) {
  const a = classifyTrackedBalances(accounts);
  const cardCoverage = cardStatementCoverage(a.cardReviewAccounts, cardStatements, statement.month || '');
  const issues = [];
  if (cardCoverage.missingCount) issues.push('CARD_STATEMENTS_MISSING_FOR_MONTH');
  if (a.cardReviewCount) issues.push('CARD_ACCOUNT_REVIEW_REQUIRED');
  if (a.negativeLiquidCount) issues.push('NEGATIVE_LIQUID_BALANCES');
  if (a.unclassifiedAccountCount) issues.push('UNCLASSIFIED_ACCOUNTS');
  if (statement.staleClosedCount) issues.push('STALE_CLOSING_SNAPSHOT');
  if ((statement.issues || []).length) issues.push('ACCOUNT_RECONCILIATION_WARNINGS');
  if (obligations.missingPaidAtCount) issues.push('EMI_PAID_AT_UNVERIFIED');
  if (obligations.closedPlansNeedingReview) issues.push('CLOSED_EMI_HISTORY_UNVERIFIED');
  if (a.cardReviewCount && !cardCoverage.complete) issues.push('CARD_DEBT_NOT_FULLY_RECORDED');
  issues.push('EMI_AND_CARD_LIABILITY_MAY_OVERLAP');
  issues.push('FINANCED_PURCHASE_ASSETS_NOT_VALUED');
  const afterEmi = toCents(a.trackedAccountTotal) - toCents(obligations.remainingEMI);
  return {
    assets: a,
    liabilities: { ...obligations, creditCardOutstanding: cardCoverage.totalOutstanding, creditCards: cardCoverage },
    position: { trackedAccountTotal: a.trackedAccountTotal, afterRegisteredEMIIllustration: fromCents(afterEmi) },
    reconciliation: { anchorMonth: statement.anchorMonth || null, closed: !!statement.closed, staleClosedCount: statement.staleClosedCount || 0, issues },
    status: 'provisional',
    netWorth: null,
  };
}
