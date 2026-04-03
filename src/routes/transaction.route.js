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

async function resolveFinancialType({ familyId, txType, categoryId }) {
  if (txType === "income") return "income";

  let financialType = "living";
  if (txType === "expense" && categoryId) {
    const cat = await Category.findOne({ _id: categoryId, familyId }).select(
      "financialType kind name"
    );
    if (cat) {
      financialType = cat.financialType || (cat.kind === "income" ? "income" : "living");
    }
  }
  return financialType;
}

async function syncTransactionLedger({ req, tx, payload }) {
  const { txType, date, categoryId, amount, note, paidByUserId, receivedByUserId } = payload;
  const mk = monthKey(date);
  const amt = Number(amount || 0);

  const ledgerEntries = await LedgerEntry.find({
    familyId: req.familyId,
    sourceId: tx._id,
  }).sort({ createdAt: 1, _id: 1 });

  if (txType === "transfer") {
    for (const le of ledgerEntries) {
      await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: le._id });
      await LedgerEntry.deleteOne({ _id: le._id, familyId: req.familyId });
    }
    return;
  }

  const financialType = await resolveFinancialType({
    familyId: req.familyId,
    txType,
    categoryId,
  });

  let le = ledgerEntries[0];
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
      sourceId: tx._id,
    });
  } else {
    le.entryType = txType;
    le.financialType = financialType;
    le.module = le.module || "manual";
    le.date = new Date(date);
    le.month = mk;
    le.categoryId = categoryId || null;
    le.amountTotal = amt;
    le.paidByUserId = txType === "expense" ? paidByUserId || null : null;
    le.receivedByUserId = txType === "income" ? receivedByUserId || null : null;
    le.note = (note || "").trim();
    le.sourceType = "transaction";
    le.sourceId = tx._id;
    await le.save();
  }

  if (ledgerEntries.length > 1) {
    for (const extra of ledgerEntries.slice(1)) {
      await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: extra._id });
      await LedgerEntry.deleteOne({ _id: extra._id, familyId: req.familyId });
    }
  }

  await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: le._id });
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

function validateTransactionInput(body = {}) {
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
  } = body;

  if (!txType || !["income", "expense", "transfer"].includes(txType)) {
    return { ok: false, message: "Invalid txType" };
  }

  const mk = monthKey(date);
  if (!mk) return { ok: false, message: "Invalid date" };

  const amt = Number(amount);
  if (!amt || amt <= 0) {
    return { ok: false, message: "Amount must be > 0" };
  }

  if (txType === "income") {
    if (!categoryId) return { ok: false, message: "Category required for income" };
    if (!toAccountId) return { ok: false, message: "To account required for income" };
    if (!receivedByUserId) return { ok: false, message: "Received By required for income" };
  }

  if (txType === "expense") {
    if (!categoryId) return { ok: false, message: "Category required for expense" };
    if (!fromAccountId) return { ok: false, message: "From account required for expense" };
    if (!paidByUserId) return { ok: false, message: "Paid By required for expense" };
  }

  if (txType === "transfer") {
    if (!fromAccountId || !toAccountId) {
      return { ok: false, message: "From & To accounts required" };
    }
    if (String(fromAccountId) === String(toAccountId)) {
      return { ok: false, message: "From and To accounts must be different" };
    }
  }

  return {
    ok: true,
    payload: {
      txType,
      date,
      month: mk,
      categoryId: txType === "transfer" ? null : categoryId,
      amount: amt,
      note: (note || "").trim(),
      fromAccountId: txType === "income" ? null : fromAccountId || null,
      toAccountId: txType === "expense" ? null : toAccountId || null,
      paidByUserId: txType === "expense" ? paidByUserId || null : null,
      receivedByUserId: txType === "income" ? receivedByUserId || null : null,
    },
  };
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
    const check = validateTransactionInput(req.body || {});
    if (!check.ok) return res.status(400).json({ ok: false, message: check.message });

    const payload = check.payload;

    const item = await Transaction.create({
      familyId: req.familyId,
      txType: payload.txType,
      date: new Date(payload.date),
      month: payload.month,
      categoryId: payload.categoryId,
      amount: payload.amount,
      note: payload.note,
      fromAccountId: payload.fromAccountId,
      toAccountId: payload.toAccountId,
      paidByUserId: payload.paidByUserId,
      receivedByUserId: payload.receivedByUserId,
      createdByUserId: req.user.userId,
    });

    await syncTransactionLedger({ req, tx: item, payload });

    res.status(201).json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Create failed" });
  }
});

// Update
router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await Transaction.findOne({ _id: id, familyId: req.familyId });
    if (!existing) return res.status(404).json({ ok: false, message: "Not found" });

    const check = validateTransactionInput(req.body || {});
    if (!check.ok) return res.status(400).json({ ok: false, message: check.message });

    const payload = check.payload;

    existing.txType = payload.txType;
    existing.date = new Date(payload.date);
    existing.month = payload.month;
    existing.categoryId = payload.categoryId;
    existing.amount = payload.amount;
    existing.note = payload.note;
    existing.fromAccountId = payload.fromAccountId;
    existing.toAccountId = payload.toAccountId;
    existing.paidByUserId = payload.paidByUserId;
    existing.receivedByUserId = payload.receivedByUserId;
    await existing.save();

    await syncTransactionLedger({ req, tx: existing, payload });

    res.json({ ok: true, item: existing });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Update failed" });
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
    sourceId: tx._id,
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
