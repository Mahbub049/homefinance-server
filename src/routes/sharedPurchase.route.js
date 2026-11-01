import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import SharedPurchase from "../models/SharedPurchase.js";
import SharedPurchaseInstallment from "../models/SharedPurchaseInstallment.js";
import MonthlyBalance from "../models/MonthlyBalance.js";
import FamilyMember from "../models/FamilyMember.js";
import Account from "../models/Account.js";
import Category from "../models/Category.js";
import Transaction from "../models/Transaction.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import { requireOpenMonth } from "../utils/postingPreflight.js";
import { positiveMoney } from "../utils/postingRules.js";
import { createIdempotentFinancialPosting } from "../utils/idempotentFinancialPosting.js";
import { runAtomicPosting, atomicPostingError } from "../utils/financialPostingTransaction.js";
import { validReimbursement } from "../utils/sharedPurchaseSchedule.js";
import {
  ensureEditablePurchaseMonth, requireLiquidPurchaseAccount,
  requirePendingInstallmentForPayment, requireSafePlanRemoval,
  requireLinkedDocument, purchaseWriteError,
} from "../utils/sharedPurchaseSafety.js";
import { summarizePurchaseInstallments } from "../utils/sharedPurchaseSchedule.js";
import { summarizeAllocationProgress } from "../utils/purchaseAllocationProgress.js";
import {cents, splitCents, futureRemainder, canReviseFuture} from "../utils/sharedPurchaseRevisionRules.js";

const router = Router();

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function monthKey(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));
}

