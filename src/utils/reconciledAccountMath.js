/**
 * Phase 1B: pure account-movement arithmetic. All amounts are stored in cents
 * for addition, preventing floating-point drift. The only authoritative money
 * source for cash balances is a real Transaction, never a LedgerEntry budget row.
 */
export const toCents = (value) => Math.round(Number(value || 0) * 100);
export const fromCents = (value) => value / 100;
export function accountIdOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  // BSON ObjectIds have a .id Buffer: never stringify that binary buffer.
  if (typeof value.toHexString === "function") return value.toHexString();
  if (value._id != null && value._id !== value) return accountIdOf(value._id);
  if (value.accountId != null && value.accountId !== value) return accountIdOf(value.accountId);
  return String(value);
}
export const LIQUID_TYPES = ["cash", "bank", "wallet"];

export function validMonth(month) {
  return /^(?:\d{4})-(?:0[1-9]|1[0-2])$/.test(String(month || ""));
}

export function nextMonth(month) {
  if (!validMonth(month)) throw new Error("Invalid month");
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function emptyFlow() { return { inflow: 0, outflow: 0 }; }

/**
 * @param {Array} accounts - full list of family account records, active and inactive
 * @param {Array} openingRows - optional preceding reconciled snapshot rows
 * @param {Array} transactions - actual transactions within [start, end]
 */
export function calculateAccountPeriod(accounts, openingRows, transactions) {
  const byId = new Map();
  const issues = [];
  const saved = new Map((openingRows || []).map((r) => [accountIdOf(r.accountId), r]));

  for (const account of accounts || []) {
    const id = accountIdOf(account._id || account.accountId);
    if (!id) continue;
    if (byId.has(id)) {
      issues.push({ code: "DUPLICATE_ACCOUNT", accountId: id });
      continue;
    }
    const snapshot = saved.get(id);
    byId.set(id, {
      accountId: account._id || account.accountId,
      name: account.name,
      owner: account.owner,
      type: account.type,
      isActive: account.isActive !== false,
      opening: toCents(snapshot ? snapshot.balance : account.openingBalance),
      ...emptyFlow(),
    });
  }

  const flow = (accountId, amount, direction, txId) => {
    const key = accountIdOf(accountId);
    if (!byId.has(key)) {
      issues.push({ code: "UNKNOWN_ACCOUNT", transactionId: txId, accountId: key });
      return;
    }
    byId.get(key)[direction] += amount;
  };

  for (const tx of transactions || []) {
    const txId = accountIdOf(tx._id) || "unknown";
    const amount = toCents(tx.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      issues.push({ code: "INVALID_TRANSACTION_AMOUNT", transactionId: txId });
      continue;
    }

    if (tx.txType === "income") {
      flow(tx.toAccountId, amount, "inflow", txId);
    } else if (tx.txType === "transfer") {
      flow(tx.fromAccountId, amount, "outflow", txId);
      flow(tx.toAccountId, amount, "inflow", txId);
    } else if (tx.txType === "expense" && tx.paymentMode === "split") {
      const parts = tx.paymentParts || [];
      const total = parts.reduce((s, part) => s + toCents(part.amount), 0);
      if (!parts.length || total !== amount || parts.some((p) => toCents(p.amount) <= 0)) {
        issues.push({ code: "INVALID_SPLIT_FUNDING", transactionId: txId, mismatch: fromCents(amount - total) });
        // Do not silently fabricate a payer: only valid source-linked funds are posted.
        continue;
      }
      parts.forEach((part) => flow(part.accountId, toCents(part.amount), "outflow", txId));
    } else if (tx.txType === "expense") {
      flow(tx.fromAccountId, amount, "outflow", txId);
    } else {
      issues.push({ code: "UNKNOWN_TRANSACTION_TYPE", transactionId: txId });
    }
  }

  const rows = Array.from(byId.values()).map((item) => ({
    accountId: item.accountId,
    name: item.name,
    owner: item.owner,
    type: item.type,
    isActive: item.isActive,
    opening: fromCents(item.opening),
    inflow: fromCents(item.inflow),
    outflow: fromCents(item.outflow),
    balance: fromCents(item.opening + item.inflow - item.outflow),
  }));
  const sum = (predicate, field) => fromCents(rows.filter(predicate).reduce((s, r) => s + toCents(r[field]), 0));
  const all = () => true;
  const liquid = (r) => LIQUID_TYPES.includes(r.type);
  return {
    accounts: rows,
    issues,
    openingTotal: sum(all, "opening"),
    closingTotal: sum(all, "balance"),
    liquidOpening: sum(liquid, "opening"),
    liquidClosing: sum(liquid, "balance"),
    liquidMovement: fromCents(toCents(sum(liquid, "balance")) - toCents(sum(liquid, "opening"))),
  };
}

export function summarizeLiquidBalances(rows = []) {
  const out = { total: 0, joint: 0, owners: {}, accounts: [] };
  let total = 0;
  let joint = 0;
  const owners = {};
  for (const row of rows) {
    if (!LIQUID_TYPES.includes(row.type)) continue;
    const value = toCents(row.balance);
    total += value;
    if (row.owner === "Joint") joint += value;
    else owners[row.owner || "Unassigned"] = (owners[row.owner || "Unassigned"] || 0) + value;
    out.accounts.push(row);
  }
  out.total = fromCents(total);
  out.joint = fromCents(joint);
  out.owners = Object.fromEntries(Object.entries(owners).map(([owner, cents]) => [owner, fromCents(cents)]));
  return out;
}
