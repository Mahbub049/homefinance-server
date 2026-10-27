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
import { verifyExpensePosting, requireOpenMonth } from '../utils/postingPreflight.js';
import { nonnegativeMoney, positiveMoney, postingError } from '../utils/postingRules.js';
import { runAtomicPosting } from '../utils/financialPostingTransaction.js';
import { existingFinancialPosting, createIdempotentFinancialPosting } from '../utils/idempotentFinancialPosting.js';

const router = Router();

function toMonthString(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function cleanOptionalObjectId(value) {
  return value ? value : null;
}

async function prepareGroceryPayload(req) {
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
    const err = new Error("Missing required fields");
    err.status = 400;
    throw err;
  }

  const dateObj = new Date(txnDate);
  if (Number.isNaN(dateObj.getTime())) {
    const err = new Error("Invalid transaction date");
    err.status = 400;
    throw err;
  }

  const members = await FamilyMember.find({ familyId: req.familyId });
  const userIds = members.map((m) => String(m.userId));

  if (!userIds.includes(String(paidByUserId))) {
    const err = new Error("Invalid paidBy");
    err.status = 400;
    throw err;
  }

  let itemsSubtotal = 0;

  const preparedItems = items.map((it) => {
    const name = String(it.name || "").trim();
    if (!name) {
      const err = new Error("Every item must have a name");
      err.status = 400;
      throw err;
    }

    const qty = Number(it.qty || 0);
    const unitPrice = Number(it.unitPrice || 0);
    const itemDiscount = nonnegativeMoney(it.itemDiscount, 'Item discount');

    if (!Number.isFinite(qty) || qty <= 0) {
      const err = new Error("Invalid item quantity");
      err.status = 400;
      throw err;
    }

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      const err = new Error("Invalid item unit price");
      err.status = 400;
      throw err;
    }

    if (!Number.isFinite(itemDiscount) || itemDiscount < 0) {
      const err = new Error("Invalid item discount");
      err.status = 400;
      throw err;
    }

    const productStartDate = it.productStartDate ? new Date(it.productStartDate) : null;
    const productEndDate = it.productEndDate ? new Date(it.productEndDate) : null;

    const lineTotal = round2(qty * unitPrice - itemDiscount);
    if (lineTotal < 0) {
      const err = new Error("Item discount cannot be greater than item total");
      err.status = 400;
      throw err;
    }

    itemsSubtotal += lineTotal;

    return {
      name,
      brand: String(it.brand || "").trim(),
      unit: String(it.unit || "").trim(),
      qty,
      unitPrice,
      productStartDate: productStartDate && !Number.isNaN(productStartDate.getTime()) ? productStartDate : null,
      productEndDate: productEndDate && !Number.isNaN(productEndDate.getTime()) ? productEndDate : null,
      itemDiscount,
      lineTotal,
      note: String(it.note || "").trim(),
    };
  });

  itemsSubtotal = round2(itemsSubtotal);

  const orderDiscount = nonnegativeMoney(discountTotal, 'Order discount');
  const delivery = nonnegativeMoney(deliveryFee, 'Delivery fee');
  const vat = nonnegativeMoney(vatAmount, 'VAT');
  if (orderDiscount > itemsSubtotal) throw postingError('Order discount cannot exceed the item subtotal');
  let totalPayable = round2(itemsSubtotal - orderDiscount + delivery + (vatIncluded ? 0 : vat));
  positiveMoney(totalPayable, 'Grocery total');

  if (totalPayable <= 0) {
    const err = new Error("Total payable must be > 0");
    err.status = 400;
    throw err;
  }

  let splitRows = [];
  if (split.type === "equal") splitRows = splitEqual(totalPayable, userIds);
  if (split.type === "personal") splitRows = splitPersonal(totalPayable, split.personalUserId);
  if (split.type === "ratio") splitRows = splitRatio(totalPayable, split.ratios || []);
  if (split.type === "fixed") splitRows = splitFixed(totalPayable, split.fixed || []);

  if (!Array.isArray(splitRows) || splitRows.length === 0) {
    const err = new Error("Invalid split data");
    err.status = 400;
    throw err;
  }

  const invalidSplitUser = splitRows.find((r) => !userIds.includes(String(r.userId)));
  if (invalidSplitUser) {
    const err = new Error("Invalid split member");
    err.status = 400;
    throw err;
  }

  const splitSnapshot = { type: split.type };
  if (split.type === "personal") {
    splitSnapshot.personalUserId = split.personalUserId || null;
  }
  if (split.type === "ratio") {
    splitSnapshot.ratios = (split.ratios || []).map((r) => ({
      userId: r.userId,
      ratio: Number(r.ratio || 0),
    }));
  }
  if (split.type === "fixed") {
    splitSnapshot.fixed = (split.fixed || []).map((f) => ({
      userId: f.userId,
      amount: round2(f.amount || 0),
    }));
  }

  const month = toMonthString(dateObj);
  await verifyExpensePosting({ familyId: req.familyId, date: dateObj, paidByUserId,
    fromAccountId, categoryId, amount: totalPayable });
  const groceryNote = `Grocery: ${shopName || "Transaction"}`;

  return {
    dateObj,
    month,
    groceryNote,
    splitRows,
    preparedItems,
    groceryFields: {
      familyId: req.familyId,
      txnDate: dateObj,
      month,
      shopName: String(shopName || "").trim(),
      location: String(location || "").trim(),
      paymentMethodId: cleanOptionalObjectId(paymentMethodId),
      cardLabelId: cleanOptionalObjectId(cardLabelId),
      categoryId,
      paidByUserId,
      fromAccountId,
      discountTotal: Number(discountTotal || 0),
      deliveryFee: Number(deliveryFee || 0),
      vatAmount: Number(vatAmount || 0),
      vatIncluded: !!vatIncluded,
      itemsSubtotal,
      totalPayable,
      note: String(note || "").trim(),
      splitSnapshot,
      createdByUserId: req.user.userId,
    },
    transactionFields: {
      familyId: req.familyId,
      txType: "expense",
      date: dateObj,
      month,
      categoryId,
      amount: totalPayable,
      note: groceryNote,
      fromAccountId,
      toAccountId: null,
      paidByUserId,
      receivedByUserId: null,
      createdByUserId: req.user.userId,
    },
    ledgerFields: {
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
      note: groceryNote,
      createdByUserId: req.user.userId,
    },
  };
}