function addMonths(yyyyMm, add) {
  const [year, month] = yyyyMm.split("-").map(Number);
  const d = new Date(year, month - 1 + add, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function requireOpenPurchaseMonths(familyId, months) {
  const unique = [...new Set(months.map((month) => ensureEditablePurchaseMonth(month)))];
  const closed = await MonthlyBalance.findOne({
    familyId, month: { $in: unique },
    $or: [{ closedAt: { $ne: null } }, { closingBalance: { $ne: null } }],
  }).select('month').lean();
  if (closed) throw purchaseWriteError(`Month ${closed.month} is already closed. No purchase records were changed.`, 409);
}

function dueDateForMonth(yyyyMm, preferredDay) {
  const [year, month] = yyyyMm.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const day = Math.min(Math.max(1, Number(preferredDay || 1)), lastDay);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function amountsByMonth(total, months) {
  const regular = round2(Number(total || 0) / Number(months || 1));
  const rows = [];
  let used = 0;

  for (let index = 0; index < months; index += 1) {
    const amount =
      index === months - 1 ? round2(Number(total || 0) - used) : regular;
    rows.push(amount);
    used = round2(used + amount);
  }

  return rows;
}

async function resolveCategory(familyId, requestedCategoryId) {
  if (requestedCategoryId && mongoose.isValidObjectId(requestedCategoryId)) {
    const selected = await Category.findOne({
      _id: requestedCategoryId,
      familyId,
      kind: "expense",
      isActive: { $ne: false },
    });
    if (selected) return selected;
  }

  let category = await Category.findOne({
    familyId,
    kind: "expense",
    name: { $regex: /^\s*large purchases?\s*$/i },
  });

  if (!category) {
    try {
      category = await Category.create({
        familyId,
        kind: "expense",
        financialType: "debt",
        name: "Large Purchase",
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      category = await Category.findOne({
        familyId,
        kind: "expense",
        name: { $regex: /^\s*large purchases?\s*$/i },
      });
    }
  }

  return category;
}

async function validateMemberIds(familyId, ids) {
  const members = await FamilyMember.find({ familyId }).select("userId").lean();
  const allowed = new Set(members.map((member) => String(member.userId)));
  return ids.every((id) => allowed.has(String(id)));
}

async function memberNameMap(familyId, userIds = []) {
  const ids = [...new Set((userIds || []).map((id) => String(id || "")).filter(Boolean))];
  if (!ids.length) return new Map();

  const members = await FamilyMember.find({
    familyId,
    userId: { $in: ids },
  })
    .populate("userId", "name")
    .lean();

  return new Map(
    members.map((member) => [
      String(member.userId?._id || member.userId || ""),
      String(member.userId?.name || ""),
    ])
  );
}

function accountOwnerMatchesMember(account, memberUserId, namesByUserId) {
  const owner = String(account?.owner || "").trim().toLowerCase();
  if (!owner || ["joint", "shared", "family"].includes(owner)) return true;

  const memberName = String(namesByUserId.get(String(memberUserId)) || "")
    .trim()
    .toLowerCase();
  if (!memberName) return false;

  const memberParts = memberName.split(/\s+/).filter(Boolean);
  return (
    memberName.includes(owner) ||
    owner.includes(memberName) ||
    memberParts.some((part) => owner.includes(part) || part.includes(owner))
  );
}

async function refreshPurchaseStatus(purchaseId, familyId) {
  const [paymentCount, pending] = await Promise.all([
    SharedPurchaseInstallment.countDocuments({
      familyId,
      purchaseId,
      paymentRequired: true,
    }),
    SharedPurchaseInstallment.countDocuments({
      familyId,
      purchaseId,
      paymentRequired: true,
      status: { $ne: "paid" },
    }),
  ]);

  const status = paymentCount > 0 && pending === 0 ? "completed" : "active";
  await SharedPurchase.updateOne({ _id: purchaseId, familyId }, { $set: { status } });
  return status;
}

function plainUserId(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || value.id || "");
  return String(value);
}

async function upsertSharedInstallmentLedger({
  familyId,
  purchase,
  installment,
  categoryId,
  date,
  createdByUserId,
  linkInstallment = true,
}) {
  const entryDate = new Date(date);
  const entryMonth = monthKey(entryDate);
  let entry = null;

  if (installment.ledgerEntryId) {
    entry = await LedgerEntry.findOne({
      _id: installment.ledgerEntryId,
      familyId,
    });
  }

  if (!entry) {
    entry = await LedgerEntry.findOne({
      familyId,
      sourceType: "shared_purchase_installment",
      sourceId: installment._id,
    });
  }

  const values = {
    entryType: "expense",
    financialType: "debt",
    module: "shared_purchase",
    date: entryDate,
    month: entryMonth,
    categoryId,
    amountTotal: Number(installment.amount || 0),
    affectsSettlement: false,
    paidByUserId: installment.userId,
    receivedByUserId: null,
    note: `${String(purchase.title || "Purchase").trim()} · monthly allocation`,
    sourceType: "shared_purchase_installment",
    sourceId: installment._id,
  };

  if (!entry) {
    entry = await LedgerEntry.create({
      familyId,
      ...values,
      createdByUserId,
    });
  } else {
    Object.assign(entry, values);
    await entry.save();
  }

  await Split.deleteMany({ familyId, ledgerEntryId: entry._id });
  await Split.create({
    familyId,
    ledgerEntryId: entry._id,
    userId: installment.userId,
    shareAmount: Number(installment.amount || 0),
  });

  if (linkInstallment) {
    installment.ledgerEntryId = entry._id;
    await installment.save();
  }
  return entry;
}

router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = validMonth(req.query.month) ? String(req.query.month) : monthKey(new Date());

    // Reading purchases MUST NOT clean up or modify old installments/Ledger rows.
    // Legacy inconsistencies are reported by the existing read-model flags.
    const plans = await SharedPurchase.find({ familyId: req.familyId })
      .sort({ createdAt: -1 })
      .populate("payerUserId", "name email")
      .populate("payerAccountId", "name owner type")
      .populate("categoryId", "name financialType")
      .populate("shares.userId", "name email")
      .lean();

    const planIds = plans.map((plan) => plan._id);
    const allInstallments = planIds.length
      ? await SharedPurchaseInstallment.find({
          familyId: req.familyId,
          purchaseId: { $in: planIds },
        })
          .populate("userId", "name email")
          .populate("fromAccountId", "name owner type")
          .populate("toAccountId", "name owner type")
          .sort({ month: 1, dueDate: 1 })
          .lean()
      : [];

    const installmentMap = new Map();
    for (const installment of allInstallments) {
      const key = String(installment.purchaseId);
      if (!installmentMap.has(key)) installmentMap.set(key, []);
      installmentMap.get(key).push(installment);
    }

    // Verify linked bank/account transfers before marking any installment paid
    // in the read model. A stale "paid" flag must not erase an obligation.
    const paymentTransactionIds = allInstallments
      .filter((row) => row.paymentRequired && row.paymentTransactionId)
      .map((row) => row.paymentTransactionId);
    const paymentTransactions = paymentTransactionIds.length
      ? await Transaction.find({
          familyId: req.familyId,
          _id: { $in: paymentTransactionIds },
          txType: "transfer",
          sourceType: "shared_purchase_reimbursement",
        }).select("_id txType sourceType sourceId amount paidByUserId receivedByUserId fromAccountId toAccountId").lean()
      : [];
    const paymentById = new Map(paymentTransactions.map((tx) => [String(tx._id), tx]));

    const totals = {
      totalReceivable: 0,
      totalOutstanding: 0,
      monthAllocation: 0,
      monthDue: 0,
      monthReceived: 0,
      monthScheduledReimbursement: 0,
      overdueBeforeMonth: 0,
      dueThroughMonth: 0,
      futureUnpaid: 0,
      invalidPaymentRecords: 0,
      pendingLedgerLinksToReview: 0,
    };
    const enrichedPlans = plans.map((plan) => {
      const rawRows = installmentMap.get(String(plan._id)) || [];
      const { summary: stats, installments } = summarizePurchaseInstallments(
        rawRows, month, plan, paymentById
      );
      totals.totalReceivable = round2(totals.totalReceivable + stats.receivableTotal);
      totals.totalOutstanding = round2(totals.totalOutstanding + stats.outstandingAllSchedule);
      totals.monthAllocation = round2(totals.monthAllocation + stats.scheduledAllocationThisMonth);
      totals.monthDue = round2(totals.monthDue + stats.dueThisMonth);
      totals.monthReceived = round2(totals.monthReceived + stats.receivedThisMonth);
      totals.monthScheduledReimbursement = round2(totals.monthScheduledReimbursement + stats.scheduledReimbursementThisMonth);
      totals.overdueBeforeMonth = round2(totals.overdueBeforeMonth + stats.overdueBeforeMonth);
      totals.dueThroughMonth = round2(totals.dueThroughMonth + stats.dueThroughMonth);
      totals.futureUnpaid = round2(totals.futureUnpaid + stats.futureUnpaid);
      totals.invalidPaymentRecords += stats.invalidPaymentRecords;
      // Report premature legacy ledger rows instead of deleting them on GET.
      const pendingLedgerLinks = rawRows.filter((row) =>
        row.paymentRequired && row.status !== 'paid' && row.ledgerEntryId
      ).length;
      totals.pendingLedgerLinksToReview += pendingLedgerLinks;

      // Read-only schedule progress; never treat allocations as repeated bank debits.
      const allocationHistory = summarizeAllocationProgress(rawRows, month);
      return {
        ...plan,
        allocationHistory,
        scheduleDueDay: new Date(rawRows.find(row=>row.month>=month && !row.paidAt)?.dueDate || plan.purchaseDate).getUTCDate(),
        // Keep the persisted plan status untouched; a legacy payment may need
        // reconciliation before "completed" is financially justified.
        stats: {
          ...stats,
          pendingLedgerLinksToReview: pendingLedgerLinks,
          paidAmount: stats.receivedLifetime,
          outstanding: stats.outstandingAllSchedule,
          // Plan-level "due to date" is separate from future repayments.
        },
        monthInstallments: installments.filter((row) => row.month === month),
        overdueInstallments: installments.filter((row) => row.month < month && row.unpaidAsOfMonth),
      };
    });

    const monthInstallments = enrichedPlans.flatMap((plan) => plan.monthInstallments);

    res.json({
      ok: true,
      month,
      plans: enrichedPlans,
      monthInstallments,
      summary: {
        ...totals,
        activePlans: enrichedPlans.filter((plan) => plan.status === "active").length,
      },
    });
  } catch (error) {
    console.error("Shared purchase list error:", error);
    res.status(500).json({ ok: false, message: error?.message || "Failed to load purchases" });
  }
});

router.post("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const result = await createIdempotentFinancialPosting(req, 'sharedPurchase.create', async () => {
      const {
        title, totalAmount, purchaseDate, categoryId, payerUserId, payerAccountId,
        purchaseType = 'shared', startMonth, months, shares, note,
      } = req.body || {};
      const total = positiveMoney(totalAmount, 'Purchase total');
      const duration = Number(months);
      const date = new Date(purchaseDate);
      if (!String(title || '').trim()) throw purchaseWriteError('Purchase title is required');
      if (!purchaseDate || Number.isNaN(date.getTime())) throw purchaseWriteError('Valid purchase date is required');
      if (!payerUserId || !payerAccountId) throw purchaseWriteError('Payer and payment account are required');
      ensureEditablePurchaseMonth(startMonth);
      const purchaseMonth = ensureEditablePurchaseMonth(monthKey(date));
      if (!Number.isInteger(duration) || duration < 1 || duration > 120) throw purchaseWriteError('Months must be between 1 and 120');
      if (!['personal', 'shared'].includes(purchaseType)) throw purchaseWriteError('Invalid purchase type');

      // The upfront debit and every scheduled allocation are saved together.
      await requireOpenPurchaseMonths(req.familyId, [
        purchaseMonth, ...Array.from({ length: duration }, (_, index) => addMonths(startMonth, index)),
      ]);
      const account = requireLiquidPurchaseAccount(await Account.findOne({
        _id: payerAccountId, familyId: req.familyId, isActive: { $ne: false },
      }));
      const normalizedShares = purchaseType === 'personal'
        ? [{ userId: String(payerUserId), shareAmount: total }]
        : Array.isArray(shares)
          ? shares.map((row) => ({
              userId: plainUserId(row?.userId),
              shareAmount: positiveMoney(row?.shareAmount, 'Member share'),
            }))
          : [];
      const userIds = normalizedShares.map((row) => String(row.userId));
      if (!normalizedShares.length || new Set(userIds).size !== userIds.length || userIds.some((id) => !id)) {
        throw purchaseWriteError('Each member must have exactly one positive share');
      }
      if (!userIds.includes(String(payerUserId))) throw purchaseWriteError('The payer must have a share');
      if (!(await validateMemberIds(req.familyId, userIds))) throw purchaseWriteError('Invalid family member in shares');
      if (purchaseType === 'shared' && userIds.length < 2) throw purchaseWriteError('Shared purchases require two members');
      const namesByUserId = await memberNameMap(req.familyId, [payerUserId]);
      if (!accountOwnerMatchesMember(account, payerUserId, namesByUserId)) {
        throw purchaseWriteError('The upfront account does not belong to the payer');
      }
      const sumCents = normalizedShares.reduce((sum, row) => sum + Math.round(row.shareAmount * 100), 0);
      if (sumCents !== Math.round(total * 100)) throw purchaseWriteError('Member shares must add up to the purchase total');
      const category = await resolveCategory(req.familyId, categoryId);
      if (!category) throw purchaseWriteError('Could not resolve expense category');

      const [purchase] = await SharedPurchase.create([{
        familyId: req.familyId, title: String(title).trim(), totalAmount: total,
        purchaseDate: date, categoryId: category._id, payerUserId, payerAccountId,
        purchaseType, startMonth, endMonth: addMonths(startMonth, duration - 1),
        months: duration, shares: normalizedShares.map((row) => ({
          ...row, monthlyAmount: amountsByMonth(row.shareAmount, duration)[0],
        })),
        note: String(note || '').trim(), createdByUserId: req.user.userId,
      }]);
      const [upfront] = await Transaction.create([{
        familyId: req.familyId, txType: 'expense', date, month: purchaseMonth,
        categoryId: category._id, amount: total,
        note: `[Large purchase upfront] ${String(title).trim()}`,
        fromAccountId: payerAccountId, toAccountId: null, paidByUserId: payerUserId,
        receivedByUserId: null, paymentMode: 'single', paymentParts: [], split: null,
        budgetImpact: false, ledgerEligible: false, settlementImpact: false,
        sourceType: 'shared_purchase', sourceId: purchase._id,
        createdByUserId: req.user.userId,
      }]);
      purchase.upfrontTransactionId = upfront._id;
      await purchase.save();

      const schedule = [];
      for (const share of normalizedShares) {
        const amounts = amountsByMonth(share.shareAmount, duration);
        const paymentRequired = String(share.userId) !== String(payerUserId);
        for (let index = 0; index < duration; index += 1) {
          const month = addMonths(startMonth, index);
          schedule.push({
            familyId: req.familyId, purchaseId: purchase._id, userId: share.userId,
            month, dueDate: dueDateForMonth(month, date.getDate()), amount: amounts[index],
            paymentRequired, status: paymentRequired ? 'pending' : 'allocated',
          });
        }
      }
      const installmentDocs = await SharedPurchaseInstallment.insertMany(schedule);
      const own = installmentDocs.filter((item) => !item.paymentRequired);
      if (own.length) {
        const entries = await LedgerEntry.insertMany(own.map((item) => ({
          familyId: req.familyId, entryType: 'expense', financialType: 'debt',
          module: 'shared_purchase', date: item.dueDate, month: item.month,
          categoryId: category._id, amountTotal: item.amount, affectsSettlement: false,
          paidByUserId: item.userId, receivedByUserId: null,
          note: `${String(purchase.title).trim()} · monthly allocation`,
          sourceType: 'shared_purchase_installment', sourceId: item._id,
          createdByUserId: req.user.userId,
        })));
        await Split.insertMany(entries.map((entry, i) => ({
          familyId: req.familyId, ledgerEntryId: entry._id,
          userId: own[i].userId, shareAmount: own[i].amount,
        })));
        await SharedPurchaseInstallment.bulkWrite(own.map((item, i) => ({
          updateOne: {
            filter: { _id: item._id, familyId: req.familyId },
            update: { $set: { ledgerEntryId: entries[i]._id } },
          },
        })));
      }
      await refreshPurchaseStatus(purchase._id, req.familyId);
      return purchase._id;
    });
    res.status(result.replayed ? 200 : 201).json({
      ok: true, purchaseId: result.resultId, replayed: Boolean(result.replayed),
    });
  } catch (error) {
    console.error('Create shared purchase error:', error);
    res.status(error.status || 500).json({ ok: false, message: error.message || 'Could not create purchase' });
  }
});

