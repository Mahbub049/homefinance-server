import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import SharedPurchase from "../models/SharedPurchase.js";
import SharedPurchaseInstallment from "../models/SharedPurchaseInstallment.js";
import FamilyMember from "../models/FamilyMember.js";
import Account from "../models/Account.js";
import Category from "../models/Category.js";
import Transaction from "../models/Transaction.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";

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

router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = validMonth(req.query.month) ? String(req.query.month) : monthKey(new Date());

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

    let totalOutstanding = 0;
    let totalReceivable = 0;
    let monthAllocation = 0;
    let monthDue = 0;
    let monthReceived = 0;

    const enrichedPlans = plans.map((plan) => {
      const installments = installmentMap.get(String(plan._id)) || [];
      const paymentInstallments = installments.filter((row) => row.paymentRequired);
      const paidInstallments = paymentInstallments.filter((row) => row.status === "paid");
      const paidAmount = round2(
        paidInstallments.reduce((sum, row) => sum + Number(row.amount || 0), 0)
      );
      const receivableTotal = round2(
        paymentInstallments.reduce((sum, row) => sum + Number(row.amount || 0), 0)
      );
      const outstanding = round2(Math.max(0, receivableTotal - paidAmount));
      const selectedMonthRows = installments.filter((row) => row.month === month);

      totalReceivable = round2(totalReceivable + receivableTotal);
      totalOutstanding = round2(totalOutstanding + outstanding);
      monthAllocation = round2(
        monthAllocation +
          selectedMonthRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
      );
      monthDue = round2(
        monthDue +
          selectedMonthRows
            .filter((row) => row.paymentRequired && row.status !== "paid")
            .reduce((sum, row) => sum + Number(row.amount || 0), 0)
      );
      monthReceived = round2(
        monthReceived +
          installments
            .filter(
              (row) =>
                row.paymentRequired &&
                row.status === "paid" &&
                row.paidAt &&
                monthKey(row.paidAt) === month
            )
            .reduce((sum, row) => sum + Number(row.amount || 0), 0)
      );

      const progress = receivableTotal > 0 ? round2((paidAmount / receivableTotal) * 100) : 100;
      const effectiveStatus =
        paymentInstallments.length === 0 && monthKey(new Date()) > plan.endMonth
          ? "completed"
          : plan.status;

      return {
        ...plan,
        status: effectiveStatus,
        stats: {
          receivableTotal,
          paidAmount,
          outstanding,
          paidCount: paidInstallments.length,
          paymentCount: paymentInstallments.length,
          progress,
        },
        monthInstallments: selectedMonthRows,
      };
    });

    const monthInstallments = allInstallments.filter((row) => row.month === month);

    res.json({
      ok: true,
      month,
      plans: enrichedPlans,
      monthInstallments,
      summary: {
        totalReceivable,
        totalOutstanding,
        monthAllocation,
        monthDue,
        monthReceived,
        activePlans: enrichedPlans.filter((plan) => plan.status === "active").length,
      },
    });
  } catch (error) {
    console.error("Shared purchase list error:", error);
    res.status(500).json({ ok: false, message: error?.message || "Failed to load purchases" });
  }
});

