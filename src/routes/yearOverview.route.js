import mongoose from 'mongoose';
import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { requireFamily } from '../middlewares/familyGuard.js';
import LedgerEntry from '../models/LedgerEntry.js';
import Transaction from '../models/Transaction.js';
import Account from '../models/Account.js';
import { loadSharedBudgetMonth } from '../utils/sharedBudgetReadModel.js';
import { calculateMonthlyLiquidFlow } from '../utils/monthlyLiquidFlow.js';
import { loadReconciledMonth } from '../utils/reconciledAccounts.js';
import { summarizeLiquidBalances } from '../utils/reconciledAccountMath.js';
import { makeMonthlyReport, sumYearReport } from '../utils/reportingMath.js';

const router = Router();

function validYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
}
function key(year, month) { return `${year}-${String(month).padStart(2, '0')}`; }

/** Read only: loading reports must never create/delete financial records. */
router.get('/', requireAuth, requireFamily, async (req, res) => {
  try {
    const year = req.query.year == null ? new Date().getFullYear() : validYear(req.query.year);
    if (!year) return res.status(400).json({ ok: false, message: 'Valid year (2000–2100) required' });
    const familyId = new mongoose.Types.ObjectId(req.familyId);
    const minMonth = key(year, 1), maxMonth = key(year, 12);
    const [accounts, allTransactions, allLedgerEntries] = await Promise.all([
      Account.find({ familyId }).select('_id type name owner isActive').lean(),
      Transaction.find({ familyId, month: { $gte: minMonth, $lte: maxMonth } })
        .select('_id month txType amount sourceType paymentMode paymentParts fromAccountId toAccountId').lean(),
      LedgerEntry.find({ familyId, month: { $gte: minMonth, $lte: maxMonth } }).lean(),
    ]);
    const txByMonth = new Map(), entriesByMonth = new Map();
    for (const tx of allTransactions) {
      if (!txByMonth.has(tx.month)) txByMonth.set(tx.month, []);
      txByMonth.get(tx.month).push(tx);
    }
    for (const entry of allLedgerEntries) {
      if (!entriesByMonth.has(entry.month)) entriesByMonth.set(entry.month, []);
      entriesByMonth.get(entry.month).push(entry);
    }
    // The household closes months on Bangladesh local dates, not server UTC.
    const dhakaParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit',
    }).formatToParts(new Date());
    const datePart = (type) => dhakaParts.find((part) => part.type === type)?.value;
    const currentMonth = `${datePart('year')}-${datePart('month')}`;
    const months = [];
    const reconciliation = [];
    for (let i = 1; i <= 12; i++) {
      const month = key(year, i);
      const [budgetView, snapshot] = await Promise.all([
        loadSharedBudgetMonth(req.familyId, month, entriesByMonth.get(month) || []),
        month <= currentMonth ? loadReconciledMonth(req.familyId, month) : Promise.resolve(null),
      ]);
      const monthTransactions = txByMonth.get(month) || [];
      const cashFlow = calculateMonthlyLiquidFlow(accounts, monthTransactions);
      const row = makeMonthlyReport({
        month, accounts, transactions: monthTransactions,
        budgetEntries: budgetView.entries, cashFlow,
        openingBalance: snapshot ? summarizeLiquidBalances(snapshot.opening.accounts).total : null,
        closingBalance: snapshot ? summarizeLiquidBalances(snapshot.closing.accounts).total : null,
        budgetIssues: budgetView.summary.issues,
      });
      row.warningCount += snapshot?.issues?.length || 0;
      row.closed = !!snapshot?.closed;
      row.isFuture = month > currentMonth;
      if (row.warningCount) reconciliation.push({ month, warningCount: row.warningCount });
      months.push(row);
    }
    res.json({ ok: true, year, months, totals: sumYearReport(months), reconciliation,
      reportingBasis: { budget: 'posted_regular_ledger_plus_scheduled_large_purchases',
        cash: 'posted_liquid_account_transactions',
        openingClosing: 'reconciled_month_end_account_balances',
        note: 'Budget obligations are not cash outflows until paid. Transfers between liquid accounts are not income.' } });
  } catch (err) {
    console.error('YearOverview Error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load annual report' });
  }
});
export default router;
