import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Category from "../models/Category.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Transaction from "../models/Transaction.js";
import GroceryTransaction from "../models/GroceryTransaction.js";
import FixedInstance from "../models/FixedInstance.js";
import EMIInstallment from "../models/EMIInstallment.js";

const router = Router();

/**
 * GET /api/ledger?month=YYYY-MM
 * Returns ledger entries + splits
 */
router.get("/", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ ok: false, message: "month is required" });

  const entries = await LedgerEntry.find({ familyId: req.familyId, month })
    .sort({ date: -1, createdAt: -1 })
    .populate("categoryId", "name kind financialType")
    .populate("paidByUserId", "name")
    .populate("receivedByUserId", "name");

  const entryIds = entries.map((e) => e._id);

  const splits = await Split.find({ familyId: req.familyId, ledgerEntryId: { $in: entryIds } }).populate(
    "userId",
    "name"
  );

  const splitMap = new Map();
  for (const s of splits) {
    const key = String(s.ledgerEntryId);
    if (!splitMap.has(key)) splitMap.set(key, []);
    splitMap.get(key).push({
      _id: s._id,
      userId: s.userId,
      shareAmount: s.shareAmount,
    });
  }

  const items = entries.map((e) => ({
    ...e.toObject(),
    splits: splitMap.get(String(e._id)) || [],
  }));

  res.json({ ok: true, items });
});

/**
 * POST /api/ledger
 * Create ledger entry + splits manually (if you have an admin UI for split editing later)
 */
router.post("/", requireAuth, requireFamily, async (req, res) => {
  const { entryType, date, categoryId, amountTotal, paidByUserId, receivedByUserId, note, splits } = req.body || {};

  if (!entryType || !["income", "expense"].includes(entryType)) {
    return res.status(400).json({ ok: false, message: "Invalid entryType" });
  }
  if (!date) return res.status(400).json({ ok: false, message: "date required" });
  if (!categoryId) return res.status(400).json({ ok: false, message: "categoryId required" });

  const amt = Number(amountTotal);
  if (!amt || amt <= 0) return res.status(400).json({ ok: false, message: "amountTotal must be > 0" });

  const dt = new Date(date);
  if (Number.isNaN(dt.getTime())) return res.status(400).json({ ok: false, message: "Invalid date" });

  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const month = `${y}-${m}`;

  const cat = await Category.findOne({ _id: categoryId, familyId: req.familyId });
  if (!cat) return res.status(400).json({ ok: false, message: "Invalid categoryId" });

  const manualId = new mongoose.Types.ObjectId();

  const entry = await LedgerEntry.create({
    _id: manualId,
    familyId: req.familyId,
    entryType,
    financialType: cat.financialType || (cat.kind === "income" ? "income" : "living"),
    module: "manual",
    date: dt,
    month,
    categoryId,
    amountTotal: amt,
    paidByUserId: entryType === "expense" ? paidByUserId || null : null,
    receivedByUserId: entryType === "income" ? receivedByUserId || null : null,
    note: (note || "").trim(),
    sourceType: "manual",
    sourceId: manualId,
    createdByUserId: req.user.userId,
  });

  if (Array.isArray(splits) && splits.length > 0) {
    await Split.insertMany(
      splits.map((s) => ({
        familyId: req.familyId,
        ledgerEntryId: entry._id,
        userId: s.userId,
        shareAmount: Number(s.shareAmount || 0),
      }))
    );
  }

  res.json({ ok: true, entryId: entry._id });
});

/**
 * DELETE /api/ledger/:id
 */
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  const entry = await LedgerEntry.findOne({ _id: req.params.id, familyId: req.familyId });
  if (!entry) return res.status(404).json({ ok: false, message: "Not found" });

  // ✅ If this ledger entry was created from a transaction, delete that transaction too
  if (String(entry.sourceType || "") === "transaction" && entry.sourceId) {
    await Transaction.deleteOne({ _id: entry.sourceId, familyId: req.familyId });
  }

  await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: entry._id });
  await LedgerEntry.deleteOne({ _id: entry._id, familyId: req.familyId });

  res.json({ ok: true });
});