router.post(
  '/:purchaseId/installments/:installmentId/pay',
  requireAuth, requireFamily, async (req, res) => {
    try {
      const { fromAccountId, toAccountId, paidDate, note, purchaseId, installmentId } = req.body || {};
      if (String(purchaseId || '') !== String(req.params.purchaseId) ||
          String(installmentId || '') !== String(req.params.installmentId)) {
        throw purchaseWriteError('Purchase and installment identifiers must match the payment request');
      }
      const result = await createIdempotentFinancialPosting(req, 'sharedPurchase.pay', async () => {
        const installment = requirePendingInstallmentForPayment(await SharedPurchaseInstallment.findOne({
          _id: req.params.installmentId, purchaseId: req.params.purchaseId, familyId: req.familyId,
        }));
        // Never edit an installment scheduled in older manually corrected months.
        ensureEditablePurchaseMonth(installment.month);
        if (!fromAccountId || !toAccountId || String(fromAccountId) === String(toAccountId)) {
          throw purchaseWriteError('Choose different From and To accounts');
        }
        const date = paidDate ? new Date(paidDate) : new Date();
        const paymentMonth = ensureEditablePurchaseMonth(monthKey(date));
        await requireOpenMonth(req.familyId, paymentMonth);
        const purchase = await SharedPurchase.findOne({ _id: req.params.purchaseId, familyId: req.familyId });
        if (!purchase) throw purchaseWriteError('Purchase not found', 404);
        const accounts = await Account.find({
          _id: { $in: [fromAccountId, toAccountId] }, familyId: req.familyId,
          isActive: { $ne: false },
        }).lean();
        if (accounts.length !== 2) throw purchaseWriteError('Invalid account selected');
        const byId = new Map(accounts.map((account) => [String(account._id), account]));
        const from = requireLiquidPurchaseAccount(byId.get(String(fromAccountId)));
        const to = requireLiquidPurchaseAccount(byId.get(String(toAccountId)));
        const names = await memberNameMap(req.familyId, [installment.userId, purchase.payerUserId]);
        if (!accountOwnerMatchesMember(from, installment.userId, names)) {
          throw purchaseWriteError('Payment source must belong to the reimbursing member');
        }
        if (!accountOwnerMatchesMember(to, purchase.payerUserId, names)) {
          throw purchaseWriteError('Receiving account must belong to the upfront payer');
        }
        if (await Transaction.exists({ familyId: req.familyId, sourceType: 'shared_purchase_reimbursement', sourceId: installment._id })) {
          throw purchaseWriteError('An existing reimbursement transaction requires review before another payment.', 409);
        }
        if (await LedgerEntry.exists({ familyId: req.familyId, sourceType: 'shared_purchase_installment', sourceId: installment._id })) {
          throw purchaseWriteError('An old Ledger entry is attached to this pending installment. Review before paying.', 409);
        }
        // Conditional update is a database-level race guard, not a UI-only check.
        const claimed = await SharedPurchaseInstallment.updateOne({
          _id: installment._id, familyId: req.familyId,
          status: 'pending', paymentTransactionId: null, ledgerEntryId: null,
        }, { $set: { status: 'paid' } });
        if (claimed.modifiedCount !== 1) throw purchaseWriteError('This installment was already changed. Refresh before retrying.', 409);
        const [payment] = await Transaction.create([{
          familyId: req.familyId, txType: 'transfer', date, month: paymentMonth, categoryId: null,
          amount: installment.amount,
          note: `[Purchase reimbursement] ${purchase.title}${note ? ` · ${String(note).trim()}` : ''}`,
          fromAccountId, toAccountId,
          paidByUserId: installment.userId, receivedByUserId: purchase.payerUserId,
          paymentMode: 'single', paymentParts: [], budgetImpact: false,
          ledgerEligible: false, settlementImpact: false,
          sourceType: 'shared_purchase_reimbursement', sourceId: installment._id,
          createdByUserId: req.user.userId,
        }]);
        const ledger = await upsertSharedInstallmentLedger({
          familyId: req.familyId, purchase, installment, categoryId: purchase.categoryId,
          date, createdByUserId: req.user.userId, linkInstallment: false,
        });
        const written = await SharedPurchaseInstallment.updateOne({
          _id: installment._id, familyId: req.familyId, status: 'paid', paymentTransactionId: null,
        }, { $set: {
          paymentTransactionId: payment._id, ledgerEntryId: ledger._id,
          fromAccountId, toAccountId, paidAt: date,
        } });
        if (written.modifiedCount !== 1) throw purchaseWriteError('Installment changed concurrently. Refresh first.', 409);
        await refreshPurchaseStatus(purchase._id, req.familyId);
        return installment._id;
      });
      res.status(200).json({ ok: true, installmentId: result.resultId, replayed: Boolean(result.replayed) });
    } catch (error) {
      console.error('Pay shared purchase installment error:', error);
      res.status(error.status || 500).json({ ok: false, message: error.message || 'Payment failed' });
    }
  }
);

