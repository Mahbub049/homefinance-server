import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import FixedTemplate from "../models/FixedTemplate.js";
import FixedInstance from "../models/FixedInstance.js";
import Transaction from "../models/Transaction.js";
import Category from "../models/Category.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";

import { splitEqual, splitPersonal, splitRatio, splitFixed } from "../utils/splitCalc.js";
import { assertExpenseSplit, validMonth } from "../utils/postingRules.js";
import { verifyExpensePosting, requireOpenMonth } from "../utils/postingPreflight.js";
import { runAtomicPosting } from "../utils/financialPostingTransaction.js";
import { postingError } from "../utils/postingRules.js";

const router = Router();

function toMonthString(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function normalizeDate(inputDate, month) {
  if (inputDate) {
    const d = new Date(inputDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(`${month}-01`);
}

async function getExpenseFinancialType({ familyId, categoryId }) {
  let financialType = "living";

  try {
    const cat = await Category.findOne({ _id: categoryId, familyId }).select("financialType kind");
    if (cat) {
      financialType = cat.financialType || (cat.kind === "income" ? "income" : "living");
    }
  } catch {
    // keep default
  }

  return financialType;
}

function normalizeId(value) {
  if (!value) return null;
  return value._id || value.id || value;
}

async function buildSplitRows({ familyId, template, amount }) {
  const members = await FamilyMember.find({ familyId });
  const userIds = members.map((m) => String(m.userId));

  let splitRows = [];
  const t = template;

  if (t.defaultSplitType === "equal") splitRows = splitEqual(amount, userIds);

  if (t.defaultSplitType === "personal") {
    if (!t.personalUserId) throw new Error("Template split is Personal but no personalUserId is set");
    splitRows = splitPersonal(amount, t.personalUserId);
  }

  if (t.defaultSplitType === "ratio") {
    splitRows = splitRatio(amount, Array.isArray(t.ratios) ? t.ratios : []);
  }

  if (t.defaultSplitType === "fixed") {
    splitRows = splitFixed(amount, Array.isArray(t.fixed) ? t.fixed : []);
  }

  if (!Array.isArray(splitRows) || splitRows.length === 0) {
    throw new Error("Invalid split config");
  }

  return assertExpenseSplit(splitRows, amount, userIds);
}

async function createLedgerForFixed({
  familyId,
  txId,
  date,
  month,
  categoryId,
  amount,
  paidByUserId,
  note,
  createdByUserId,
  splitRows,
}) {
  const financialType = await getExpenseFinancialType({ familyId, categoryId });

  const entry = await LedgerEntry.create({
    familyId,
    entryType: "expense",
    financialType,
    module: "fixed",
    date,
    month,
    categoryId,
    amountTotal: amount,
    paidByUserId: paidByUserId || null,
    receivedByUserId: null,
    note,
    sourceType: "transaction",
    sourceId: txId,
    createdByUserId,
  });

  await Split.insertMany(
    splitRows.map((r) => ({
      familyId,
      ledgerEntryId: entry._id,
      userId: r.userId,
      shareAmount: r.shareAmount,
    }))
  );

  return entry;
}

async function createPostedInstance({
  familyId,
  template,
  month,
  date,
  amount,
  paidByUserId,
  fromAccountId,
  note,
  createdByUserId,
}) {
  const txId = new mongoose.Types.ObjectId();
  const txMonth = toMonthString(date);

  const splitRows = await buildSplitRows({
    familyId,
    template,
    amount,
  });

  const finalNote = note?.trim() ? `Fixed: ${template.name} — ${note.trim()}` : `Fixed: ${template.name}`;

  const entry = await createLedgerForFixed({
    familyId,
    txId,
    date,
    month: txMonth,
    categoryId: template.categoryId,
    amount,
    paidByUserId,
    note: finalNote,
    createdByUserId,
    splitRows,
  });

  const tx = await Transaction.create({
    _id: txId,
    familyId,
    txType: "expense",
    date,
    month: txMonth,
    categoryId: template.categoryId,
    amount,
    note: finalNote,
    fromAccountId,
    toAccountId: null,
    paidByUserId,
    receivedByUserId: null,
    createdByUserId,
  });

  const inst = await FixedInstance.create({
    familyId,
    templateId: template._id,
    month,
    date,
    amount,
    note: note?.trim() || "",
    paidByUserId,
    fromAccountId,
    ledgerEntryId: entry._id,
    transactionId: tx._id,
    status: "posted",
  });

  return inst;
}

// ---------------- Templates ----------------

router.get("/templates", requireAuth, requireFamily, async (req, res) => {
  const items = await FixedTemplate.find({ familyId: req.familyId, isActive: true })
    .populate("categoryId", "name kind");

  res.json({ ok: true, items });
});

router.post("/templates", requireAuth, requireFamily, async (req, res) => {
  const {
    name,
    categoryId,
    defaultAmount,
    isVariable,
    defaultSplitType,
    personalUserId,
    ratios,
    fixed,
  } = req.body || {};

  if (!name || !categoryId) {
    return res.status(400).json({ ok: false, message: "Missing fields" });
  }

  const variable = !!isVariable;
  const amtNum =
    defaultAmount === "" || defaultAmount === undefined || defaultAmount === null
      ? null
      : Number(defaultAmount);

  if (!variable && (!amtNum || amtNum <= 0)) {
    return res.status(400).json({
      ok: false,
      message: "Default amount must be > 0 (or mark as Variable)",
    });
  }

  const tpl = await FixedTemplate.create({
    familyId: req.familyId,
    name: name.trim(),
    categoryId,
    isVariable: variable,
    defaultAmount: variable ? null : amtNum,
    defaultSplitType: defaultSplitType || "equal",
    personalUserId: personalUserId || null,
    ratios: Array.isArray(ratios) ? ratios : [],
    fixed: Array.isArray(fixed) ? fixed : [],
  });

  res.json({ ok: true, item: tpl });
});

router.put("/templates/:id", requireAuth, requireFamily, async (req, res) => {
  const update = { ...req.body };

  if (update.name) update.name = update.name.trim();
  if (update.isVariable !== undefined) update.isVariable = !!update.isVariable;

  if (update.defaultAmount !== undefined) {
    update.defaultAmount =
      update.defaultAmount === null || update.defaultAmount === ""
        ? null
        : Number(update.defaultAmount);
  }

  if (update.isVariable === true) update.defaultAmount = null;

  delete update.fromAccountId;
  delete update.isSavings;
  delete update.type;

  const item = await FixedTemplate.findOneAndUpdate(
    { _id: req.params.id, familyId: req.familyId },
    update,
    { new: true }
  );

  if (!item) return res.status(404).json({ ok: false, message: "Not found" });

  res.json({ ok: true, item });
});

router.delete("/templates/:id", requireAuth, requireFamily, async (req, res) => {
  const item = await FixedTemplate.findOneAndDelete({
    _id: req.params.id,
    familyId: req.familyId,
  });

  if (!item) return res.status(404).json({ ok: false, message: "Not found" });

  res.json({ ok: true });
});

// -------------- Add one template to month and post it --------------

router.post("/templates/:id/add", requireAuth, requireFamily, async (req, res) => {
  const { month, paidByUserId, fromAccountId, paymentDate, amount, note } = req.body || {};

  if (!validMonth(month)) {
    return res.status(400).json({ ok: false, message: "Valid month required (YYYY-MM)" });
  }

  if (!paidByUserId) {
    return res.status(400).json({ ok: false, message: "paidByUserId required" });
  }

  if (!fromAccountId) {
    return res.status(400).json({ ok: false, message: "fromAccountId required" });
  }

  const template = await FixedTemplate.findOne({
    _id: req.params.id,
    familyId: req.familyId,
  });

  if (!template) {
    return res.status(404).json({ ok: false, message: "Template not found" });
  }

  const exists = await FixedInstance.findOne({
    familyId: req.familyId,
    templateId: template._id,
    month,
    status: { $ne: "deleted" },
  });

  if (exists) {
    return res.status(400).json({
      ok: false,
      message: "This template already exists for the selected month",
    });
  }

  const finalAmount = template.isVariable ? Number(amount) : Number(template.defaultAmount);

  if (!finalAmount || finalAmount <= 0) {
    return res.status(400).json({
      ok: false,
      message: template.isVariable ? "Amount must be > 0" : "Template default amount is invalid",
    });
  }

  const date = normalizeDate(paymentDate, month);
  if (toMonthString(date) !== month) {
    return res.status(400).json({ ok: false, message: "Payment date must be within the selected month" });
  }
  try {
    await requireOpenMonth(req.familyId, month);
    await verifyExpensePosting({ familyId: req.familyId, date, amount: finalAmount,
      paidByUserId, fromAccountId, categoryId: template.categoryId });
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false, message: error.message });
  }

  let inst;
  try {
    inst = await runAtomicPosting(async () => {
      // Recheck inside the same transaction that creates all linked records.
      const duplicate = await FixedInstance.exists({ familyId: req.familyId, templateId: template._id, month });
      if (duplicate) throw postingError("This template already exists for the selected month", 409);
      await requireOpenMonth(req.familyId, month);
      return createPostedInstance({
        familyId: req.familyId, template, month, date, amount: finalAmount,
        paidByUserId, fromAccountId, note: note || "", createdByUserId: req.user.userId,
      });
    });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, message: error.message || "Fixed expense posting failed" });
  }

  const populated = await FixedInstance.findById(inst._id)
    .populate("templateId")
    .populate("transactionId")
    .populate("paidByUserId", "name")
    .populate("fromAccountId", "name type");

  return res.json({ ok: true, item: populated, created: true });
});