router.post("/", requireAuth, requireFamily, async (req, res) => {
  let purchase = null;
  let upfrontTransaction = null;
  const createdInstallmentIds = [];
  const createdLedgerIds = [];

  try {
    const {
      title,
      totalAmount,
      purchaseDate,
      categoryId,
      payerUserId,
      payerAccountId,
      purchaseType = "shared",
      startMonth,
      months,
      shares,
      note,
    } = req.body || {};

    const total = round2(totalAmount);
    const duration = Number(months);
    const date = new Date(purchaseDate);

    if (!String(title || "").trim()) {
      return res.status(400).json({ ok: false, message: "Purchase title is required" });
    }
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ ok: false, message: "Total amount must be greater than 0" });
    }
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json({ ok: false, message: "Valid purchase date is required" });
    }
    if (!payerUserId || !payerAccountId) {
      return res.status(400).json({ ok: false, message: "Payer and payment account are required" });
    }
    if (!validMonth(startMonth)) {
      return res.status(400).json({ ok: false, message: "Valid start month is required" });
    }
    if (!Number.isInteger(duration) || duration < 1 || duration > 120) {
      return res.status(400).json({ ok: false, message: "Months must be between 1 and 120" });
    }
    if (!["personal", "shared"].includes(purchaseType)) {
      return res.status(400).json({ ok: false, message: "Invalid purchase type" });
    }

    const account = await Account.findOne({
      _id: payerAccountId,
      familyId: req.familyId,
      isActive: { $ne: false },
    });
    if (!account) {
      return res.status(400).json({ ok: false, message: "Invalid payer account" });
    }

    let normalizedShares = Array.isArray(shares)
      ? shares
          .map((row) => ({
            userId: plainUserId(row?.userId),
            shareAmount: round2(row?.shareAmount),
          }))
          .filter((row) => row.userId && row.shareAmount > 0)
      : [];

    if (purchaseType === "personal") {
      normalizedShares = [{ userId: String(payerUserId), shareAmount: total }];
    }

    const uniqueUserIds = new Set(normalizedShares.map((row) => String(row.userId)));
    if (!normalizedShares.length || uniqueUserIds.size !== normalizedShares.length) {
      return res.status(400).json({ ok: false, message: "Each member must appear once with a positive share" });
    }
    if (!uniqueUserIds.has(String(payerUserId))) {
      return res.status(400).json({ ok: false, message: "The payer must have a share in the purchase" });
    }
    if (!(await validateMemberIds(req.familyId, [...uniqueUserIds]))) {
      return res.status(400).json({ ok: false, message: "One or more selected members are invalid" });
    }

    const shareTotal = round2(
      normalizedShares.reduce((sum, row) => sum + Number(row.shareAmount || 0), 0)
    );
    if (shareTotal !== total) {
      return res.status(400).json({
        ok: false,
        message: `Member shares must total exactly ${total}`,
      });
    }

    const category = await resolveCategory(req.familyId, categoryId);
    if (!category) {
      return res.status(400).json({ ok: false, message: "Could not resolve expense category" });
    }

    const endMonth = addMonths(startMonth, duration - 1);
    const shareDocs = normalizedShares.map((row) => ({
      ...row,
      monthlyAmount: amountsByMonth(row.shareAmount, duration)[0],
    }));

    purchase = await SharedPurchase.create({
      familyId: req.familyId,
      title: String(title).trim(),
      totalAmount: total,
      purchaseDate: date,
      categoryId: category._id,
      payerUserId,
      payerAccountId,
      purchaseType,
      startMonth,
      endMonth,
      months: duration,
      shares: shareDocs,
      note: String(note || "").trim(),
      createdByUserId: req.user.userId,
    });

    upfrontTransaction = await Transaction.create({
      familyId: req.familyId,
      txType: "expense",
      date,
      month: monthKey(date),
      categoryId: category._id,
      amount: total,
      note: `[Large purchase upfront] ${String(title).trim()}`,
      fromAccountId: payerAccountId,
      toAccountId: null,
      paidByUserId: payerUserId,
      receivedByUserId: null,
      paymentMode: "single",
      paymentParts: [],
      split: null,
      budgetImpact: false,
      ledgerEligible: false,
      settlementImpact: false,
      sourceType: "shared_purchase",
      sourceId: purchase._id,
      createdByUserId: req.user.userId,
    });

    purchase.upfrontTransactionId = upfrontTransaction._id;
    await purchase.save();

    const preferredDay = date.getDate();

    for (const share of normalizedShares) {
      const scheduledAmounts = amountsByMonth(share.shareAmount, duration);
      const paymentRequired = String(share.userId) !== String(payerUserId);

      for (let index = 0; index < duration; index += 1) {
        const month = addMonths(startMonth, index);
        const dueDate = dueDateForMonth(month, preferredDay);
        const installment = await SharedPurchaseInstallment.create({
          familyId: req.familyId,
          purchaseId: purchase._id,
          userId: share.userId,
          month,
          dueDate,
          amount: scheduledAmounts[index],
          paymentRequired,
          status: paymentRequired ? "pending" : "allocated",
        });
        createdInstallmentIds.push(installment._id);

        const ledgerEntry = await LedgerEntry.create({
          familyId: req.familyId,
          entryType: "expense",
          financialType: "debt",
          module: "shared_purchase",
          date: dueDate,
          month,
          categoryId: category._id,
          amountTotal: scheduledAmounts[index],
          affectsSettlement: false,
          paidByUserId: share.userId,
          receivedByUserId: null,
          note: `${String(title).trim()} · monthly allocation`,
          sourceType: "shared_purchase_installment",
          sourceId: installment._id,
          createdByUserId: req.user.userId,
        });
        createdLedgerIds.push(ledgerEntry._id);

        await Split.create({
          familyId: req.familyId,
          ledgerEntryId: ledgerEntry._id,
          userId: share.userId,
          shareAmount: scheduledAmounts[index],
        });

        installment.ledgerEntryId = ledgerEntry._id;
        await installment.save();
      }
    }

    await refreshPurchaseStatus(purchase._id, req.familyId);

    res.status(201).json({ ok: true, purchaseId: purchase._id });
  } catch (error) {
    console.error("Create shared purchase error:", error);

    try {
      if (createdLedgerIds.length) {
        await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: { $in: createdLedgerIds } });
        await LedgerEntry.deleteMany({ familyId: req.familyId, _id: { $in: createdLedgerIds } });
      }
      if (createdInstallmentIds.length) {
        await SharedPurchaseInstallment.deleteMany({
          familyId: req.familyId,
          _id: { $in: createdInstallmentIds },
        });
      }
      if (upfrontTransaction?._id) {
        await Transaction.deleteOne({ _id: upfrontTransaction._id, familyId: req.familyId });
      }
      if (purchase?._id) {
        await SharedPurchase.deleteOne({ _id: purchase._id, familyId: req.familyId });
      }
    } catch (cleanupError) {
      console.error("Shared purchase cleanup error:", cleanupError);
    }

    res.status(500).json({ ok: false, message: error?.message || "Could not create purchase" });
  }
});