async function replaceSplits({ familyId, ledgerEntryId, splitRows }) {
  await Split.deleteMany({ familyId, ledgerEntryId });
  await Split.insertMany(
    splitRows.map((r) => ({
      familyId,
      ledgerEntryId,
      userId: r.userId,
      shareAmount: r.shareAmount,
    }))
  );
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
    items: txns.map((t) => {
      const obj = t.toObject();
      return {
        ...obj,
        split: obj.splitSnapshot || { type: "equal" },
        items: itemMap[String(t._id)] || [],
      };
    }),
  });
});

// POST /api/grocery
router.post("/", requireAuth, requireFamily, async (req, res) => {
  try {
    // Check before preflight: a safe retry must succeed even if this month
    // was closed after the original request committed.
    const replay = await existingFinancialPosting(req, 'grocery.create');
    if (replay) return res.json({ ok: true, txnId: replay.resultId, replayed: true });
    const data = await prepareGroceryPayload(req);

    const result = await createIdempotentFinancialPosting(req, 'grocery.create', async () => {
          const groceryTxnId = new mongoose.Types.ObjectId();

          const tx = await Transaction.create(data.transactionFields);

          const entry = await LedgerEntry.create({
            ...data.ledgerFields,
            sourceType: "transaction",
            sourceId: tx._id,
          });

          await replaceSplits({
            familyId: req.familyId,
            ledgerEntryId: entry._id,
            splitRows: data.splitRows,
          });

          const txn = await GroceryTransaction.create({
            _id: groceryTxnId,
            ...data.groceryFields,
            transactionId: tx._id,
            ledgerEntryId: entry._id,
          });

          await GroceryItem.insertMany(
            data.preparedItems.map((it) => ({
              familyId: req.familyId,
              txnId: txn._id,
              ...it,
            }))
          );

          return txn._id;
    });
    res.json({ ok: true, txnId: result.resultId, replayed: result.replayed });
  } catch (e) {
    res.status(e?.status || 500).json({ ok: false, message: e?.message || "Save failed" });
  }
});