// ---------------- Instances ----------------

router.get("/instances", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ ok: false, message: "month required" });

  const items = await FixedInstance.find({
    familyId: req.familyId,
    month,
    status: { $ne: "deleted" },
  })
    .populate("templateId")
    .populate("transactionId")
    .populate("paidByUserId", "name")
    .populate("fromAccountId", "name type");

  res.json({ ok: true, items });
});

// Optional bulk month generation: now only creates pending instances
router.post("/generate", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.body || {};
  if (!validMonth(month)) {
    return res.status(400).json({ ok: false, message: "Valid month required (YYYY-MM)" });
  }
  try { await requireOpenMonth(req.familyId, month); }
  catch (error) { return res.status(error.status || 400).json({ ok: false, message: error.message }); }

  const templates = await FixedTemplate.find({
    familyId: req.familyId,
    isActive: true,
  });

  let createdCount = 0;

  for (const t of templates) {
    const exists = await FixedInstance.findOne({
      familyId: req.familyId,
      templateId: t._id,
      month,
      status: { $ne: "deleted" },
    });

    if (exists) continue;

    await FixedInstance.create({
      familyId: req.familyId,
      templateId: t._id,
      month,
      date: new Date(`${month}-01`),
      amount: null,
      note: "",
      paidByUserId: null,
      fromAccountId: null,
      ledgerEntryId: null,
      transactionId: null,
      status: "pending",
    });

    createdCount++;
  }

  res.json({ ok: true, createdCount });
});

