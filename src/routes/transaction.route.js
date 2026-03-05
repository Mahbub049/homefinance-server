import mongoose from "mongoose";
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Transaction from "../models/Transaction.js";
import Category from "../models/Category.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";

function monthKey(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

const router = Router();

// List by month (optional filter by txType)
router.get("/", requireAuth, requireFamily, async (req, res) => {
  const { month, txType } = req.query;
  if (!month) return res.status(400).json({ ok: false, message: "month is required" });

  const filter = { familyId: req.familyId, month };
  if (txType && ["income", "expense", "transfer"].includes(txType)) {
    filter.txType = txType;
  }

  const items = await Transaction.find(filter)
    .sort({ date: -1, createdAt: -1 })
    .populate("categoryId")
    .populate("fromAccountId")
    .populate("toAccountId")
    .populate("paidByUserId")
    .populate("receivedByUserId");

  res.json({ ok: true, items });
});

// Summary totals by type
router.get("/summary", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ ok: false, message: "month is required" });

  const rows = await Transaction.aggregate([
    { $match: { familyId: new mongoose.Types.ObjectId(req.familyId), month } },
    { $group: { _id: "$txType", total: { $sum: "$amount" } } },
  ]);

  const out = { income: 0, expense: 0, transfer: 0 };
  for (const r of rows) {
    if (r._id === "income") out.income = r.total;
    if (r._id === "expense") out.expense = r.total;
    if (r._id === "transfer") out.transfer = r.total;
  }
  out.netCashflow = out.income - out.expense;

  res.json({ ok: true, totals: out });
});

// Create
router.post("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const {
      txType,
      date,
      categoryId,
      amount,
      note,
      fromAccountId,
      toAccountId,
      paidByUserId,
      receivedByUserId,
    } = req.body || {};

    if (!txType || !["income", "expense", "transfer"].includes(txType)) {
      return res.status(400).json({ ok: false, message: "Invalid txType" });
    }

    const mk = monthKey(date);
    if (!mk) return res.status(400).json({ ok: false, message: "Invalid date" });

    const amt = Number(amount);
    if (!amt || amt <= 0) {
      return res.status(400).json({ ok: false, message: "Amount must be > 0" });
    }

    // Validation per type
    if (txType === "income") {
      if (!categoryId) return res.status(400).json({ ok: false, message: "Category required for income" });
      if (!toAccountId) return res.status(400).json({ ok: false, message: "To account required for income" });
      if (!receivedByUserId)
        return res.status(400).json({ ok: false, message: "Received By required for income" });
    }

    if (txType === "expense") {
      if (!categoryId) return res.status(400).json({ ok: false, message: "Category required for expense" });
      if (!fromAccountId) return res.status(400).json({ ok: false, message: "From account required for expense" });
      if (!paidByUserId) return res.status(400).json({ ok: false, message: "Paid By required for expense" });
    }

    if (txType === "transfer") {
      if (!fromAccountId || !toAccountId)
        return res.status(400).json({ ok: false, message: "From & To accounts required" });
      if (String(fromAccountId) === String(toAccountId))
        return res.status(400).json({ ok: false, message: "From and To accounts must be different" });
    }

    const item = await Transaction.create({
      familyId: req.familyId,
      txType,
      date: new Date(date),
      month: mk,
      categoryId: txType === "transfer" ? null : categoryId,
      amount: amt,
      note: (note || "").trim(),
      fromAccountId: txType === "income" ? null : fromAccountId || null,
      toAccountId: txType === "expense" ? null : toAccountId || null,
      paidByUserId: txType === "expense" ? paidByUserId || null : null,
      receivedByUserId: txType === "income" ? receivedByUserId || null : null,
      createdByUserId: req.user.userId,
    });

    // ✅ IMPORTANT: keep per-member split engine working
    // Any income/expense created through Transactions should also create a LedgerEntry + personal split (100%).
    if (txType === "income" || txType === "expense") {
      let financialType = txType === "income" ? "income" : "living";

      if (txType === "expense" && categoryId) {
        const cat = await Category.findOne({ _id: categoryId, familyId: req.familyId }).select(
          "financialType kind name"
        );
        if (cat) {
          financialType = cat.financialType || (cat.kind === "income" ? "income" : "living");
        }
      }

      let le = await LedgerEntry.findOne({
        familyId: req.familyId,
        sourceType: "transaction",
        sourceId: item._id,
      }).select("_id");

      if (!le) {
        le = await LedgerEntry.create({
          familyId: req.familyId,
          entryType: txType,
          financialType,
          module: "manual",

          date: new Date(date),
          month: mk,
          categoryId,
          amountTotal: amt,

          paidByUserId: txType === "expense" ? paidByUserId || null : null,
          receivedByUserId: txType === "income" ? receivedByUserId || null : null,

          note: (note || "").trim(),
          createdByUserId: req.user.userId,

          sourceType: "transaction",
          sourceId: item._id,
        });

        const splitUserId = txType === "income" ? receivedByUserId : paidByUserId;
        if (splitUserId) {
          await Split.create({
            familyId: req.familyId,
            ledgerEntryId: le._id,
            userId: splitUserId,
            shareAmount: amt,
          });
        }
      }
    }

    res.status(201).json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Create failed" });
  }
});

// Delete
// Delete (SYNC SAFE)
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  const { id } = req.params;

  // 1) find transaction first
  const tx = await Transaction.findOne({ _id: id, familyId: req.familyId }).select("_id");
  if (!tx) return res.status(404).json({ ok: false, message: "Not found" });

  // 2) delete ALL ledger entries that point to this tx (even if sourceType is empty/wrong)
  const ledgerEntries = await LedgerEntry.find({
    familyId: req.familyId,
    sourceId: tx._id,           // ✅ key change: no sourceType filter
  }).select("_id");

  for (const le of ledgerEntries) {
    await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: le._id });
    await LedgerEntry.deleteOne({ _id: le._id, familyId: req.familyId });
  }

  // 3) now delete the transaction
  await Transaction.deleteOne({ _id: tx._id, familyId: req.familyId });

  res.json({ ok: true, removedLedgerEntries: ledgerEntries.length });
});

export default router;