// PUT /api/grocery/:id
// Updates grocery transaction AND keeps Transaction + LedgerEntry + Split rows synced automatically.
router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    // Preflight uses parallel independent reads. Run it before the MongoDB
    // transaction; parallel operations within one transaction aren't supported.
    const data = await prepareGroceryPayload(req);
    const txnId = await runAtomicPosting(async () => {
          const txn = await GroceryTransaction.findOne({ _id: req.params.id, familyId: req.familyId });
          if (!txn) throw postingError("Grocery entry not found", 404);
          await requireOpenMonth(req.familyId, txn.month);
          if (txn.transactionId) {
            const original = await Transaction.findOne({ _id: txn.transactionId, familyId: req.familyId }).select('month').lean();
            if (original?.month && original.month !== txn.month) await requireOpenMonth(req.familyId, original.month);
          }
          // Recheck the target month inside the transaction in addition to preflight.
          await requireOpenMonth(req.familyId, data.month);

          let tx = null;
          if (txn.transactionId) {
            tx = await Transaction.findOne({ _id: txn.transactionId, familyId: req.familyId });
          }

          if (tx) {
            await Transaction.updateOne(
              { _id: tx._id, familyId: req.familyId },
              { $set: data.transactionFields }
            );
          } else {
            tx = await Transaction.create(data.transactionFields);
          }

          let entry = null;
          if (txn.ledgerEntryId) {
            entry = await LedgerEntry.findOne({ _id: txn.ledgerEntryId, familyId: req.familyId });
          }

          if (entry && txn.transactionId && String(entry.sourceId) !== String(txn.transactionId)) {
            throw postingError("Grocery ledger linkage is inconsistent; review before editing", 409);
          }
          if (entry) {
            await LedgerEntry.updateOne(
              { _id: entry._id, familyId: req.familyId },
              {
                $set: {
                  ...data.ledgerFields,
                  sourceType: "transaction",
                  sourceId: tx._id,
                },
              }
            );
          } else {
            entry = await LedgerEntry.create({
              ...data.ledgerFields,
              sourceType: "transaction",
              sourceId: tx._id,
            });
          }

          await replaceSplits({
            familyId: req.familyId,
            ledgerEntryId: entry._id,
            splitRows: data.splitRows,
          });

          await GroceryTransaction.updateOne(
            { _id: txn._id, familyId: req.familyId },
            {
              $set: {
                ...data.groceryFields,
                transactionId: tx._id,
                ledgerEntryId: entry._id,
              },
            }
          );

          await GroceryItem.deleteMany({ familyId: req.familyId, txnId: txn._id });
          await GroceryItem.insertMany(
            data.preparedItems.map((it) => ({
              familyId: req.familyId,
              txnId: txn._id,
              ...it,
            }))
          );

          return txn._id;
    });
    res.json({ ok: true, txnId });
  } catch (e) {
    // Duplicate source unique index can happen only if old duplicate ledger rows exist.
    // Run /api/ledger/normalize for that month if you see duplicate key error.
    res.status(e?.status || 500).json({ ok: false, message: e?.message || "Update failed" });
  }
});

// DELETE /api/grocery/:id
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    await runAtomicPosting(async () => {
      const txn = await GroceryTransaction.findOne({ _id: req.params.id, familyId: req.familyId });
      if (!txn) throw postingError("Grocery entry not found", 404);
      await requireOpenMonth(req.familyId, txn.month);
      const linked = txn.transactionId
        ? await Transaction.findOne({ _id: txn.transactionId, familyId: req.familyId })
        : null;
      if (linked?.month) await requireOpenMonth(req.familyId, linked.month);

      // Delete all and only the linked records. A failed deletion rolls everything back.
      if (txn.ledgerEntryId && !txn.transactionId) {
        throw postingError("Grocery has a Ledger entry but no linked cash transaction; inspect before deleting", 409);
      }
      if (txn.transactionId && !linked) {
        throw postingError("Grocery references a missing cash transaction; inspect before deleting", 409);
      }
      await GroceryItem.deleteMany({ familyId: req.familyId, txnId: txn._id });
      if (txn.ledgerEntryId) {
        const entry = await LedgerEntry.findOne({ _id: txn.ledgerEntryId, familyId: req.familyId });
        if (entry && (!txn.transactionId || String(entry.sourceId) !== String(txn.transactionId))) {
          throw postingError("Grocery ledger linkage is inconsistent; resolve before deletion", 409);
        }
        if (entry) {
          await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: entry._id });
          await LedgerEntry.deleteOne({ _id: entry._id, familyId: req.familyId });
        }
      }
      if (linked) await Transaction.deleteOne({ _id: linked._id, familyId: req.familyId });
      await GroceryTransaction.deleteOne({ _id: txn._id, familyId: req.familyId });
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message || "Grocery delete failed" });
  }
});

export default router;
