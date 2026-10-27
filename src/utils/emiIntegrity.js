/**
 * Phase 2C: EMI evidence reconciliation. Pure/read-only: reports what is in the
 * database, not whether a bank or credit-card statement has been paid.
 * Never fabricates transactions or treats an ungenerated bill as a cash outflow.
 */
const id = (value) => String(value?._id || value || '');
const cents = (value) => Math.round(Number(value || 0) * 100);
const amount = (value) => cents(value) / 100;
const validMonth = (month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''));
const severityByCode = Object.freeze({
  duplicate_transaction: 'critical', duplicate_ledger: 'critical', wrong_transaction_source: 'critical',
  wrong_ledger_source: 'critical', transaction_amount_mismatch: 'critical',
  paid_missing_transaction: 'critical', pending_with_payment: 'critical',
  orphan_transaction: 'critical', orphan_ledger: 'critical', overpaid_plan: 'critical',
  paid_missing_ledger: 'warning', split_mismatch: 'warning', transaction_missing_ledger: 'warning',
  transaction_wrong_type: 'warning', paid_missing_account: 'warning',
  payment_date_mismatch: 'warning', closed_with_balance: 'warning',
  fully_paid_active: 'info', possible_credit_card_account: 'warning',
});
const hintByCode = Object.freeze({
  duplicate_transaction: 'Check the linked bank records before removing any duplicate; do not record another payment.',
  duplicate_ledger: 'Review duplicate expense entries and member shares before attempting any correction.',
  wrong_transaction_source: 'Inspect the transaction source reference; automatic repair is unsafe.',
  wrong_ledger_source: 'Inspect the ledger and transaction links; do not rebuild without a backup.',
  transaction_amount_mismatch: 'Compare the installment with the actual payment receipt or statement.',
  paid_missing_transaction: 'Compare against an external payment statement. Do not mark paid again or create a fake cash transaction.',
  pending_with_payment: 'A payment may already exist. Do not mark this installment paid again until the links are reviewed.',
  orphan_transaction: 'Check whether this payment belongs to a missing/deleted EMI bill; preserve the cash movement.',
  orphan_ledger: 'Review the expense against its source transaction; preserve the entry until verified.',
  overpaid_plan: 'Verify original plan total and payment receipts before changing the schedule.',
  paid_missing_ledger: 'Compare the recorded cash payment with ledger entries before restoring any missing expense.',
  split_mismatch: 'Review which member is responsible; do not modify cash to fix an expense-share mismatch.',
  transaction_missing_ledger: 'Check the cash record and missing expense entry manually.',
  transaction_wrong_type: 'The linked transaction should be an expense. Review its history manually.',
  paid_missing_account: 'Verify the funding account before trusting the cash-balance movement.',
  payment_date_mismatch: 'Check paid date against transaction date; historical monthly totals may differ.',
  closed_with_balance: 'Verify actual bank/card payments before reopening. Closed does not prove settled.',
  fully_paid_active: 'Verify records, then use Close Plan if appropriate; this is not necessarily an error.',
  possible_credit_card_account: 'This account name looks like a credit card but is stored as a bank/cash account. Card credit is not spendable cash; compare the statement and do not add an artificial balance.',
});
export function isPossibleCreditCardAccount(account) {
  return Boolean(account && /\bcredit[\s-]*card\b|\bcard[\s-]*credit\b/i.test(String(account.name || '')));
}
export function auditEmiRecords({
  plans = [], installments = [], transactions = [], ledgerEntries = [], splits = [], accounts = [], asOfMonth = null,
}) {
  if (asOfMonth != null && !validMonth(asOfMonth)) throw new Error('Invalid reconciliation month');
  const issues = [];
  const planNames = new Map(plans.map(p => [id(p._id), p.productName || 'Unnamed EMI']));
  const planByInstallment = new Map(installments.map(i => [id(i._id), id(i.planId)]));
  const accountById = new Map(accounts.map(a => [id(a._id), a]));
  const txById = new Map(transactions.map(t => [id(t._id), t]));
  const ledgerById = new Map(ledgerEntries.map(l => [id(l._id), l]));
  const installmentById = new Map(installments.map(i => [id(i._id), i]));
  const txsBySource = new Map();
  const ledgerByTransaction = new Map();
  const splitsByLedger = new Map();
  const summaryByPlan = new Map(plans.map(p => [id(p._id), {
    planId: id(p._id), productName: p.productName || 'Unnamed EMI', status: p.status || 'active',
    scheduledTotal: amount(p.totalPayable), generatedCount: 0, recordedPaidCount: 0,
    recordedPaidAmount: 0, verifiedLinkedAmount: 0, pendingGeneratedCount: 0,
    recordedUnverifiedAmount: 0, unresolvedScheduledBalance: 0,
    issueCount: 0, critical: 0, warning: 0, info: 0,
  }]));

  const push = (code, label, ref, detail, planId = '', extra = {}) => {
    const severity = severityByCode[code] || 'warning';
    const issue = {
      code, label, ref: id(ref), detail, planId: id(planId), severity,
      suggestedAction: hintByCode[code] || 'Review the source records manually.', ...extra,
    };
    issues.push(issue);
    const s = summaryByPlan.get(issue.planId);
    if (s) { s.issueCount++; s[severity]++; }
  };

  for (const tx of transactions) {
    const key = id(tx.sourceId);
    if (!key) continue;
    if (!txsBySource.has(key)) txsBySource.set(key, []);
    txsBySource.get(key).push(tx);
  }
  for (const entry of ledgerEntries) {
    if (entry.sourceType === 'transaction') {
      const key = id(entry.sourceId);
      if (!ledgerByTransaction.has(key)) ledgerByTransaction.set(key, []);
      ledgerByTransaction.get(key).push(entry);
    }
  }
  for (const row of splits) {
    const key = id(row.ledgerEntryId);
    if (!splitsByLedger.has(key)) splitsByLedger.set(key, []);
    splitsByLedger.get(key).push(row);
  }

  for (const inst of installments) {
    const key = id(inst._id);
    const planKey = id(inst.planId);
    const s = summaryByPlan.get(planKey);
    const linkedTx = txById.get(id(inst.transactionId));
    const linkedLedger = ledgerById.get(id(inst.ledgerEntryId));
    const txs = txsBySource.get(key) || [];
    if (s) s.generatedCount++;
    if (txs.length > 1) push('duplicate_transaction', 'Duplicate EMI payments', key, `${inst.month}: multiple cash transactions refer to one installment.`, planKey);
    if (inst.status === 'paid') {
      if (s) {
        s.recordedPaidCount++;
        s.recordedPaidAmount = amount(s.recordedPaidAmount + Number(inst.amount || 0));
      }
      if (!inst.transactionId || !linkedTx) {
        push('paid_missing_transaction', 'Paid installment without cash transaction', key, `${inst.month}: marked paid but linked cash movement is missing.`, planKey);
      } else {
        if (id(linkedTx.sourceId) !== key) {
          push('wrong_transaction_source', 'Payment linked to a different installment', key, `${inst.month}: source reference mismatch.`, planKey);
        }
        if (cents(linkedTx.amount) !== cents(inst.amount)) {
          push('transaction_amount_mismatch', 'Payment differs from installment', key, `${inst.month}: recorded cash ${amount(linkedTx.amount)} versus scheduled ${amount(inst.amount)}.`, planKey);
        }
        if (linkedTx.txType && linkedTx.txType !== 'expense') {
          push('transaction_wrong_type', 'EMI transaction is not an expense', key, `${inst.month}: linked cash transaction has type ${linkedTx.txType}.`, planKey);
        }
        if (inst.paidAt && linkedTx.date && String(new Date(inst.paidAt).toISOString().slice(0, 10)) !== String(new Date(linkedTx.date).toISOString().slice(0, 10))) {
          push('payment_date_mismatch', 'Paid date differs from cash date', key, `${inst.month}: transaction and EMI paid date differ.`, planKey);
        }
        if (accounts.length && !accountById.has(id(linkedTx.fromAccountId))) {
          push('paid_missing_account', 'EMI payment source account missing', key, `${inst.month}: linked transaction account is absent.`, planKey);
        }
        const funding = accountById.get(id(linkedTx.fromAccountId));
        if (isPossibleCreditCardAccount(funding) && ['bank', 'wallet', 'cash'].includes(funding.type)) {
          push('possible_credit_card_account', 'Possible credit-card funding misclassified as cash', key,
            `${inst.month}: "${funding.name}" is classified as ${funding.type}; the available cash figure may be overstated.`, planKey);
        }
        if (id(linkedTx.sourceId) === key && cents(linkedTx.amount) === cents(inst.amount) && (!linkedTx.txType || linkedTx.txType === 'expense')) {
          if (s) s.verifiedLinkedAmount = amount(s.verifiedLinkedAmount + Number(inst.amount || 0));
        }
      }
      if (!inst.ledgerEntryId || !linkedLedger) {
        push('paid_missing_ledger', 'Paid EMI missing expense entry', key, `${inst.month}: expense ledger link is missing.`, planKey);
      } else {
        if (!linkedTx || id(linkedLedger.sourceId) !== id(linkedTx._id) || linkedLedger.sourceType !== 'transaction') {
          push('wrong_ledger_source', 'Expense linked to a different transaction', key, `${inst.month}: ledger reference mismatch.`, planKey);
        }
        if ((splitsByLedger.get(id(inst.ledgerEntryId)) || []).reduce((sum, r) => sum + cents(r.shareAmount), 0) !== cents(inst.amount)) {
          push('split_mismatch', 'Member expense shares do not balance', key, `${inst.month}: member shares differ from the installment.`, planKey);
        }
      }
    } else {
      if (s) s.pendingGeneratedCount++;
      if (inst.transactionId || inst.ledgerEntryId || txs.length) {
        push('pending_with_payment', 'Pending installment has payment evidence', key, `${inst.month}: payment records exist despite pending status.`, planKey);
      }
    }
  }
  for (const tx of transactions) {
    const planId = planByInstallment.get(id(tx.sourceId)) || '';
    if (!installmentById.has(id(tx.sourceId))) {
      push('orphan_transaction', 'EMI cash transaction without installment', tx._id, 'The source installment could not be found.', planId);
    }
    const entries = ledgerByTransaction.get(id(tx._id)) || [];
    if (!entries.length) push('transaction_missing_ledger', 'EMI transaction without ledger entry', tx._id, 'Cash moved but expense record is missing.', planId);
    if (entries.length > 1) push('duplicate_ledger', 'Multiple ledger entries for one payment', tx._id, 'More than one EMI expense entry links to this cash transaction.', planId);
  }
  for (const entry of ledgerEntries) {
    if (entry.sourceType === 'transaction' && !txById.has(id(entry.sourceId))) {
      push('orphan_ledger', 'EMI expense without source transaction', entry._id, 'Expense may exist without a matching cash transaction.');
    }
  }
  for (const plan of plans) {
    const key = id(plan._id);
    const s = summaryByPlan.get(key);
    const paid = cents(s.recordedPaidAmount);
    const total = cents(plan.totalPayable);
    s.unresolvedScheduledBalance = Math.max(0, amount((total - paid) / 100));
    s.recordedUnverifiedAmount = Math.max(0, amount(s.recordedPaidAmount - s.verifiedLinkedAmount));
    if (paid > total) push('overpaid_plan', 'Recorded EMI exceeds plan total', plan._id, `${plan.productName}: recorded installments exceed total by ${amount((paid - total) / 100)} BDT.`, key);
    if (plan.status === 'closed' && paid < total) {
      push('closed_with_balance', 'Closed plan with incomplete payment evidence', plan._id,
        `${plan.productName}: ${amount((total - paid) / 100)} BDT has no recorded paid installment; this is not proof of an unpaid bank bill.`, key);
    }
    if (plan.status === 'active' && paid >= total && total > 0) {
      push('fully_paid_active', 'Fully paid EMI still marked active', plan._id, `${plan.productName}: review plan status.`, key);
    }
  }
  const byCode = {};
  const severitySummary = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    byCode[issue.code] = (byCode[issue.code] || 0) + 1;
    severitySummary[issue.severity]++;
  }
  const planSummaries = [...summaryByPlan.values()].sort((a, b) => b.critical - a.critical || b.warning - a.warning || b.issueCount - a.issueCount || a.productName.localeCompare(b.productName));
  return {
    checked: { plans: plans.length, installments: installments.length, transactions: transactions.length, ledgerEntries: ledgerEntries.length },
    asOfMonth, issueCount: issues.length, byCode, severitySummary, planSummaries,
    issues: issues.slice(0, 150), truncated: issues.length > 150, readOnly: true,
    evidenceNote: 'Bank or credit-card statement verification is not possible from app records alone. Missing history is not proof of unpaid debt.',
  };
}
