import mongoose from 'mongoose';
import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { requireFamily } from '../middlewares/familyGuard.js';
import MonthlyBalance from '../models/MonthlyBalance.js';
import Transaction from '../models/Transaction.js';
import LedgerEntry from '../models/LedgerEntry.js';
import { loadReconciledMonth } from '../utils/reconciledAccounts.js';
import { summarizeLiquidBalances, validMonth } from '../utils/reconciledAccountMath.js';
import {
  getDhakaCurrentMonth, mayCloseMonth, writableMonth,
  snapshotTotal, manualClosingOverrides, fingerprintReconciliation,
  blockersFromIssues, snapshotConflict,
} from '../utils/carryForwardRules.js';

const router = Router();
const cents = (n) => Math.round(Number(n || 0) * 100);
const money = (n) => cents(n) / 100;
const isClosedDoc = (doc) => doc?.closingBalance !== null && doc?.closingBalance !== undefined;
const FAMILY_MONTH_ID = (familyId, month) => ({ familyId, month });

function snapshotRows(rows = []) {
  return rows.map((row) => ({
    accountId: row.accountId, name: row.name || '', type: row.type || '', owner: row.owner || '',
    balance: money(row.balance), systemBalance: row.systemBalance == null ? null : money(row.systemBalance),
    manualEdited: !!row.manualEdited,
  }));
}
async function financialSummary(familyId, month, reconciled) {
  const familyObjectId = new mongoose.Types.ObjectId(familyId);
  const [ledgers, transfers] = await Promise.all([
    LedgerEntry.aggregate([
      { $match: { familyId: familyObjectId, month } },
      { $group: { _id: '$entryType', total: { $sum: '$amountTotal' } } },
    ]),
    Transaction.aggregate([
      { $match: { familyId: familyObjectId, month, txType: 'transfer' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  const income = money(ledgers.find((r) => r._id === 'income')?.total);
  const expense = money(ledgers.find((r) => r._id === 'expense')?.total);
  const liquidOpening = summarizeLiquidBalances(reconciled.opening.accounts).total;
  const liquidSystemClosing = summarizeLiquidBalances(reconciled.systemClosing.accounts).total;
  return {
    income, expense, transfer: money(transfers[0]?.total), netCashflow: money(income - expense),
    liquidOpening, liquidSystemClosing, liquidMovement: money(liquidSystemClosing - liquidOpening),
  };
}
function defaultItem(familyId, month, reconciled) {
  return {
    familyId, month, closingBalance: null, openingBalance: reconciled.opening.total,
    accountsOpening: reconciled.opening.accounts, accountsClosing: [],
    draftSavedAt: null, updatedAt: null,
  };
}
function requestedVersionMatches(doc, expectedVersion) {
  return !snapshotConflict(doc, expectedVersion);
}
function payloadBalanceRows(body) {
  if (!Array.isArray(body?.accountBalances)) throw new Error('accountBalances must be an array.');
  return body.accountBalances;
}
function writeChecks(month, body, reconciled, doc, { requireCompleted = false } = {}) {
  if (!writableMonth(month)) return { status: 403, message: 'Historical months before October 2026 are protected from Phase 6 changes.' };
  if (requireCompleted && !mayCloseMonth(month)) return { status: 409, message: `You can only close a completed month. Current Dhaka month: ${getDhakaCurrentMonth()}.` };
  if (!body?.expectedFingerprint || body.expectedFingerprint !== fingerprintReconciliation(reconciled)) {
    return { status: 409, message: 'Account movements have changed since you opened this month. Refresh to reconcile before saving.' };
  }
  if (!requestedVersionMatches(doc, body.expectedVersion)) {
    return { status: 409, message: 'The saved month was updated in another window. Refresh before continuing.' };
  }
  if (requireCompleted) {
    if (!reconciled.systemClosing.accounts?.length) return { status: 409, message: 'Cannot close a month without registered financial accounts.' };
    const blockers = blockersFromIssues(reconciled.issues);
    if (blockers.length) return { status: 409, message: 'Cannot close while account funding errors remain. Review reconciliation warnings.', issues: blockers };
  }
  return null;
}
function conflict(res, details) { return res.status(details.status).json({ ok: false, ...details }); }
async function snapshotData(familyId, month) {
  const [reconciled, doc] = await Promise.all([
    loadReconciledMonth(familyId, month), MonthlyBalance.findOne(FAMILY_MONTH_ID(familyId, month)),
  ]);
  return { reconciled, doc };
}
function buildComputed(month, reconciled, doc, summary) {
  const closed = isClosedDoc(doc);
  const opening = closed && doc.accountsOpening?.length ? snapshotRows(doc.accountsOpening) : reconciled.opening.accounts;
  const existingDraftOverrides = !closed ? (doc?.accountsClosing || [])
    .filter((row) => row.manualEdited).map((row) => ({ accountId: row.accountId, balance: row.balance })) : [];
  const proposed = closed
    ? snapshotRows(doc.accountsClosing || [])
    : manualClosingOverrides(reconciled.systemClosing.accounts, existingDraftOverrides).accounts;
  return {
    month, openingSource: reconciled.opening.source, anchorMonth: reconciled.anchorMonth,
    reconciliationIssues: reconciled.issues, staleClosedCount: reconciled.staleClosedCount,
    openingTotal: snapshotTotal(opening),
    closingTotal: closed ? money(doc.closingBalance) : snapshotTotal(proposed),
    systemClosingTotal: reconciled.systemClosing.total,
    accountsOpening: opening,
    accountsClosing: proposed,
    systemAccountsClosing: reconciled.systemClosing.accounts,
    summary, fingerprint: fingerprintReconciliation(reconciled),
    snapshotVersion: doc?.updatedAt?.toISOString?.() || '',
    canClose: !closed && mayCloseMonth(month) && writableMonth(month) && !blockersFromIssues(reconciled.issues).length,
    canRevise: closed && writableMonth(month),
    protectedHistorical: !writableMonth(month),
    pendingMonth: !mayCloseMonth(month),
    isClosed: closed,
    revisions: doc?.closingRevisions?.length || 0,
  };
}
function successPayload(doc, reconciled, summary, accounts) {
  const computed = buildComputed(reconciled.month, reconciled, doc, summary);
  return { ok: true, item: doc, computed, calc: {
    ...summary, openingTotal: reconciled.opening.total, closingTotal: snapshotTotal(accounts),
    systemClosingTotal: reconciled.systemClosing.total, manualAdjusted: accounts.some((r) => r.manualEdited),
  }, accounts: { opening: reconciled.opening.accounts, closing: accounts, systemClosing: reconciled.systemClosing.accounts } };
}
function mongoError(res, error, fallback) {
  if (error.code === 11000) return res.status(409).json({ ok: false, message: 'Another request saved this month first. Refresh and try again.' });
  if (/^accountBalances|^Unknown|^Duplicate|^Each manually|^Account balance/.test(error.message || '')) return res.status(400).json({ ok: false, message: error.message });
  return res.status(500).json({ ok: false, message: fallback });
}

// GET: strictly read-only. Merely viewing a month never creates or updates a snapshot.
router.get('/', requireAuth, requireFamily, async (req, res) => {
  const month = String(req.query.month || '').trim();
  if (!validMonth(month)) return conflict(res, { status: 400, message: 'Valid month (YYYY-MM) required.' });
  try {
    const { reconciled, doc } = await snapshotData(req.familyId, month);
    const summary = await financialSummary(req.familyId, month, reconciled);
    return res.json({ ok: true, item: doc || defaultItem(req.familyId, month, reconciled), computed: buildComputed(month, reconciled, doc, summary) });
  } catch (err) { return mongoError(res, err, 'Failed to load carry forward data.'); }
});

async function writeSnapshot(req, res, action) {
  const month = String(req.body?.month || '').trim();
  if (!validMonth(month)) return conflict(res, { status: 400, message: 'Valid month (YYYY-MM) required.' });
  try {
    const { reconciled, doc } = await snapshotData(req.familyId, month);
    const closed = isClosedDoc(doc);
    if (action !== 'revise' && closed) return conflict(res, { status: 409, message: 'This month is already closed. To change it, use the explicit Revise Closing workflow.' });
    if (action === 'revise' && !closed) return conflict(res, { status: 409, message: 'Month is not closed yet.' });
    if (action === 'revise') {
      if (req.body?.confirmation !== `REVISE ${month}` || String(req.body?.reason || '').trim().length < 12) {
        return conflict(res, { status: 400, message: `To revise an existing close, enter a reason (12+ characters) and confirm REVISE ${month}.` });
      }
    }
    // Closing OR revising an earlier month after a later month is closed could
    // invalidate that later month's opening snapshot without any visible update.
    if (action !== 'save') {
      const laterClose = await MonthlyBalance.exists({ familyId: req.familyId, month: { $gt: month }, closingBalance: { $ne: null } });
      if (laterClose) return conflict(res, { status: 409, message: 'A later month is already closed. Earlier month-end changes need a dedicated chronological reconciliation.' });
    }
    const checks = writeChecks(month, req.body, reconciled, doc, { requireCompleted: action !== 'save' });
    if (checks) return conflict(res, checks);
    const manual = manualClosingOverrides(reconciled.systemClosing.accounts, payloadBalanceRows(req.body));
    const opening = reconciled.opening.accounts.map((row) => ({
      accountId: row.accountId, name: row.name, type: row.type, owner: row.owner, balance: row.balance,
    }));
    const set = {
      openingBalance: reconciled.opening.total, accountsOpening: opening,
      closingBalance: action === 'save' ? null : manual.total,
      accountsClosing: manual.accounts, manualAdjusted: manual.manualAdjusted,
      draftSavedAt: action === 'save' ? new Date() : null,
      draftSavedByUserId: action === 'save' ? req.user.userId : null,
      closedAt: action === 'save' ? null : new Date(),
      closedByUserId: action === 'save' ? null : req.user.userId,
    };
    if (action === 'revise') {
      // Use the saved opening snapshot to preserve its historical baseline.
      set.openingBalance = doc.openingBalance;
      set.accountsOpening = doc.accountsOpening;
    }
    const filter = { familyId: req.familyId, month };
    if (doc) filter.updatedAt = doc.updatedAt;
    else filter._id = { $exists: false };
    if (action !== 'revise') filter.closingBalance = null;
    else filter.closingBalance = { $ne: null };
    const update = { $set: set };
    if (action === 'revise') update.$push = { closingRevisions: {
      at: new Date(), byUserId: req.user.userId,
      reason: String(req.body.reason).trim(),
      previousClosingBalance: doc.closingBalance,
      previousAccountsClosing: snapshotRows(doc.accountsClosing || []),
    } };
    let saved;
    if (!doc) {
      saved = await MonthlyBalance.create({ familyId: req.familyId, month, ...set });
    } else {
      saved = await MonthlyBalance.findOneAndUpdate(filter, update, { new: true, runValidators: true });
      if (!saved) return conflict(res, { status: 409, message: 'Month changed during this request. Refresh and retry.' });
    }
    const summary = await financialSummary(req.familyId, month, reconciled);
    return res.json(successPayload(saved, reconciled, summary, manual.accounts));
  } catch (err) { return mongoError(res, err, `Failed to ${action} month.`); }
}
router.post('/save', requireAuth, requireFamily, (req, res) => writeSnapshot(req, res, 'save'));
router.post('/close', requireAuth, requireFamily, (req, res) => writeSnapshot(req, res, 'close'));
router.post('/revise', requireAuth, requireFamily, (req, res) => writeSnapshot(req, res, 'revise'));
export default router;