/**
 * POST /api/ledger/rebuild
 * Recreate missing LedgerEntry + Split rows from existing Transactions and/or GroceryTransactions.
 * Useful if LedgerEntry collection was cleared.
 */
router.post("/rebuild", requireAuth, requireFamily, async (req, res) => {
  try {
    const { month } = req.body || {};
    if (!month) return res.status(400).json({ ok: false, message: "month is required (YYYY-MM)" });

    const familyId = req.familyId;
    const createdByUserId = req.user.userId;

    const members = await FamilyMember.find({ familyId });
    const memberUserIds = members.map((m) => String(m.userId));

    let createdFromTransactions = 0;
    let recreatedGroceryLedgerLinks = 0;

    // 1) Income/Expense Transactions → ensure LedgerEntry + personal split exists
    const txs = await Transaction.find({ familyId, month, txType: { $in: ["income", "expense"] } }).lean();
    for (const t of txs) {
      // IMPORTANT:
      // Some modules (fixed/grocery) create a Transaction + LedgerEntry.
      // We treat Transaction as the source-of-truth and link LedgerEntry to it.
      // So during rebuild, skip if ANY LedgerEntry already references this Transaction.
      const exists = await LedgerEntry.findOne({
        familyId,
        sourceId: t._id,
        sourceType: { $exists: true, $ne: "" },
      }).select("_id");
      if (exists) continue;

      let financialType = t.txType === "income" ? "income" : "living";
      if (t.txType === "expense" && t.categoryId) {
        const cat = await Category.findOne({ _id: t.categoryId, familyId }).select("financialType kind name");
        if (cat) financialType = cat.financialType || (cat.kind === "income" ? "income" : "living");
      }

      const entry = await LedgerEntry.create({
        familyId,
        entryType: t.txType,
        financialType,
        module: "manual",
        date: t.date,
        month: t.month,
        categoryId: t.categoryId,
        amountTotal: Number(t.amount || 0),
        paidByUserId: t.txType === "expense" ? t.paidByUserId || null : null,
        receivedByUserId: t.txType === "income" ? t.receivedByUserId || null : null,
        note: t.note || "",
        createdByUserId,
        sourceType: "transaction",
        sourceId: t._id,
      });

      if (t.txType === "income") {
        const uid = t.receivedByUserId;
        if (uid && memberUserIds.includes(String(uid))) {
          await Split.create({
            familyId,
            ledgerEntryId: entry._id,
            userId: uid,
            shareAmount: Number(t.amount || 0),
          });
        }
      } else {
        // ✅ expense → split equally among all family members (wallet needs this)
        const amt = Number(t.amount || 0);
        const n = Math.max(memberUserIds.length, 1);
        const per = Math.floor((amt / n) * 100) / 100; // 2-dec floor
        let used = 0;

        for (let i = 0; i < memberUserIds.length; i++) {
          const uid = memberUserIds[i];
          let share = per;
          used += share;

          // give remainder to last member (so sum matches exactly)
          if (i === memberUserIds.length - 1) {
            share = Math.round((amt - (per * (n - 1)) + Number.EPSILON) * 100) / 100;
          }

          await Split.create({
            familyId,
            ledgerEntryId: entry._id,
            userId: uid,
            shareAmount: share,
          });
        }
      }
      createdFromTransactions += 1;
    }

    // 2) GroceryTransactions → restore links safely (DO NOT create duplicates)
    const groceries = await GroceryTransaction.find({ familyId, month }).lean();

    for (const g of groceries) {
      // ✅ Try to find the ledger entry rebuilt from Transaction (correct source)
      let le = null;

      if (g.transactionId) {
        le = await LedgerEntry.findOne({
          familyId,
          sourceType: "transaction",
          sourceId: g.transactionId,
        }).select("_id");
      }

      // ✅ If found, just relink grocery → ledgerEntryId
      if (le?._id) {
        await GroceryTransaction.updateOne(
          { _id: g._id, familyId },
          { $set: { ledgerEntryId: le._id } }
        );
        recreatedGroceryLedgerLinks += 1;
        continue;
      }

      // ✅ If NOT found (rare), create ONE ledger entry linked to transactionId
      const entry = await LedgerEntry.create({
        familyId,
        entryType: "expense",
        financialType: "living",
        module: "grocery",
        date: g.txnDate,
        month: g.month,
        categoryId: g.categoryId,
        amountTotal: Number(g.totalPayable || 0),
        paidByUserId: g.paidByUserId || null,
        receivedByUserId: null,
        note: g.shopName ? `Grocery: ${g.shopName}` : "Grocery: Transaction",
        createdByUserId,
        sourceType: "transaction",
        sourceId: g.transactionId || g._id, // fallback if transactionId missing
      });

      // Personal split fallback only in this rare case
      if (g.paidByUserId && memberUserIds.includes(String(g.paidByUserId))) {
        await Split.create({
          familyId,
          ledgerEntryId: entry._id,
          userId: g.paidByUserId,
          shareAmount: Number(g.totalPayable || 0),
        });
      }

      await GroceryTransaction.updateOne(
        { _id: g._id, familyId },
        { $set: { ledgerEntryId: entry._id } }
      );
      recreatedGroceryLedgerLinks += 1;
    }

    res.json({
      ok: true,
      month,
      createdFromTransactions,
      recreatedGroceryLedgerLinks,
      note: "Rebuild uses PERSONAL split as fallback for groceries (you can re-split later).",
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Rebuild failed" });
  }
});

/**
 * POST /api/ledger/normalize
 * Fixes "wrong totals" caused by duplicate LedgerEntry rows created by /api/ledger/rebuild
 * when modules (Fixed/Grocery) already created their own LedgerEntry.
 *
 * What it does (month-scoped):
 * - For each FixedInstance/GroceryTransaction that has (transactionId + ledgerEntryId):
 *   - forces its LedgerEntry to be linked to the Transaction (sourceType="transaction", sourceId=transactionId)
 *   - deletes any OTHER LedgerEntry that points to the same transactionId (and their Split rows)
 */
router.post("/normalize", requireAuth, requireFamily, async (req, res) => {
  try {
    const { month } = req.body || {};
    if (!month) return res.status(400).json({ ok: false, message: "month is required (YYYY-MM)" });

    const familyId = req.familyId;

    let updatedLinks = 0;
    let removedDuplicates = 0;

    async function normalizeOne({ transactionId, ledgerEntryId }) {
      if (!transactionId || !ledgerEntryId) return;

      // 1) Ensure the primary ledger entry is linked to the Transaction
      const le = await LedgerEntry.findOne({ _id: ledgerEntryId, familyId }).select("_id sourceType sourceId");
      if (!le) return;

      if (String(le.sourceType || "") !== "transaction" || String(le.sourceId || "") !== String(transactionId)) {
        await LedgerEntry.updateOne(
          { _id: le._id, familyId },
          { $set: { sourceType: "transaction", sourceId: transactionId } }
        );
        updatedLinks += 1;
      }

      // 2) Delete any other ledger entries that reference the same Transaction
      const dups = await LedgerEntry.find({
        familyId,
        sourceId: transactionId,
        sourceType: { $exists: true, $ne: "" },
        _id: { $ne: le._id },
      }).select("_id");

      for (const d of dups) {
        await Split.deleteMany({ familyId, ledgerEntryId: d._id });
        await LedgerEntry.deleteOne({ _id: d._id, familyId });
        removedDuplicates += 1;
      }
    }

    const groceries = await GroceryTransaction.find({ familyId, month }).select("transactionId ledgerEntryId").lean();
    for (const g of groceries) {
      await normalizeOne({ transactionId: g.transactionId, ledgerEntryId: g.ledgerEntryId });
    }

    const fixed = await FixedInstance.find({ familyId, month }).select("transactionId ledgerEntryId").lean();
    for (const f of fixed) {
      await normalizeOne({ transactionId: f.transactionId, ledgerEntryId: f.ledgerEntryId });
    }

    const emis = await EMIInstallment.find({ familyId, month })
      .select("transactionId ledgerEntryId")
      .lean();

    for (const e of emis) {
      await normalizeOne({ transactionId: e.transactionId, ledgerEntryId: e.ledgerEntryId });
    }

    res.json({ ok: true, month, updatedLinks, removedDuplicates });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Normalize failed" });
  }
});

export default router;