router.post(
  "/:purchaseId/installments/:installmentId/pay",
  requireAuth,
  requireFamily,
  async (req, res) => {
    try {
      const { fromAccountId, toAccountId, paidDate, note } = req.body || {};
      const installment = await SharedPurchaseInstallment.findOne({
        _id: req.params.installmentId,
        purchaseId: req.params.purchaseId,
        familyId: req.familyId,
      });

      if (!installment) {
        return res.status(404).json({ ok: false, message: "Installment not found" });
      }
      if (!installment.paymentRequired) {
        return res.status(400).json({ ok: false, message: "This is a budget allocation and needs no transfer" });
      }
      if (installment.status === "paid") {
        return res.status(400).json({ ok: false, message: "Installment is already paid" });
      }
      if (!fromAccountId || !toAccountId || String(fromAccountId) === String(toAccountId)) {
        return res.status(400).json({ ok: false, message: "Different From and To accounts are required" });
      }

      const purchase = await SharedPurchase.findOne({
        _id: req.params.purchaseId,
        familyId: req.familyId,
      });
      if (!purchase) {
        return res.status(404).json({ ok: false, message: "Purchase not found" });
      }

      const accounts = await Account.find({
        _id: { $in: [fromAccountId, toAccountId] },
        familyId: req.familyId,
        isActive: { $ne: false },
      }).lean();
      if (accounts.length !== 2) {
        return res.status(400).json({ ok: false, message: "Invalid account selected" });
      }

      const date = paidDate ? new Date(paidDate) : new Date();
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ ok: false, message: "Invalid payment date" });
      }

      const transaction = await Transaction.create({
        familyId: req.familyId,
        txType: "transfer",
        date,
        month: monthKey(date),
        categoryId: null,
        amount: installment.amount,
        note: `[Purchase reimbursement] ${purchase.title}${note ? ` · ${String(note).trim()}` : ""}`,
        fromAccountId,
        toAccountId,
        paidByUserId: installment.userId,
        receivedByUserId: purchase.payerUserId,
        paymentMode: "single",
        paymentParts: [],
        budgetImpact: false,
        ledgerEligible: false,
        settlementImpact: false,
        sourceType: "shared_purchase_reimbursement",
        sourceId: installment._id,
        createdByUserId: req.user.userId,
      });

      installment.status = "paid";
      installment.paymentTransactionId = transaction._id;
      installment.fromAccountId = fromAccountId;
      installment.toAccountId = toAccountId;
      installment.paidAt = date;
      await installment.save();

      const status = await refreshPurchaseStatus(purchase._id, req.familyId);
      res.json({ ok: true, status, transactionId: transaction._id });
    } catch (error) {
      console.error("Pay shared purchase installment error:", error);
      res.status(500).json({ ok: false, message: error?.message || "Payment failed" });
    }
  }
);

