/**
 * Read-only reconciliation of who funded a Ledger expense vs who bears its cost.
 * Both dashboard and wallet use this code. A source-linked Transaction is the
 * authoritative funding record; an unlinked legacy Ledger row uses paidByUserId.
 * Never use a budget-only shared-purchase allocation as an actual cash payment.
 */
export function idOf(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || value.id || value);
  return String(value);
}

export function toCents(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

export function fromCents(value) {
  return Math.round(value) / 100;
}

export function fundedRowsForLedgerEntry(entry, transaction) {
  if (entry.entryType !== "expense" || entry.affectsSettlement === false) return [];

  if (transaction) {
    if (transaction.txType !== "expense" || transaction.settlementImpact === false) return [];
    const parts = Array.isArray(transaction.paymentParts) ? transaction.paymentParts : [];
    if (transaction.paymentMode === "split") {
      // A malformed split must not silently turn into a full single-payer payment.
      return parts
        .filter((part) => idOf(part.userId) && toCents(part.amount) > 0)
        .map((part) => ({ userId: idOf(part.userId), amountCents: toCents(part.amount) }));
    }
    const payerId = idOf(transaction.paidByUserId) || idOf(entry.paidByUserId);
    return payerId ? [{ userId: payerId, amountCents: toCents(transaction.amount) }] : [];
  }

  // Legacy manual ledger entries may not have a Transaction yet. Never imply that
  // a linked transaction missing from the DB was paid via the Ledger field.
  if (entry.sourceType === "transaction" && entry.sourceId) return [];
  const payerId = idOf(entry.paidByUserId);
  return payerId ? [{ userId: payerId, amountCents: toCents(entry.amountTotal) }] : [];
}

export function buildLedgerPaymentRows(entries, transactions) {
  const transactionById = new Map(transactions.map((transaction) => [idOf(transaction._id), transaction]));
  const rowsByEntry = new Map();
  for (const entry of entries) {
    const linkedTx = entry.sourceType === "transaction" ? transactionById.get(idOf(entry.sourceId)) : null;
    rowsByEntry.set(idOf(entry._id), fundedRowsForLedgerEntry(entry, linkedTx));
  }
  return rowsByEntry;
}

export function calculateOrdinaryExpenseShares({ entries, splits, transactions, userIds }) {
  const paidInCents = Object.fromEntries(userIds.map((id) => [idOf(id), 0]));
  const shareInCents = Object.fromEntries(userIds.map((id) => [idOf(id), 0]));
  const issues = [];
  const eligibleEntries = entries.filter((entry) => entry.entryType === "expense" && entry.affectsSettlement !== false);
  const eligibleEntryIds = new Set(eligibleEntries.map((entry) => idOf(entry._id)));
  const rowsByEntry = buildLedgerPaymentRows(eligibleEntries, transactions);
  const linkedTx = new Map(transactions.map(t => [idOf(t._id), t]));
  const sharesByEntry = new Map();
  for (const split of splits) {
    const id = idOf(split.ledgerEntryId);
    sharesByEntry.set(id, (sharesByEntry.get(id) || 0) + toCents(split.shareAmount));
  }
  for (const entry of eligibleEntries) {
    const id = idOf(entry._id);
    const posted = toCents(entry.amountTotal);
    const shares = sharesByEntry.get(id) || 0;
    if (shares !== posted) {
      issues.push({ code: 'LEDGER_SHARE_TOTAL_MISMATCH', ledgerEntryId: id, difference: fromCents(posted - shares) });
    }
    if (entry.sourceType === 'transaction' && entry.sourceId) {
      const tx = linkedTx.get(idOf(entry.sourceId));
      if (!tx) {
        issues.push({ code: 'MISSING_LINKED_EXPENSE_TRANSACTION', ledgerEntryId: id });
      } else {
        if (toCents(tx.amount) !== posted) {
          issues.push({ code: 'LEDGER_TRANSACTION_AMOUNT_MISMATCH', ledgerEntryId: id });
        }
        const funding = (rowsByEntry.get(id) || []).reduce((n, row) => n + row.amountCents, 0);
        if (funding !== toCents(tx.amount)) {
          issues.push({ code: 'EXPENSE_FUNDING_MISMATCH', ledgerEntryId: id, transactionId: idOf(tx._id) });
        }
      }
    }
  }

  for (const rows of rowsByEntry.values()) {
    for (const row of rows) {
      if (Object.hasOwn(paidInCents, row.userId)) paidInCents[row.userId] += row.amountCents;
    }
  }
  for (const split of splits) {
    if (!eligibleEntryIds.has(idOf(split.ledgerEntryId))) continue;
    const uid = idOf(split.userId);
    if (Object.hasOwn(shareInCents, uid)) shareInCents[uid] += toCents(split.shareAmount);
  }

  const paidMap = Object.fromEntries(Object.entries(paidInCents).map(([id, v]) => [id, fromCents(v)]));
  const shareMap = Object.fromEntries(Object.entries(shareInCents).map(([id, v]) => [id, fromCents(v)]));
  const paidTotalCents = Object.values(paidInCents).reduce((sum, n) => sum + n, 0);
  const shareTotalCents = Object.values(shareInCents).reduce((sum, n) => sum + n, 0);
  return {
    paidMap,
    shareMap,
    paidTotal: fromCents(paidTotalCents),
    shareTotal: fromCents(shareTotalCents),
    settlementDiscrepancy: fromCents(paidTotalCents - shareTotalCents),
    balanced: paidTotalCents === shareTotalCents && issues.length === 0,
    issues,
    rowsByEntry,
  };
}
