import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middlewares/auth.js';
import { requireFamily } from '../middlewares/familyGuard.js';
import XLSX from 'xlsx';
import LedgerEntry from '../models/LedgerEntry.js';
import Split from '../models/Split.js';
import FamilyMember from '../models/FamilyMember.js';
import Transaction from '../models/Transaction.js';
import Account from '../models/Account.js';
import { loadSharedBudgetMonth } from '../utils/sharedBudgetReadModel.js';
import { summarizeDashboardBudget } from '../utils/dashboardBudgetMath.js';
import { reportSavingsFlow, reportMoney } from '../utils/reportingMath.js';
import { calculateMonthlyLiquidFlow } from '../utils/monthlyLiquidFlow.js';
import { loadReconciledMonth } from '../utils/reconciledAccounts.js';
import { summarizeLiquidBalances } from '../utils/reconciledAccountMath.js';
import { calculateOrdinaryExpenseShares } from '../utils/expenseFunding.js';

const router = Router();
const id = (v) => String(v?._id ?? v ?? '');
const sheet = (workbook, name, rows) => XLSX.utils.book_append_sheet(workbook,
  XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No records' }]), name);

/** Excel uses the same read-only reporting rules as Dashboard, Year Overview and Wallet. */
router.get('/monthly-summary', requireAuth, requireFamily, async (req, res) => {
  try {
    const month = String(req.query.month || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      return res.status(400).json({ ok: false, message: 'Valid month (YYYY-MM) required' });
    const familyId = new mongoose.Types.ObjectId(req.familyId);
    const [members, accounts, ledger, transactions] = await Promise.all([
      FamilyMember.find({ familyId }).populate('userId', 'name').lean(),
      Account.find({ familyId }).select('_id name owner type').lean(),
      LedgerEntry.find({ familyId, month }).populate('categoryId', 'name')
        .sort({ date: 1 }).lean(),
      Transaction.find({ familyId, month })
        .select('_id txType amount sourceType fromAccountId toAccountId paymentMode paymentParts paidByUserId settlementImpact').lean(),
    ]);
    const [view, reconciled] = await Promise.all([
      loadSharedBudgetMonth(req.familyId, month, ledger),
      loadReconciledMonth(req.familyId, month),
    ]);
    const regularEntries = view.regularEntries;
    const entryIds = regularEntries.map((e) => e._id);
    const splits = entryIds.length ? await Split.find({ familyId, ledgerEntryId: { $in: entryIds } }).lean() : [];
    const splitsByEntry = new Map();
    for (const s of splits) {
      const key = id(s.ledgerEntryId);
      if (!splitsByEntry.has(key)) splitsByEntry.set(key, []);
      splitsByEntry.get(key).push({ userId: id(s.userId), shareAmount: reportMoney(s.shareAmount) });
    }
    for (const row of view.virtualRows) splitsByEntry.set(id(row._id), row.splits || []);
    const users = members.map((m) => m.userId).filter(Boolean);
    const names = new Map(users.map((u) => [id(u._id), u.name]));
    const linkedIds = regularEntries.filter((e) => e.entryType === 'expense' && e.sourceType === 'transaction' && e.sourceId).map((e) => e.sourceId);
    const linkedTx = transactions.filter((t) => linkedIds.some((linked) => id(linked) === id(t._id)));
    const ordinary = calculateOrdinaryExpenseShares({ entries: regularEntries, splits, transactions: linkedTx,
      userIds: users.map((u) => u._id) });
    const savings = reportSavingsFlow(accounts, transactions);
    const budget = summarizeDashboardBudget({ entries: view.entries, savingsContribution: savings.net });
    const cash = calculateMonthlyLiquidFlow(accounts, transactions);
    const liquid = summarizeLiquidBalances(reconciled.closing.accounts);

    const summaryRows = [
      { Metric: 'Budget income', Amount: budget.income },
      { Metric: 'Ordinary living expense allocation', Amount: budget.living },
      { Metric: 'Regular debt allocation', Amount: budget.components.regularDebt },
      { Metric: 'Scheduled shared/large-purchase allocation', Amount: budget.components.scheduledLargePurchaseAllocation },
      { Metric: 'Budget remaining after savings/investment', Amount: budget.finalBalance },
      { Metric: 'Actual cash income received', Amount: cash.household.income },
      { Metric: 'Actual cash expenses paid (includes EMI/card repayment)', Amount: cash.household.expenses },
      { Metric: 'Saved or invested from cash', Amount: cash.household.savedOrInvested },
      { Metric: 'Withdrawn from savings into cash', Amount: cash.household.savingsWithdrawn },
      { Metric: 'This month actual cash remaining', Amount: cash.household.remainingFromMonth },
      { Metric: 'Month-end recorded liquid cash (includes prior months)', Amount: liquid.total },
      { Metric: 'Ordinary expense settlement discrepancy', Amount: ordinary.settlementDiscrepancy },
      { Metric: 'Read model warning count', Amount: cash.issues.length + view.summary.issues.length + reconciled.issues.length },
    ];
    const memberRows = users.map((u) => {
      const userId = id(u._id);
      return {
        Member: u.name,
        OrdinaryPaid: ordinary.paidMap[userId] || 0,
        OrdinaryShare: ordinary.shareMap[userId] || 0,
        OrdinarySettlementPosition: reportMoney((ordinary.paidMap[userId] || 0) - (ordinary.shareMap[userId] || 0)),
        ScheduledLargePurchaseShare: view.summary.byMember[userId] || 0,
        Note: 'Full settlement (including unpaid Shared Purchases) is in Wallet',
      };
    });
    const detailRows = view.entries.map((e) => ({
      Date: e.date ? new Date(e.date).toISOString().slice(0, 10) : month,
      Type: e.entryType,
      BudgetKind: e.isBudgetAllocation ? 'SCHEDULED - NOT PAID CASH' : 'POSTED LEDGER',
      Module: e.module || 'manual',
      Category: e.categoryId?.name || '-',
      Amount: reportMoney(e.amountTotal),
      ResponsibilitySplit: (splitsByEntry.get(id(e._id)) || []).map((s) => `${names.get(id(s.userId)) || id(s.userId)}: ${reportMoney(s.shareAmount)}`).join(' | '),
      Note: e.note || '',
    }));
    const accountRows = reconciled.closing.accounts.map((a) => ({
      Account: a.name, Owner: a.owner, Type: a.type, ClosingBalance: reportMoney(a.balance),
      Warning: Number(a.balance) < 0 ? 'Negative account balance - verify' : '',
    }));
    const wb = XLSX.utils.book_new();
    sheet(wb, 'Monthly_Summary', summaryRows);
    sheet(wb, 'Member_Responsibilities', memberRows);
    sheet(wb, 'Budget_Entries', detailRows);
    sheet(wb, 'Account_Balances', accountRows);
    sheet(wb, 'Methodology', [
      { Topic: 'Budget', Explanation: 'Regular posted Ledger responsibilities plus scheduled Shared Purchase allocations; not necessarily cash paid.' },
      { Topic: 'Actual cash', Explanation: 'Only posted transactions from liquid accounts; transfers between liquid accounts cancel for the household.' },
      { Topic: 'Savings', Explanation: 'Savings/investment deposits move assets and are not household spending.' },
      { Topic: 'Settlement', Explanation: 'Ordinary settlement excludes managed Shared Purchase reimbursements. Consult Wallet for total outstanding.' },
    ]);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Monthly_Financial_Report_${month}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Monthly export error:', error);
    res.status(500).json({ ok: false, message: 'Failed to export report' });
  }
});
export default router;