router.delete('/:purchaseId/installments/:installmentId/payment', requireAuth, requireFamily, async (req, res) => {
  try {
    await runAtomicPosting(async () => {
      const installment = await SharedPurchaseInstallment.findOne({
        _id: req.params.installmentId, purchaseId: req.params.purchaseId, familyId: req.familyId,
      });
      if (!installment) throw purchaseWriteError('Installment not found', 404);
      if (!installment.paymentRequired || installment.status !== 'paid') {
        throw purchaseWriteError('No recorded reimbursement to undo');
      }
      ensureEditablePurchaseMonth(installment.month);
      const purchase = await SharedPurchase.findOne({ _id: installment.purchaseId, familyId: req.familyId });
      if (!purchase) throw purchaseWriteError('Purchase not found', 404);
      const tx = installment.paymentTransactionId ? await Transaction.findOne({
        _id: installment.paymentTransactionId, familyId: req.familyId,
      }) : null;
      if (!validReimbursement(installment, purchase, tx)) {
        throw purchaseWriteError('Reimbursement has incomplete or mismatched account evidence. Review instead of undoing it.', 409);
      }
      const matchingTxCount = await Transaction.countDocuments({
        familyId: req.familyId, sourceType: 'shared_purchase_reimbursement', sourceId: installment._id,
      });
      if (matchingTxCount !== 1) {
        throw purchaseWriteError('Duplicate or missing repayment transfers detected. Review rather than undoing automatically.', 409);
      }
      ensureEditablePurchaseMonth(tx.month);
      await requireOpenMonth(req.familyId, tx.month);
      const ledger = installment.ledgerEntryId ? await LedgerEntry.findOne({
        _id: installment.ledgerEntryId, familyId: req.familyId,
      }) : null;
      requireLinkedDocument(ledger, {
        sourceType: 'shared_purchase_installment', sourceId: installment._id,
        label: 'Reimbursement Ledger record',
      });
      ensureEditablePurchaseMonth(ledger.month);
      await requireOpenMonth(req.familyId, ledger.month);
      // Claim the paid row before deleting its only linked account movements.
      const claimed = await SharedPurchaseInstallment.updateOne({
        _id: installment._id, familyId: req.familyId, status: 'paid',
        paymentTransactionId: tx._id, ledgerEntryId: ledger._id,
      }, { $set: { status: 'pending', paymentTransactionId: null, ledgerEntryId: null,
        fromAccountId: null, toAccountId: null, paidAt: null } });
      if (claimed.modifiedCount !== 1) throw purchaseWriteError('Payment changed concurrently. Refresh first.', 409);
      await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: ledger._id });
      const deletedLedger = await LedgerEntry.deleteOne({ _id: ledger._id, familyId: req.familyId });
      const deletedTx = await Transaction.deleteOne({ _id: tx._id, familyId: req.familyId });
      if (deletedLedger.deletedCount !== 1 || deletedTx.deletedCount !== 1) {
        throw purchaseWriteError('Linked payment records changed. Nothing was reversed.', 409);
      }
      await refreshPurchaseStatus(purchase._id, req.familyId);
    });
    res.json({ ok: true });
  } catch (error) {
    const err = atomicPostingError(error);
    console.error('Undo shared purchase payment error:', err);
    res.status(err.status || 500).json({ ok: false, message: err.message || 'Could not undo payment' });
  }
});

