// Phase 5: pure cash-funding versus cost-responsibility reconciliation.
// Transfers, savings contributions and managed large purchases are deliberately
// excluded from ordinary expense settlement; their cash impact is in Wallet.
const idOf = (v) => String(v?._id ?? v?.id ?? v ?? '');
const cents = (v) => Math.round(Number(v || 0) * 100);
const currency = (v) => v / 100;

export function expensePayments(tx) {
  if (tx?.txType !== 'expense') return [];
  const parts = Array.isArray(tx.paymentParts) ? tx.paymentParts : [];
  if (tx.paymentMode === 'split') {
    return parts.map(p => ({ userId: idOf(p.userId), accountId: idOf(p.accountId), cents: cents(p.amount) }));
  }
  const fallback = parts.length && !tx.paidByUserId ? parts[0].userId : tx.paidByUserId;
  return fallback ? [{ userId: idOf(fallback), accountId: idOf(tx.fromAccountId || parts[0]?.accountId), cents: cents(tx.amount) }] : [];
}

export function validatePaymentAllocation(tx) {
  const payments = expensePayments(tx);
  const issues = [];
  if (!payments.length) issues.push('MISSING_PAYER');
  if (payments.some(p => !p.userId || !p.accountId || p.cents <= 0)) issues.push('INVALID_PAYMENT_PART');
  if (payments.reduce((sum,p) => sum + p.cents, 0) !== cents(tx.amount)) issues.push('PAYMENT_TOTAL_MISMATCH');
  return { payments, issues };
}

export function reconcileLedgerMembers({ members = [], entries = [], transactions = [] }) {
  const by = new Map(members.map(m => [idOf(m.userId || m._id || m.id), {
    userId: idOf(m.userId || m._id || m.id), name: m.name || m.userId?.name || 'Member',
    incomeCents: 0, responsibilityCents: 0, paidCents: 0,
  }]));
  const issues = [];
  let familyExpenseCents = 0;
  let assignedExpenseCents = 0;
  let cashPaidCents = 0;
  const linkedExpenseTxIds = new Set();
  for (const e of entries) {
    if (e.virtual || e.isBudgetAllocation || e.affectsSettlement === false ||
      e.module === 'shared_purchase' || e.sourceType === 'shared_purchase_installment') continue;
    const amount = cents(e.amountTotal);
    if (e.entryType === 'expense') {
      familyExpenseCents += amount;
      if (e.sourceType === 'transaction' && e.sourceId) linkedExpenseTxIds.add(idOf(e.sourceId));
    }
    if (!['income', 'expense'].includes(e.entryType)) continue;
    const shares = Array.isArray(e.splits) && e.splits.length
      ? e.splits.map(s => ({ userId: idOf(s.userId), amountCents: cents(s.shareAmount) }))
      : [{ userId: idOf(e.entryType === 'expense' ? e.paidByUserId : e.receivedByUserId), amountCents: amount }];
    if (shares.reduce((s,row) => s + row.amountCents, 0) !== amount) {
      issues.push({ code: 'SPLIT_TOTAL_MISMATCH', entryId: idOf(e._id) });
    }
    for (const s of shares) {
      const member = by.get(s.userId);
      if (!member) {
        issues.push({ code: 'UNKNOWN_SHARE_MEMBER', entryId: idOf(e._id), userId: s.userId });
        continue;
      }
      if (e.entryType === 'income') member.incomeCents += s.amountCents;
      else {
        member.responsibilityCents += s.amountCents;
        assignedExpenseCents += s.amountCents;
      }
    }
  }
  for (const tx of transactions) {
    if (tx.txType !== 'expense' || tx.ledgerEligible === false || tx.budgetImpact === false ||
      tx.settlementImpact === false ||
      ['shared_purchase_upfront','shared_purchase_reimbursement','card_repayment'].includes(String(tx.sourceType || ''))) continue;
    // Never attribute cash paid to an expense without a linked budget entry:
    // flag it instead of inventing a matching liability.
    if (!linkedExpenseTxIds.has(idOf(tx._id))) {
      issues.push({ code: 'UNLINKED_EXPENSE', transactionId: idOf(tx._id) });
      continue;
    }
    const { payments, issues: errors } = validatePaymentAllocation(tx);
    for (const code of errors) issues.push({ code, transactionId: idOf(tx._id) });
    for (const p of payments) {
      const member = by.get(p.userId);
      if (!member) {
        issues.push({ code: 'UNKNOWN_PAYER', transactionId: idOf(tx._id) });
        continue;
      }
      member.paidCents += p.cents;
      cashPaidCents += p.cents;
    }
  }
  const rows = [...by.values()].map(m => ({
    userId: m.userId, name: m.name,
    income: currency(m.incomeCents),
    expenseShare: currency(m.responsibilityCents),
    actuallyPaid: currency(m.paidCents),
    ordinarySettlementNet: currency(m.paidCents - m.responsibilityCents),
    budgetRemaining: currency(m.incomeCents - m.responsibilityCents),
  }));
  const settlementGapCents = cashPaidCents - assignedExpenseCents;
  if (familyExpenseCents !== assignedExpenseCents) issues.push({ code: 'FAMILY_SHARES_MISMATCH' });
  if (settlementGapCents !== 0) issues.push({ code: 'CASH_VS_SHARE_GAP', amount: currency(settlementGapCents) });
  return {
    rows,
    ordinaryExpenseTotal: currency(familyExpenseCents),
    paidTotal: currency(cashPaidCents),
    allocatedTotal: currency(assignedExpenseCents),
    ordinarySettlementSum: currency(settlementGapCents),
    issues,
    note: 'Paid describes funding recorded in ordinary expense transactions; share describes allocated responsibility. Settlement excludes large purchases, repayments, savings and prior settlement transfers. See Wallet for final dues and cash balances.'
  };
}