router.post("/instances/:id/post", requireAuth, requireFamily, async (req, res) => {
  const { amount, note, paidByUserId, fromAccountId, paymentDate } = req.body || {};

  const inst = await FixedInstance.findOne({
    _id: req.params.id,
    familyId: req.familyId,
  }).populate("templateId");

  if (!inst) return res.status(404).json({ ok: false, message: "Not found" });

  if (inst.status === "posted" || inst.status === "active") {
    return res.status(400).json({ ok: false, message: "Already posted" });
  }

  const template = inst.templateId;
  if (!template) {
    return res.status(400).json({ ok: false, message: "Template missing" });
  }

  if (!paidByUserId) {
    return res.status(400).json({ ok: false, message: "paidByUserId required" });
  }

  if (!fromAccountId) {
    return res.status(400).json({ ok: false, message: "fromAccountId required" });
  }

  const finalAmount = template.isVariable ? Number(amount) : Number(template.defaultAmount);

  if (!finalAmount || finalAmount <= 0) {
    return res.status(400).json({
      ok: false,
      message: template.isVariable ? "Amount must be > 0" : "Template default amount is invalid",
    });
  }

  const date = paymentDate ? new Date(paymentDate) : inst.date;
  if (!Number.isFinite(date?.getTime?.()) || toMonthString(date) !== inst.month) {
    return res.status(400).json({ ok: false, message: "Payment date must be within the selected instance month" });
  }
  try {
    await requireOpenMonth(req.familyId, inst.month);
    await verifyExpensePosting({ familyId: req.familyId, date, amount: finalAmount,
      paidByUserId, fromAccountId, categoryId: template.categoryId });
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false, message: error.message });
  }

  try {
    await runAtomicPosting(async () => {
      const currentInstance = await FixedInstance.findOne({ _id: inst._id, familyId: req.familyId });
      if (!currentInstance || currentInstance.status !== "pending" || currentInstance.transactionId || currentInstance.ledgerEntryId) {
        throw postingError("This fixed expense is already posted or has linked records; refresh the list", 409);
      }
      const instance = currentInstance;
      await requireOpenMonth(req.familyId, instance.month);
      const txId = new mongoose.Types.ObjectId();
      const txMonth = toMonthString(date);

      const splitRows = await buildSplitRows({
        familyId: req.familyId,
        template,
        amount: finalAmount,
      });

      const finalNote = note?.trim()
        ? `Fixed: ${template.name} — ${note.trim()}`
        : `Fixed: ${template.name}`;

      const entry = await createLedgerForFixed({
        familyId: req.familyId,
        txId,
        date,
        month: txMonth,
        categoryId: template.categoryId,
        amount: finalAmount,
        paidByUserId,
        note: finalNote,
        createdByUserId: req.user.userId,
        splitRows,
      });

      const tx = await Transaction.create({
        _id: txId,
        familyId: req.familyId,
        txType: "expense",
        date,
        month: txMonth,
        categoryId: template.categoryId,
        amount: finalAmount,
        note: finalNote,
        fromAccountId,
        toAccountId: null,
        paidByUserId,
        receivedByUserId: null,
        createdByUserId: req.user.userId,
      });

      instance.amount = finalAmount;
      instance.note = note?.trim() || "";
      instance.date = date;
      instance.paidByUserId = paidByUserId;
      instance.fromAccountId = fromAccountId;
      instance.ledgerEntryId = entry._id;
      instance.transactionId = tx._id;
      instance.status = "posted";
      await instance.save();

    });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, message: error.message || "Fixed expense posting failed" });
  }

  const populated = await FixedInstance.findById(inst._id)
    .populate("templateId")
    .populate("transactionId")
    .populate("paidByUserId", "name")
    .populate("fromAccountId", "name type");

  res.json({ ok: true, item: populated });
});


