import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import MonthlyBalance from "../models/MonthlyBalance.js";
import { calculateAccountPeriod, accountIdOf, nextMonth, validMonth, toCents } from "./reconciledAccountMath.js";

const FIELDS = "_id txType month amount fromAccountId toAccountId paymentMode paymentParts";

async function loadTransactions(familyId, minMonth, maxMonth) {
  const month = { $lte: maxMonth };
  if (minMonth) month.$gte = minMonth;
  return Transaction.find({ familyId, month }).select(FIELDS).lean();
}

function snapshotRows(rows = []) {
  return rows.map((row) => ({
    accountId: row.accountId,
    name: row.name,
    type: row.type,
    owner: row.owner,
    balance: Number(row.balance || 0),
    systemBalance: row.systemBalance == null ? null : Number(row.systemBalance),
    manualEdited: !!row.manualEdited,
  }));
}

/**
 * Read-only reconciled month statement. A prior month-end close is the anchor.
 * All subsequent months (including skipped months) are rolled forward using
 * real transactions, never estimated expense budgets or payment obligations.
 *
 * Closed current month is returned as its saved authoritative snapshot; any
 * newly changed transactions in that month produce a stale-close warning.
 */
export async function loadReconciledMonth(familyId, month) {
  if (!validMonth(month)) throw new Error("Valid month (YYYY-MM) required");
  const [accounts, previousClose, currentClose] = await Promise.all([
    Account.find({ familyId }).select("_id name owner type openingBalance isActive").sort({ owner: 1, name: 1 }).lean(),
    MonthlyBalance.findOne({ familyId, month: { $lt: month }, closingBalance: { $ne: null }, "accountsClosing.0": { $exists: true } }).sort({ month: -1 }).lean(),
    MonthlyBalance.findOne({ familyId, month, closingBalance: { $ne: null } }).lean(),
  ]);

  const anchorMonth = previousClose?.month || null;
  const anchorAccounts = previousClose ? snapshotRows(previousClose.accountsClosing) : [];
  const minMonth = anchorMonth ? nextMonth(anchorMonth) : null;
  const periodTransactions = await loadTransactions(familyId, minMonth, month);

  const missing = accounts.filter((a) => !anchorAccounts.some((r) => accountIdOf(r.accountId) === accountIdOf(a._id)));
  const issues = [];
  const currentAccountIds = new Set(accounts.map((a) => accountIdOf(a._id)));
  for (const saved of anchorAccounts) {
    if (!currentAccountIds.has(accountIdOf(saved.accountId))) {
      issues.push({ code: "SNAPSHOT_ACCOUNT_MISSING", accountId: accountIdOf(saved.accountId) });
    }
  }
  if (anchorMonth && missing.length) {
    // A newly introduced account is initialized with its raw historic balance
    // through the anchor date, not zero. This handles account records created
    // after the last close without dropping older transactions.
    const olderTx = await loadTransactions(familyId, null, anchorMonth);
    const older = calculateAccountPeriod(accounts, null, olderTx);
    const missingIds = new Set(missing.map((a) => accountIdOf(a._id)));
    for (const row of older.accounts) {
      if (missingIds.has(accountIdOf(row.accountId))) anchorAccounts.push({ accountId: row.accountId, balance: row.balance });
    }
    issues.push(...older.issues);
  }

  const allBeforeCurrent = periodTransactions.filter((t) => t.month < month);
  const currentMonthTx = periodTransactions.filter((t) => t.month === month);
  const initial = calculateAccountPeriod(accounts, anchorAccounts, allBeforeCurrent);
  const monthly = calculateAccountPeriod(accounts,
    initial.accounts.map((r) => ({ accountId: r.accountId, balance: r.balance })),
    currentMonthTx);
  issues.push(...initial.issues, ...monthly.issues);

  const closed = currentClose && Array.isArray(currentClose.accountsClosing) && currentClose.accountsClosing.length > 0;
  const savedByAccount = new Map((closed ? snapshotRows(currentClose.accountsClosing) : []).map((r) => [accountIdOf(r.accountId), r]));
  for (const id of savedByAccount.keys()) {
    if (!currentAccountIds.has(id)) issues.push({ code: "CLOSED_SNAPSHOT_ACCOUNT_MISSING", accountId: id });
  }
  let staleClosedCount = 0;
  const officialClosing = monthly.accounts.map((row) => {
    const saved = savedByAccount.get(accountIdOf(row.accountId));
    if (closed && !saved) {
      issues.push({ code: "CLOSED_ACCOUNT_MISSING", accountId: accountIdOf(row.accountId) });
      return row;
    }
    if (saved?.systemBalance != null && Math.abs(toCents(saved.systemBalance) - toCents(row.balance)) > 1) {
      staleClosedCount += 1;
    }
    return { ...row, balance: saved ? saved.balance : row.balance, manualEdited: !!saved?.manualEdited };
  });

  // A manual closing adjustment is allowed, but it must remain visible.
  const openingRows = initial.accounts.map((r) => ({ accountId: r.accountId, name: r.name, owner: r.owner, type: r.type, isActive: r.isActive, balance: r.balance }));
  const systemClosingRows = monthly.accounts.map((r) => ({ accountId: r.accountId, name: r.name, owner: r.owner, type: r.type, isActive: r.isActive, balance: r.balance, systemBalance: r.balance, manualEdited: false }));
  const closingRows = officialClosing.map((r) => ({ accountId: r.accountId, name: r.name, owner: r.owner, type: r.type, isActive: r.isActive, balance: r.balance, systemBalance: monthly.accounts.find((sys) => accountIdOf(sys.accountId) === accountIdOf(r.accountId))?.balance ?? r.balance, manualEdited: !!r.manualEdited }));
  const sum = (rows) => rows.reduce((s, r) => s + toCents(r.balance), 0) / 100;
  if (staleClosedCount) issues.push({ code: "STALE_CLOSED_MONTH", count: staleClosedCount });
  return {
    month,
    opening: { accounts: openingRows, total: sum(openingRows), source: anchorMonth ? "previous_closed_month" : "system_calculated" },
    closing: { accounts: closingRows, total: sum(closingRows) },
    systemClosing: { accounts: systemClosingRows, total: sum(systemClosingRows) },
    movements: monthly.accounts.map((r) => ({ accountId: r.accountId, inflow: r.inflow, outflow: r.outflow })),
    anchorMonth,
    closed: !!closed,
    staleClosedCount,
    issues,
  };
}
