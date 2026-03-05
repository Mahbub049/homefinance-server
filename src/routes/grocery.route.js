import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import GroceryTransaction from "../models/GroceryTransaction.js";
import GroceryItem from "../models/GroceryItem.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Transaction from "../models/Transaction.js";

import { splitEqual, splitPersonal, splitRatio, splitFixed, round2 } from "../utils/splitCalc.js";

const router = Router();

function toMonthString(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// GET /api/grocery?month=YYYY-MM
router.get("/", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ ok: false, message: "month required" });

  const txns = await GroceryTransaction.find({ familyId: req.familyId, month })
    .populate("categoryId", "name")
    .populate("paidByUserId", "name")
    .populate("paymentMethodId", "name")
    .populate("cardLabelId", "label last4")
    .populate("fromAccountId", "name type owner")
    .sort({ txnDate: -1, createdAt: -1 });

  const txnIds = txns.map((t) => t._id);
  const items = await GroceryItem.find({ familyId: req.familyId, txnId: { $in: txnIds } }).sort({ createdAt: 1 });

  const itemMap = {};
  for (const it of items) {
    const k = String(it.txnId);
    if (!itemMap[k]) itemMap[k] = [];
    itemMap[k].push(it);
  }

  res.json({
    ok: true,
    items: txns.map((t) => ({
      ...t.toObject(),
      items: itemMap[String(t._id)] || [],
    })),
  });
});

// POST /api/grocery
router.post("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const {
      txnDate,
      shopName,
      location,
      paymentMethodId,
      cardLabelId,
      categoryId,
      paidByUserId,
      fromAccountId,
      discountTotal = 0,
      deliveryFee = 0,
      vatAmount = 0,
      vatIncluded = true,
      note = "",
      items = [],
      split,
    } = req.body || {};

    if (
      !txnDate ||
      !categoryId ||
      !paidByUserId ||
      !fromAccountId ||
      !Array.isArray(items) ||
      items.length === 0 ||
      !split?.type
    ) {
      return res.status(400).json({ ok: false, message: "Missing required fields" });
    }

    const members = await FamilyMember.find({ familyId: req.familyId });
    const userIds = members.map((m) => String(m.userId));

    if (!userIds.includes(String(paidByUserId))) {
      return res.status(400).json({ ok: false, message: "Invalid paidBy" });
    }

    // compute item totals
    let itemsSubtotal = 0;
    const preparedItems = items.map((it) => {
      const qty = Number(it.qty || 0);
      const unitPrice = Number(it.unitPrice || 0);
      const itemDiscount = Number(it.itemDiscount || 0);

      const productStartDate = it.productStartDate ? new Date(it.productStartDate) : null;
      const productEndDate = it.productEndDate ? new Date(it.productEndDate) : null;

      const lineTotal = round2(qty * unitPrice - itemDiscount);
      itemsSubtotal += lineTotal;

      return {
        name: (it.name || "").trim(),
        brand: (it.brand || "").trim(),
        unit: (it.unit || "").trim(),
        qty,
        unitPrice,
        productStartDate: productStartDate && !Number.isNaN(productStartDate.getTime()) ? productStartDate : null,
        productEndDate: productEndDate && !Number.isNaN(productEndDate.getTime()) ? productEndDate : null,
        itemDiscount,
        lineTotal,
        note: (it.note || "").trim(),
      };
    });

    itemsSubtotal = round2(itemsSubtotal);

    // total payable
    let totalPayable = itemsSubtotal - Number(discountTotal || 0) + Number(deliveryFee || 0);
    if (!vatIncluded) totalPayable += Number(vatAmount || 0);
    totalPayable = round2(totalPayable);

    if (totalPayable <= 0) return res.status(400).json({ ok: false, message: "Total payable must be > 0" });

    // compute split rows
    let splitRows = [];
    if (split.type === "equal") splitRows = splitEqual(totalPayable, userIds);
    if (split.type === "personal") splitRows = splitPersonal(totalPayable, split.personalUserId);
    if (split.type === "ratio") splitRows = splitRatio(totalPayable, split.ratios);
    if (split.type === "fixed") splitRows = splitFixed(totalPayable, split.fixed);

    if (!Array.isArray(splitRows) || splitRows.length === 0) {
      return res.status(400).json({ ok: false, message: "Invalid split data" });
    }

    const dateObj = new Date(txnDate);
    const month = toMonthString(dateObj);

    // ✅ Grocery transaction id আগে বানাই (Grocery module primary key)
    const groceryTxnId = new mongoose.Types.ObjectId();

    // ✅ Transactions module record (source-of-truth for month totals)
    const tx = await Transaction.create({
      familyId: req.familyId,
      txType: "expense",
      date: dateObj,
      month,
      categoryId,
      amount: totalPayable,
      note: `Grocery: ${shopName || "Transaction"}`,
      fromAccountId,
      toAccountId: null,
      paidByUserId,
      receivedByUserId: null,
      createdByUserId: req.user.userId,
    });

    // ✅ Ledger entry + splits
    // IMPORTANT: Link LedgerEntry to the underlying Transaction.
    // This prevents /api/ledger/rebuild from creating a duplicate LedgerEntry.
    const entry = await LedgerEntry.create({
      familyId: req.familyId,
      entryType: "expense",
      financialType: "living",
      module: "grocery",
      date: dateObj,
      month,
      categoryId,
      amountTotal: totalPayable,
      paidByUserId,
      receivedByUserId: null,
      note: `Grocery: ${shopName || "Transaction"}`,
      sourceType: "transaction",
      sourceId: tx._id,
      createdByUserId: req.user.userId,
    });

    await Split.insertMany(
      splitRows.map((r) => ({
        familyId: req.familyId,
        ledgerEntryId: entry._id,
        userId: r.userId,
        shareAmount: r.shareAmount,
      }))
    );

    // ✅ Grocery module transaction (use the same _id we generated)
    const txn = await GroceryTransaction.create({
      _id: groceryTxnId,
      familyId: req.familyId,
      txnDate: dateObj,
      month,
      shopName: (shopName || "").trim(),
      location: (location || "").trim(),
      paymentMethodId: paymentMethodId || null,
      cardLabelId: cardLabelId || null,
      categoryId,
      paidByUserId,
      fromAccountId,

      transactionId: tx._id,
      ledgerEntryId: entry._id,

      discountTotal: Number(discountTotal || 0),
      deliveryFee: Number(deliveryFee || 0),
      vatAmount: Number(vatAmount || 0),
      vatIncluded: !!vatIncluded,
      itemsSubtotal,
      totalPayable,
      note: (note || "").trim(),
      createdByUserId: req.user.userId,
    });

    await GroceryItem.insertMany(
      preparedItems.map((it) => ({
        familyId: req.familyId,
        txnId: txn._id,
        ...it,
      }))
    );

    res.json({ ok: true, txnId: txn._id });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Save failed" });
  }
});

// DELETE /api/grocery/:id
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  const txn = await GroceryTransaction.findOne({ _id: req.params.id, familyId: req.familyId });
  if (!txn) return res.status(404).json({ ok: false, message: "Not found" });

  await GroceryItem.deleteMany({ familyId: req.familyId, txnId: txn._id });

  if (txn.ledgerEntryId) {
    await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: txn.ledgerEntryId });
    await LedgerEntry.deleteOne({ _id: txn.ledgerEntryId, familyId: req.familyId });
  }

  if (txn.transactionId) {
    await Transaction.deleteOne({ _id: txn.transactionId, familyId: req.familyId });
  }

  await GroceryTransaction.deleteOne({ _id: txn._id });

  res.json({ ok: true });
});

export default router;