// Edit description/category and optionally reschedule *unpaid future* allocations.
// The original bank debit, price, members' lifetime shares, and posted reimbursements
// are immutable. A single MongoDB transaction covers every changed schedule row.
router.put('/:purchaseId/details', requireAuth, requireFamily, async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const note = String(req.body?.note ?? '').trim();
    const categoryId = String(req.body?.categoryId || '');
    const dueDay = req.body?.dueDay == null ? null : Number(req.body.dueDay);
    const reviseSchedule = req.body?.reviseSchedule === true;
    const effectiveMonth = String(req.body?.effectiveMonth || '');
    const nextStartMonth = String(req.body?.nextStartMonth || '');
    const remainingMonths = Number(req.body?.remainingMonths || 0);
    const keys = ['title','note','categoryId','dueDay','reviseSchedule','effectiveMonth','nextStartMonth','remainingMonths','expectedUpdatedAt'];
    if (Object.keys(req.body || {}).some(key => !keys.includes(key))) {
      throw purchaseWriteError('অপ্রত্যাশিত তথ্য এসেছে। মূল দাম ও পরিশোধিত হিসাব এভাবে বদলানো যাবে না।');
    }
    if (!title || title.length > 160 || note.length > 1000) throw purchaseWriteError('সঠিক নাম ও মন্তব্য দিন।');
    if (dueDay != null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) throw purchaseWriteError('কিস্তির দিন ১–৩১ এর মধ্যে দিন।');
    if (categoryId && !mongoose.isValidObjectId(categoryId)) throw purchaseWriteError('খরচের খাত সঠিক নয়।');
    if (reviseSchedule && (!validMonth(effectiveMonth) || !validMonth(nextStartMonth) ||
      !Number.isInteger(remainingMonths) || remainingMonths < 1 || remainingMonths > 120 || nextStartMonth < effectiveMonth)) {
      throw purchaseWriteError('বাকি কিস্তির সময়সূচি বা মেয়াদ সঠিক নয়।');
    }
    const result = await runAtomicPosting(async () => {
      const purchase = await SharedPurchase.findOne({_id:req.params.purchaseId, familyId:req.familyId});
      if (!purchase) throw purchaseWriteError('কেনাকাটা পাওয়া যায়নি।',404);
      if ((req.body?.expectedUpdatedAt && new Date(req.body.expectedUpdatedAt).getTime() !== new Date(purchase.updatedAt).getTime()) ||
        (!req.body?.expectedUpdatedAt && (reviseSchedule || dueDay != null || categoryId))) {
        throw purchaseWriteError('কেনাকাটার তথ্য অন্য কোথাও পরিবর্তন হয়েছে। রিফ্রেশ করে আবার চেষ্টা করুন।',409);
      }
      const oldRows = await SharedPurchaseInstallment.find({familyId:req.familyId,purchaseId:purchase._id})
        .sort({month:1,userId:1});
      if (!oldRows.length) throw purchaseWriteError('কিস্তির হিসাব পাওয়া যায়নি; সম্পাদনা বন্ধ রাখা হয়েছে।',409);
      const clock = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit'})
        .formatToParts(new Date());
      const currentMonth = `${clock.find(p=>p.type==='year')?.value}-${clock.find(p=>p.type==='month')?.value}`;
      const protectedBefore = currentMonth > '2026-10' ? currentMonth : '2026-10';
      if (reviseSchedule && effectiveMonth < protectedBefore) {
        throw purchaseWriteError('আগের বা বর্তমানে বন্ধ মাসের কিস্তির সময়সূচি পরিবর্তন করা যাবে না।',409);
      }
      const existingDay = new Date(oldRows.find(row=>row.month>=protectedBefore)?.dueDate || purchase.purchaseDate).getUTCDate();
      const effectiveDay = dueDay == null ? existingDay : dueDay;
      const touchingSchedule = reviseSchedule || effectiveDay !== existingDay ||
        (categoryId && categoryId !== String(purchase.categoryId));
      const changesStart = reviseSchedule ? effectiveMonth : protectedBefore;
      const changedRows = touchingSchedule ? oldRows.filter(row => row.month >= changesStart && (reviseSchedule || canReviseFuture(row))) : [];
      if (reviseSchedule && !changedRows.length) throw purchaseWriteError('এখন থেকে বদলানোর মতো কোনো কিস্তি নেই।',409);
      if (reviseSchedule && changedRows.some(row => !canReviseFuture(row))) {
        throw purchaseWriteError('নির্বাচিত সময়ের কিস্তিতে ইতিমধ্যে payment বা পুরোনো অসম্পূর্ণ record আছে। সেগুলো পরিবর্তন করা যাবে না।',409);
      }
      const monthsToChange = changedRows.map(row => row.month);
      if (reviseSchedule) for(let i=0;i<remainingMonths;i++) monthsToChange.push(addMonths(nextStartMonth,i));
      if (changedRows.length) await requireOpenPurchaseMonths(req.familyId, monthsToChange);
      const sameCategory = categoryId && categoryId === String(purchase.categoryId);
      const category = categoryId && !sameCategory ? await Category.findOne({familyId:req.familyId,_id:categoryId,kind:'expense',isActive:{$ne:false}}) : null;
      if (categoryId && !sameCategory && !category) throw purchaseWriteError('নির্বাচিত খরচের খাত পাওয়া যায়নি।');
      const nextCategory = category?._id || purchase.categoryId;

      // Inspect all expected future allocation links BEFORE deleting anything.
      // A legacy orphaned Ledger row must never be discarded silently.
      if (changedRows.length) {
        const existing = await LedgerEntry.find({familyId:req.familyId,sourceType:'shared_purchase_installment',
          sourceId:{$in:changedRows.map(r=>r._id)}}).select('_id sourceId').lean();
        const expected = new Set(changedRows.filter(r=>!r.paymentRequired).map(r=>String(r._id)));
        if (existing.length !== expected.size || existing.some(r=>!expected.has(String(r.sourceId)))) {
          throw purchaseWriteError('কিস্তির Ledger হিসাব মিলছে না। আগে যাচাই করে সংশোধন করুন।',409);
        }
      }
      const own = changedRows.filter(row => !row.paymentRequired);
      const linkedIds=[];
      for (const row of own) {
        const entry = row.ledgerEntryId ? await LedgerEntry.findOne({familyId:req.familyId,_id:row.ledgerEntryId}) : null;
        requireLinkedDocument(entry,{sourceType:'shared_purchase_installment',sourceId:row._id,label:'Future allocation'});
        if (cents(entry.amountTotal) !== cents(row.amount)) throw purchaseWriteError('একটি কিস্তির allocation হিসাব মিলছে না। পরিবর্তন করা হয়নি।',409);
        const all=await LedgerEntry.find({familyId:req.familyId,sourceType:'shared_purchase_installment',sourceId:row._id});
        if(all.length!==1) throw purchaseWriteError('একটি কিস্তিতে একাধিক Ledger record রয়েছে। আগে যাচাই করুন।',409);
        const splits=await Split.find({familyId:req.familyId,ledgerEntryId:entry._id}).lean();
        if(splits.length!==1 || String(splits[0].userId)!==String(row.userId) || cents(splits[0].shareAmount)!==cents(row.amount)) {
          throw purchaseWriteError('ভবিষ্যতের কিস্তির ভাগ ও Ledger হিসাব মিলছে না। পরিবর্তন করা হয়নি।',409);
        }
        linkedIds.push(entry._id);
      }
      if (reviseSchedule) {
        const preserved = oldRows.filter(row => row.month < effectiveMonth);
        const newDocs=[];
        const priorMonths=new Set(preserved.map(row=>row.month)).size;
        if (priorMonths + remainingMonths > 120) throw purchaseWriteError('সর্বোচ্চ ১২০টি নির্ধারিত মাস রাখা যাবে।');
        for (const share of purchase.shares) {
          const past=preserved.filter(row=>String(row.userId)===String(share.userId));
          const balance= futureRemainder(share.shareAmount,past);
          if (balance < remainingMonths) throw purchaseWriteError('প্রতি মাসে শূন্য টাকার কিস্তি রাখা যাবে না। মাস সংখ্যা কমান।');
          const monthly= splitCents(balance,remainingMonths);
          for (let index=0;index<remainingMonths;index++) {
            const month=addMonths(nextStartMonth,index);
            newDocs.push({familyId:req.familyId,purchaseId:purchase._id,userId:share.userId,
              month,dueDate:dueDateForMonth(month,effectiveDay),amount:monthly[index],
              paymentRequired:String(share.userId)!==String(purchase.payerUserId),
              status:String(share.userId)===String(purchase.payerUserId)?'allocated':'pending',
            });
          }
        }
        await Split.deleteMany({familyId:req.familyId,ledgerEntryId:{$in:linkedIds}});
        await LedgerEntry.deleteMany({familyId:req.familyId,_id:{$in:linkedIds}});
        await SharedPurchaseInstallment.deleteMany({familyId:req.familyId,_id:{$in:changedRows.map(r=>r._id)}});
        const inserted=await SharedPurchaseInstallment.insertMany(newDocs);
        const ownNew=inserted.filter(row=>!row.paymentRequired);
        if(ownNew.length){
          const entries=await LedgerEntry.insertMany(ownNew.map(row=>({familyId:req.familyId,
            entryType:'expense',financialType:'debt',module:'shared_purchase',date:row.dueDate,month:row.month,
            categoryId:nextCategory,amountTotal:row.amount,affectsSettlement:false,
            paidByUserId:row.userId,receivedByUserId:null,note:`${title} · monthly allocation`,
            sourceType:'shared_purchase_installment',sourceId:row._id,createdByUserId:req.user.userId,
          })));
          await Split.insertMany(entries.map((entry,i)=>({familyId:req.familyId,ledgerEntryId:entry._id,
            userId:ownNew[i].userId,shareAmount:ownNew[i].amount})));
          await SharedPurchaseInstallment.bulkWrite(ownNew.map((row,i)=>({updateOne:{
            filter:{familyId:req.familyId,_id:row._id},update:{$set:{ledgerEntryId:entries[i]._id}},
          }})));
        }
        purchase.months=priorMonths+remainingMonths;
        purchase.endMonth=addMonths(nextStartMonth,remainingMonths-1);
        for(const share of purchase.shares){
          const past=preserved.filter(row=>String(row.userId)===String(share.userId));
          share.monthlyAmount=splitCents(futureRemainder(share.shareAmount,past),remainingMonths)[0];
        }
      } else {
        for (const row of own) {
          await LedgerEntry.updateOne({familyId:req.familyId,_id:row.ledgerEntryId},{$set:{
            categoryId:nextCategory,note:`${title} · monthly allocation`,date:dueDateForMonth(row.month,effectiveDay),
          }});
        }
        for (const row of changedRows) {
          row.dueDate=dueDateForMonth(row.month,effectiveDay);
          await row.save();
        }
      }
      purchase.title=title;purchase.note=note;purchase.categoryId=nextCategory;
      await purchase.save();
      await refreshPurchaseStatus(purchase._id,req.familyId);
      return purchase._id;
    });
    res.json({ok:true,purchaseId:result, message:reviseSchedule?'ভবিষ্যতের কিস্তি নতুন করে সাজানো হয়েছে।':'কেনাকাটার তথ্য পরিবর্তন হয়েছে।'});
  } catch (error) {
    const normalized=atomicPostingError(error);
    res.status(normalized.status||500).json({ok:false,message:normalized.message||'কেনাকাটা পরিবর্তন করা যায়নি।'});
  }
});

