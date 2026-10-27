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
import { splitEqual, splitPersonal, splitRatio, splitFixed } from "../utils/splitCalc.js";
import { loadSharedBudgetMonth } from "../utils/sharedBudgetReadModel.js";
import { sourceOwnerOfLedger } from "../utils/managedFinancialRecords.js";
import { reconcileLedgerMembers } from "../utils/ledgerReconciliation.js";
import { runAtomicPosting } from "../utils/financialPostingTransaction.js";
import { requireOpenMonth } from "../utils/postingPreflight.js";

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

  const postedItems = entries.map((e) => ({
    ...e.toObject(),
    splits: splitMap.get(String(e._id)) || [],
  }));
  const budgetView = await loadSharedBudgetMonth(req.familyId, month, postedItems);
  // Virtual schedule rows are clearly tagged. They are NOT transactions and
  // never create a second bank debit or a second settlement obligation.
  // A read-only reconciliation of funding versus cost responsibility.
  // Virtual scheduled purchase allocations are excluded from ordinary settlement.
  const [members, transactionRows] = await Promise.all([
    FamilyMember.find({ familyId: req.familyId }).populate('userId', 'name').lean(),
    Transaction.find({ familyId: req.familyId, month, txType: 'expense' }).lean(),
  ]);
  const memberReconciliation = reconcileLedgerMembers({
    members: members.map(m => ({ userId: m.userId?._id || m.userId, name: m.userId?.name || 'Member' })),
    entries: budgetView.regularEntries,
    transactions: transactionRows,
  });
  res.json({ ok: true, items: budgetView.entries, budgetAllocation: budgetView.summary, memberReconciliation });
});

/**
 * POST /api/ledger
 * Create ledger entry + splits manually (if you have an admin UI for split editing later)
 */
router.post("/", requireAuth, requireFamily, async (_req, res) => {
  return res.status(409).json({ ok: false,
    message: 'Use Add Transaction in Ledger so both bank/cash funding and expense responsibility are recorded together. Direct Ledger-only financial postings are disabled.' });
});

/**
 * DELETE /api/ledger/:id
 */
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const entry = await LedgerEntry.findOne({ _id: req.params.id, familyId: req.familyId });
    if (!entry) return res.status(404).json({ ok: false, message: 'Not found' });
    const linkedTx = entry.sourceId
      ? await Transaction.findOne({ _id: entry.sourceId, familyId: req.familyId }) : null;
    const managedBy = await sourceOwnerOfLedger(req.familyId, entry, linkedTx);
    if (managedBy) return res.status(409).json({ ok: false,
      message: `This entry belongs to ${managedBy}. Delete or reverse it from its original section.` });
    if (String(entry.month) < '2026-10' || (linkedTx && String(linkedTx.month) < '2026-10')) {
      return res.status(409).json({ ok: false, message: 'Historical months before October 2026 are preserved.' });
    }
    await runAtomicPosting(async () => {
      await requireOpenMonth(req.familyId, entry.month);
      if (linkedTx) await requireOpenMonth(req.familyId, linkedTx.month);
      // Delete ALL linked Ledger rows, not just the clicked row.
      const entries = linkedTx ? await LedgerEntry.find({ familyId: req.familyId, sourceId: linkedTx._id }) : [entry];
      for (const e of entries) {
        await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: e._id });
        await LedgerEntry.deleteOne({ familyId: req.familyId, _id: e._id });
      }
      if (linkedTx) await Transaction.deleteOne({ familyId: req.familyId, _id: linkedTx._id });
    });
    return res.json({ ok: true });
  } catch (e) { return res.status(e.status || 500).json({ ok: false, message: e.message || 'Delete failed' }); }
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
    if (month < '2026-10') return res.status(409).json({ ok: false, message: 'Historical months are preserved.' });
    if (req.body?.confirm !== 'REPAIR_CURRENT_MONTH') return res.status(409).json({ ok: false, message: 'Maintenance requires explicit confirmation. Review source entries before rebuilding.' });
    await requireOpenMonth(req.familyId, month);

    const familyId = req.familyId;
    const createdByUserId = req.user.userId;

    const members = await FamilyMember.find({ familyId });
    const memberUserIds = members.map((m) => String(m.userId));

    let createdFromTransactions = 0;
    let recreatedGroceryLedgerLinks = 0;

    // 1) Income/Expense Transactions → ensure LedgerEntry + personal split exists
    const txs = await Transaction.find({
      familyId,
      month,
      txType: { $in: ["income", "expense"] },
      ledgerEligible: { $ne: false },
    }).lean();
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
        // ✅ expense → rebuild using the transaction split config when available.
        // Fallback remains Personal by paidByUserId for older manual expenses.
        const amt = Number(t.amount || 0);
        const txSplit = t.split || {};
        let splitRows = [];

        try {
          if (txSplit.type === "equal") {
            splitRows = splitEqual(amt, memberUserIds);
          } else if (txSplit.type === "ratio" && Array.isArray(txSplit.ratios) && txSplit.ratios.length) {
            splitRows = splitRatio(
              amt,
              txSplit.ratios.map((r) => ({
                userId: r.userId,
                ratio: Number(r.ratio || 0),
              }))
            );
          } else if (txSplit.type === "fixed" && Array.isArray(txSplit.fixed) && txSplit.fixed.length) {
            splitRows = splitFixed(
              amt,
              txSplit.fixed.map((f) => ({
                userId: f.userId,
                amount: Number(f.amount || 0),
              }))
            );
          } else {
            const personalUserId = txSplit.personalUserId || t.paidByUserId;
            if (personalUserId && memberUserIds.includes(String(personalUserId))) {
              splitRows = splitPersonal(amt, personalUserId);
            }
          }
        } catch {
          splitRows = [];
        }

        if (!splitRows.length && t.paidByUserId && memberUserIds.includes(String(t.paidByUserId))) {
          splitRows = splitPersonal(amt, t.paidByUserId);
        }

        if (!splitRows.length) {
          splitRows = splitEqual(amt, memberUserIds);
        }

        await Split.insertMany(
          splitRows.map((row) => ({
            familyId,
            ledgerEntryId: entry._id,
            userId: row.userId,
            shareAmount: Number(row.shareAmount || 0),
          }))
        );
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
    if (month < '2026-10') return res.status(409).json({ ok: false, message: 'Historical months are preserved.' });
    if (req.body?.confirm !== 'REPAIR_CURRENT_MONTH') return res.status(409).json({ ok: false, message: 'Maintenance requires explicit confirmation. Review source entries before rebuilding.' });
    await requireOpenMonth(req.familyId, month);

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