router.delete(
  "/:purchaseId/installments/:installmentId/payment",
  requireAuth,
  requireFamily,
  async (req, res) => {
    try {
      const installment = await SharedPurchaseInstallment.findOne({
        _id: req.params.installmentId,
        purchaseId: req.params.purchaseId,
        familyId: req.familyId,
      });
      if (!installment) {
        return res.status(404).json({ ok: false, message: "Installment not found" });
      }
      if (!installment.paymentRequired || installment.status !== "paid") {
        return res.status(400).json({ ok: false, message: "No recorded payment to undo" });
      }

      if (installment.paymentTransactionId) {
        await Transaction.deleteOne({
          _id: installment.paymentTransactionId,
          familyId: req.familyId,
        });
      }

      installment.status = "pending";
      installment.paymentTransactionId = null;
      installment.fromAccountId = null;
      installment.toAccountId = null;
      installment.paidAt = null;
      await installment.save();

      await refreshPurchaseStatus(req.params.purchaseId, req.familyId);
      res.json({ ok: true });
    } catch (error) {
      console.error("Undo shared purchase payment error:", error);
      res.status(500).json({ ok: false, message: error?.message || "Could not undo payment" });
    }
  }
);

router.delete("/:purchaseId", requireAuth, requireFamily, async (req, res) => {
  try {
    const purchase = await SharedPurchase.findOne({
      _id: req.params.purchaseId,
      familyId: req.familyId,
    });
    if (!purchase) {
      return res.status(404).json({ ok: false, message: "Purchase not found" });
    }

    const installments = await SharedPurchaseInstallment.find({
      familyId: req.familyId,
      purchaseId: purchase._id,
    }).lean();

    const ledgerIds = installments.map((row) => row.ledgerEntryId).filter(Boolean);
    const paymentTransactionIds = installments
      .map((row) => row.paymentTransactionId)
      .filter(Boolean);

    if (ledgerIds.length) {
      await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: { $in: ledgerIds } });
      await LedgerEntry.deleteMany({ familyId: req.familyId, _id: { $in: ledgerIds } });
    }

    const transactionIds = [purchase.upfrontTransactionId, ...paymentTransactionIds].filter(Boolean);
    if (transactionIds.length) {
      await Transaction.deleteMany({ familyId: req.familyId, _id: { $in: transactionIds } });
    }

    await SharedPurchaseInstallment.deleteMany({
      familyId: req.familyId,
      purchaseId: purchase._id,
    });
    await SharedPurchase.deleteOne({ _id: purchase._id, familyId: req.familyId });

    res.json({ ok: true });
  } catch (error) {
    console.error("Delete shared purchase error:", error);
    res.status(500).json({ ok: false, message: error?.message || "Delete failed" });
  }
});

export default router;