router.put("/instances/:id", requireAuth, requireFamily, async (req, res) => {
  const { amount, note, paidByUserId, fromAccountId, paymentDate, month: selectedMonth } = req.body || {};

  const inst = await FixedInstance.findOne({
    _id: req.params.id,
    familyId: req.familyId,
  }).populate("templateId");

  if (!inst) return res.status(404).json({ ok: false, message: "Not found" });

  const template = inst.templateId;
  if (!template) {
    return res.status(400).json({ ok: false, message: "Template missing" });
  }

  if (!paidByUserId) {
    return res.status(400).json({ ok: false, message: "paidByUserId required" });
  }

  if (!fromAccountId) {
    return res.status(400).json({ ok: false, message: "fromAccountId required" });
  }

  const date = normalizeDate(paymentDate, selectedMonth || inst.month);
  const txMonth = toMonthString(date);
  if (selectedMonth && selectedMonth !== txMonth) {
    return res.status(400).json({ ok: false, message: "Payment date must be within the selected month" });
  }

  const finalAmount = Number(
    amount !== undefined && amount !== null && amount !== ""
      ? amount
      : inst.amount || template.defaultAmount
  );

  if (!finalAmount || finalAmount <= 0) {
    return res.status(400).json({ ok: false, message: "Amount must be > 0" });
  }

  try {
    await requireOpenMonth(req.familyId, inst.month);
    if (inst.transactionId) {
      const original = await Transaction.findOne({ _id: inst.transactionId, familyId: req.familyId }).select('month').lean();
      if (original?.month && original.month !== inst.month) await requireOpenMonth(req.familyId, original.month);
    }
    await verifyExpensePosting({ familyId: req.familyId, date, amount: finalAmount,
      paidByUserId, fromAccountId, categoryId: template.categoryId });
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false, message: error.message });
  }

  const cleanNote = String(note || "").trim();
  const finalNote = cleanNote ? `Fixed: ${template.name} — ${cleanNote}` : `Fixed: ${template.name}`;

  const splitRows = await buildSplitRows({
    familyId: req.familyId,
    template,
    amount: finalAmount,
  });

  try {
    await runAtomicPosting(async () => {
      const inst = await FixedInstance.findOne({ _id: req.params.id, familyId: req.familyId });
      if (!inst) throw postingError("Fixed expense no longer exists", 409);
      await requireOpenMonth(req.familyId, inst.month);
      const linked = inst.transactionId ? await Transaction.findOne({ _id: inst.transactionId, familyId: req.familyId }) : null;
      if (linked?.month) await requireOpenMonth(req.familyId, linked.month);
      await requireOpenMonth(req.familyId, txMonth);
      let tx = null;

      if (inst.transactionId) {
        tx = await Transaction.findOne({ _id: inst.transactionId, familyId: req.familyId });
      }

      if (!tx) {
        const txId = normalizeId(inst.transactionId) || new mongoose.Types.ObjectId();

        tx = await Transaction.create({
          _id: txId,
          familyId: req.familyId,
          txType: "expense",
          date,
          month: txMonth,
          categoryId: template.categoryId,
          amount: finalAmount,
          note: finalNote,
          fromAccountId,
          toAccountId: null,
          paidByUserId,
          receivedByUserId: null,
          createdByUserId: req.user.userId,
        });

        inst.transactionId = tx._id;
      } else {
        tx.txType = "expense";
        tx.date = date;
        tx.month = txMonth;
        tx.categoryId = template.categoryId;
        tx.amount = finalAmount;
        tx.note = finalNote;
        tx.fromAccountId = fromAccountId;
        tx.toAccountId = null;
        tx.paidByUserId = paidByUserId;
        tx.receivedByUserId = null;
        await tx.save();
      }

      const financialType = await getExpenseFinancialType({
        familyId: req.familyId,
        categoryId: template.categoryId,
      });

      let entry = null;

      if (inst.ledgerEntryId) {
        entry = await LedgerEntry.findOne({ _id: inst.ledgerEntryId, familyId: req.familyId });
      }

      if (!entry && tx?._id) {
        entry = await LedgerEntry.findOne({
          familyId: req.familyId,
          sourceType: "transaction",
          sourceId: tx._id,
        });
      }

      if (entry && (entry.sourceType !== "transaction" || String(entry.sourceId) !== String(tx._id))) {
        throw postingError("Fixed expense ledger linkage is inconsistent; resolve before editing", 409);
      }
      if (!entry) {
        entry = await createLedgerForFixed({
          familyId: req.familyId,
          txId: tx._id,
          date,
          month: txMonth,
          categoryId: template.categoryId,
          amount: finalAmount,
          paidByUserId,
          note: finalNote,
          createdByUserId: req.user.userId,
          splitRows,
        });
      } else {
        entry.entryType = "expense";
        entry.financialType = financialType;
        entry.module = "fixed";
        entry.date = date;
        entry.month = txMonth;
        entry.categoryId = template.categoryId;
        entry.amountTotal = finalAmount;
        entry.paidByUserId = paidByUserId;
        entry.receivedByUserId = null;
        entry.note = finalNote;
        entry.sourceType = "transaction";
        entry.sourceId = tx._id;
        await entry.save();

        await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: entry._id });
        await Split.insertMany(
          splitRows.map((r) => ({
            familyId: req.familyId,
            ledgerEntryId: entry._id,
            userId: r.userId,
            shareAmount: r.shareAmount,
          }))
        );
      }

      inst.amount = finalAmount;
      inst.note = cleanNote;
      inst.date = date;
      inst.month = selectedMonth || inst.month;
      inst.paidByUserId = paidByUserId;
      inst.fromAccountId = fromAccountId;
      inst.ledgerEntryId = entry._id;
      inst.transactionId = tx._id;
      inst.status = "posted";
      await inst.save();

    });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, message: error.message || "Fixed expense update failed" });
  }

  const populated = await FixedInstance.findById(inst._id)
    .populate("templateId")
    .populate("transactionId")
    .populate("paidByUserId", "name")
    .populate("fromAccountId", "name type");

  return res.json({ ok: true, item: populated, updated: true });
});