router.delete('/:purchaseId', requireAuth, requireFamily, async (req, res) => {
  try {
    await runAtomicPosting(async () => {
      const purchase = await SharedPurchase.findOne({ _id: req.params.purchaseId, familyId: req.familyId });
      if (!purchase) throw purchaseWriteError('Purchase not found', 404);
      const installments = await SharedPurchaseInstallment.find({
        familyId: req.familyId, purchaseId: purchase._id,
      });
      if (!installments.length) throw purchaseWriteError('Purchase has no installment records; review before deletion.', 409);
      requireSafePlanRemoval(purchase, installments);
      // Include orphaned legacy rows, not just the installment's linked IDs.
      const installmentIds = installments.map((item) => item._id);
      const [unlinkedPayments, unlinkedLedger] = await Promise.all([
        Transaction.exists({
          familyId: req.familyId, sourceType: 'shared_purchase_reimbursement',
          sourceId: { $in: installmentIds },
        }),
        LedgerEntry.find({
          familyId: req.familyId, sourceType: 'shared_purchase_installment',
          sourceId: { $in: installmentIds },
        }).select('_id sourceId').lean(),
      ]);
      if (unlinkedPayments) throw purchaseWriteError('Reimbursement transactions still exist. Review them before deleting.', 409);
      const expectedAllocations = new Set(installments
        .filter((item) => !item.paymentRequired && item.ledgerEntryId)
        .map((item) => String(item.ledgerEntryId)));
      if (unlinkedLedger.some((row) => !expectedAllocations.has(String(row._id)))) {
        throw purchaseWriteError('Legacy or orphan Ledger rows need review before deleting this plan.', 409);
      }
      const upfrontMonth = ensureEditablePurchaseMonth(monthKey(purchase.purchaseDate));
      await requireOpenPurchaseMonths(req.familyId, [upfrontMonth, ...installments.map((item) => item.month)]);
      const upfront = purchase.upfrontTransactionId ? await Transaction.findOne({
        _id: purchase.upfrontTransactionId, familyId: req.familyId,
      }) : null;
      requireLinkedDocument(upfront, {
        sourceType: 'shared_purchase', sourceId: purchase._id,
        amount: purchase.totalAmount, label: 'Original upfront payment',
      });
      if (upfront.txType !== 'expense' || String(upfront.fromAccountId) !== String(purchase.payerAccountId)) {
        throw purchaseWriteError('Original payment account differs from purchase. Review before deleting.', 409);
      }
      await requireOpenMonth(req.familyId, ensureEditablePurchaseMonth(upfront.month));
      const own = installments.filter((item) => !item.paymentRequired);
      const ledgerIds = own.map((item) => item.ledgerEntryId);
      if (ledgerIds.some((id) => !id)) throw purchaseWriteError('Monthly allocation Ledger record missing; review before deleting.', 409);
      const entries = await LedgerEntry.find({ familyId: req.familyId, _id: { $in: ledgerIds } });
      if (entries.length !== ledgerIds.length) throw purchaseWriteError('Missing linked monthly allocations; review before deleting.', 409);
      for (const item of own) {
        const entry = entries.find((row) => String(row._id) === String(item.ledgerEntryId));
        requireLinkedDocument(entry, {
          sourceType: 'shared_purchase_installment', sourceId: item._id,
          label: 'Monthly purchase allocation',
        });
        await requireOpenMonth(req.familyId, ensureEditablePurchaseMonth(entry.month));
      }
      // No recorded reimbursements are destroyed by plan deletion. Reimbursements
      // must be undone explicitly and are forbidden if historical/closed.
      if (ledgerIds.length) {
        await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: { $in: ledgerIds } });
        const removed = await LedgerEntry.deleteMany({ familyId: req.familyId, _id: { $in: ledgerIds } });
        if (removed.deletedCount !== ledgerIds.length) throw purchaseWriteError('Ledger changed concurrently.', 409);
      }
      const removedUpfront = await Transaction.deleteOne({ familyId: req.familyId, _id: upfront._id });
      if (removedUpfront.deletedCount !== 1) throw purchaseWriteError('Upfront payment changed concurrently.', 409);
      const removedInstallments = await SharedPurchaseInstallment.deleteMany({ familyId: req.familyId, purchaseId: purchase._id });
      if (removedInstallments.deletedCount !== installments.length) throw purchaseWriteError('Installments changed concurrently.', 409);
      const removedPurchase = await SharedPurchase.deleteOne({ _id: purchase._id, familyId: req.familyId });
      if (removedPurchase.deletedCount !== 1) throw purchaseWriteError('Purchase changed concurrently.', 409);
    });
    res.json({ ok: true });
  } catch (error) {
    const err = atomicPostingError(error);
    console.error('Delete shared purchase error:', err);
    res.status(err.status || 500).json({ ok: false, message: err.message || 'Delete failed' });
  }
});

export default router;