router.delete("/instances/:id", requireAuth, requireFamily, async (req, res) => {
  const inst = await FixedInstance.findOne({
    _id: req.params.id,
    familyId: req.familyId,
  });

  if (!inst) return res.status(404).json({ ok: false, message: "Not found" });
  try {
    await requireOpenMonth(req.familyId, inst.month);
    if (inst.transactionId) {
      const linked = await Transaction.findOne({ _id: inst.transactionId, familyId: req.familyId }).select('month').lean();
      if (linked?.month && linked.month !== inst.month) await requireOpenMonth(req.familyId, linked.month);
    }
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false, message: error.message });
  }

  try {
    await runAtomicPosting(async () => {
      const existing = await FixedInstance.findOne({ _id: req.params.id, familyId: req.familyId });
      if (!existing) throw postingError("Fixed expense no longer exists",409);
      await requireOpenMonth(req.familyId, existing.month);
      if (existing.ledgerEntryId && !existing.transactionId) {
        throw postingError("Fixed expense Ledger entry has no matching transaction; inspect before deleting", 409);
      }
      if (existing.transactionId) {
        const tx = await Transaction.findOne({ _id: existing.transactionId, familyId: req.familyId });
        if (tx?.month) await requireOpenMonth(req.familyId, tx.month);
        if (!tx) throw postingError("Fixed expense references a missing cash transaction; inspect before deleting", 409);
        const entries = await LedgerEntry.find({ familyId: req.familyId, sourceType: "transaction", sourceId: existing.transactionId });
        if (entries.length > 1) throw postingError("Duplicate ledger entries detected; resolve before deleting",409);
        if (existing.ledgerEntryId && (!entries.length || String(entries[0]._id) !== String(existing.ledgerEntryId))) {
          throw postingError("Fixed expense has inconsistent Ledger linkage; inspect before deleting", 409);
        }
        if (entries.length) {
          await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: entries[0]._id });
          await LedgerEntry.deleteOne({ _id: entries[0]._id, familyId: req.familyId });
        }
        if (tx) await Transaction.deleteOne({ _id: tx._id, familyId: req.familyId });
      }
      await FixedInstance.deleteOne({ _id: existing._id, familyId: req.familyId });
    });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, message: error.message || "Fixed expense delete failed" });
  }

  res.json({ ok: true });
});

export default router;