import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import FixedTemplate from "../models/FixedTemplate.js";
import FixedInstance from "../models/FixedInstance.js";
import Transaction from "../models/Transaction.js";
import Category from "../models/Category.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import mongoose from "mongoose";

import { splitEqual, splitPersonal, splitRatio, splitFixed } from "../utils/splitCalc.js";

const router = Router();

function toMonthString(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function defaultDateForMonth(month) {
  const now = new Date();
  const nowMonth = toMonthString(now);
  if (String(month) === String(nowMonth)) return now;
  return new Date(`${month}-01`);
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
  if (t.defaultSplitType === "ratio") splitRows = splitRatio(amount, Array.isArray(t.ratios) ? t.ratios : []);
  if (t.defaultSplitType === "fixed") splitRows = splitFixed(amount, Array.isArray(t.fixed) ? t.fixed : []);

  if (!Array.isArray(splitRows) || splitRows.length === 0) {
    throw new Error("Invalid split config");
  }

  return splitRows;
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
  let financialType = "living";
  try {
    const cat = await Category.findOne({ _id: categoryId, familyId }).select("financialType kind");
    if (cat) financialType = cat.financialType || (cat.kind === "income" ? "income" : "living");
  } catch {
    // ignore
  }

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

// ------- Templates CRUD -------

router.get("/templates", requireAuth, requireFamily, async (req, res) => {
  const items = await FixedTemplate.find({ familyId: req.familyId })
    .populate("categoryId", "name kind")
    .populate("fromAccountId", "name type");
  res.json({ ok: true, items });
});

router.post("/templates", requireAuth, requireFamily, async (req, res) => {
  const {
    name,
    categoryId,
    fromAccountId,
    defaultAmount,
    isVariable,
    defaultSplitType,
    personalUserId,
    ratios,
    fixed,
  } = req.body || {};

  if (!name || !categoryId || !fromAccountId)
    return res.status(400).json({ ok: false, message: "Missing fields" });

  const variable = !!isVariable;
  const amtNum = defaultAmount === "" || defaultAmount === undefined || defaultAmount === null ? null : Number(defaultAmount);
  if (!variable && (!amtNum || amtNum <= 0)) {
    return res.status(400).json({ ok: false, message: "Default amount must be > 0 (or mark as Variable)" });
  }

  const tpl = await FixedTemplate.create({
    familyId: req.familyId,
    name: name.trim(),
    categoryId,
    fromAccountId,
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
    update.defaultAmount = update.defaultAmount === null || update.defaultAmount === "" ? null : Number(update.defaultAmount);
  }
  if (update.isVariable === true) update.defaultAmount = null;

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
  const item = await FixedTemplate.findOneAndDelete({ _id: req.params.id, familyId: req.familyId });
  if (!item) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({ ok: true });
});

// ✅ NEW: add ONE template to a month
router.post("/templates/:id/add", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.body || {};
  if (!month) return res.status(400).json({ ok: false, message: "month required (YYYY-MM)" });

  const t = await FixedTemplate.findOne({ _id: req.params.id, familyId: req.familyId });
  if (!t) return res.status(404).json({ ok: false, message: "Template not found" });

  // already exists? return ok (no duplicates)
  const exists = await FixedInstance.findOne({ familyId: req.familyId, templateId: t._id, month });
  if (exists) return res.json({ ok: true, item: exists, created: false });

  const date = defaultDateForMonth(month);

  if (!t.fromAccountId) {
    const inst = await FixedInstance.create({
      familyId: req.familyId,
      templateId: t._id,
      month,
      date,
      amount: null,
      note: "Missing pay-from account. Edit template.",
      ledgerEntryId: null,
      transactionId: null,
      status: "pending",
    });
    return res.json({ ok: true, item: inst, created: true });
  }

  // variable -> pending only
  if (t.isVariable) {
    const inst = await FixedInstance.create({
      familyId: req.familyId,
      templateId: t._id,
      month,
      date,
      amount: null,
      note: "",
      ledgerEntryId: null,
      transactionId: null,
      status: "pending",
    });
    return res.json({ ok: true, item: inst, created: true });
  }

  // fixed -> post immediately (same logic as generate)
  const amount = Number(t.defaultAmount);
  if (!amount || amount <= 0) return res.status(400).json({ ok: false, message: "Template amount invalid" });

  const txId = new mongoose.Types.ObjectId();
  const txMonth = toMonthString(date);
  const paidByUserId = req.user.userId;

  const splitRows = await buildSplitRows({ familyId: req.familyId, template: t, amount });

  const entry = await createLedgerForFixed({
    familyId: req.familyId,
    txId,
    date,
    month: txMonth,
    categoryId: t.categoryId,
    amount,
    paidByUserId,
    note: `Fixed: ${t.name}`,
    createdByUserId: req.user.userId,
    splitRows,
  });

  const tx = await Transaction.create({
    _id: txId,
    familyId: req.familyId,
    txType: "expense",
    date,
    month: txMonth,
    categoryId: t.categoryId,
    amount,
    note: `Fixed: ${t.name}`,
    fromAccountId: t.fromAccountId,
    toAccountId: null,
    paidByUserId,
    receivedByUserId: null,
    createdByUserId: req.user.userId,
  });

  const inst = await FixedInstance.create({
    familyId: req.familyId,
    templateId: t._id,
    month,
    date,
    amount,
    note: "",
    ledgerEntryId: entry._id,        // ✅ FIX
    transactionId: tx._id,
    status: "posted",
  });

  return res.json({ ok: true, item: inst, created: true });
});

// ------- Instances -------

router.get("/instances", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ ok: false, message: "month required" });

  const items = await FixedInstance.find({ familyId: req.familyId, month, status: { $ne: "deleted" } })
    .populate("templateId")
    .populate("transactionId");

  res.json({ ok: true, items });
});

router.post("/generate", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.body || {};
  if (!month) return res.status(400).json({ ok: false, message: "month required (YYYY-MM)" });

  const templates = await FixedTemplate.find({ familyId: req.familyId, isActive: true });

  let createdCount = 0;

  for (const t of templates) {
    const exists = await FixedInstance.findOne({ familyId: req.familyId, templateId: t._id, month });
    if (exists) continue;

    const date = defaultDateForMonth(month);

    if (!t.fromAccountId) {
      await FixedInstance.create({
        familyId: req.familyId,
        templateId: t._id,
        month,
        date,
        amount: null,
        note: "Missing pay-from account. Edit template and regenerate.",
        ledgerEntryId: null,
        transactionId: null,
        status: "pending",
      });
      createdCount++;
      continue;
    }

    if (t.isVariable) {
      await FixedInstance.create({
        familyId: req.familyId,
        templateId: t._id,
        month,
        date,
        amount: null,
        note: "",
        ledgerEntryId: null,
        transactionId: null,
        status: "pending",
      });
      createdCount++;
      continue;
    }

    const amount = Number(t.defaultAmount);
    const txId = new mongoose.Types.ObjectId();
    const txMonth = toMonthString(date);
    const paidByUserId = req.user.userId;

    const splitRows = await buildSplitRows({ familyId: req.familyId, template: t, amount });

    const entry = await createLedgerForFixed({
      familyId: req.familyId,
      txId,
      date,
      month: txMonth,
      categoryId: t.categoryId,
      amount,
      paidByUserId,
      note: `Fixed: ${t.name}`,
      createdByUserId: req.user.userId,
      splitRows,
    });

    const tx = await Transaction.create({
      _id: txId,
      familyId: req.familyId,
      txType: "expense",
      date,
      month: txMonth,
      categoryId: t.categoryId,
      amount,
      note: `Fixed: ${t.name}`,
      fromAccountId: t.fromAccountId,
      toAccountId: null,
      paidByUserId,
      receivedByUserId: null,
      createdByUserId: req.user.userId,
    });

    await FixedInstance.create({
      familyId: req.familyId,
      templateId: t._id,
      month,
      date,
      amount,
      note: "",
      ledgerEntryId: entry._id,     // ✅ FIX
      transactionId: tx._id,
      status: "posted",
    });

    createdCount++;
  }

  res.json({ ok: true, createdCount });
});

router.delete("/instances/:id", requireAuth, requireFamily, async (req, res) => {
  const inst = await FixedInstance.findOne({ _id: req.params.id, familyId: req.familyId });
  if (!inst) return res.status(404).json({ ok: false, message: "Not found" });

  if (inst.transactionId) {
    await Transaction.deleteOne({ _id: inst.transactionId, familyId: req.familyId });

    const le = await LedgerEntry.findOneAndDelete({
      familyId: req.familyId,
      sourceType: "transaction",
      sourceId: inst.transactionId,
    }).select("_id");

    if (le?._id) {
      await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: le._id });
    }
  }

  await FixedInstance.deleteOne({ _id: inst._id });

  res.json({ ok: true });
});

router.post("/instances/:id/post", requireAuth, requireFamily, async (req, res) => {
  const { amount, note } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ ok: false, message: "amount must be > 0" });

  const inst = await FixedInstance.findOne({ _id: req.params.id, familyId: req.familyId }).populate("templateId");
  if (!inst) return res.status(404).json({ ok: false, message: "Not found" });

  if (inst.status === "posted" || inst.status === "active")
    return res.status(400).json({ ok: false, message: "Already posted" });

  const t = inst.templateId;
  if (!t || !t.isVariable) return res.status(400).json({ ok: false, message: "This instance is not variable" });

  if (!t.fromAccountId)
    return res.status(400).json({ ok: false, message: "Template missing pay-from account. Please edit the template." });

  const txId = new mongoose.Types.ObjectId();
  const txMonth = toMonthString(inst.date);
  const paidByUserId = req.user.userId;
  const splitRows = await buildSplitRows({ familyId: req.familyId, template: t, amount: amt });

  const entry = await createLedgerForFixed({
    familyId: req.familyId,
    txId,
    date: inst.date,
    month: txMonth,
    categoryId: t.categoryId,
    amount: amt,
    paidByUserId,
    note: `Fixed: ${t.name}${note ? ` — ${String(note).trim()}` : ""}`,
    createdByUserId: req.user.userId,
    splitRows,
  });

  const tx = await Transaction.create({
    _id: txId,
    familyId: req.familyId,
    txType: "expense",
    date: inst.date,
    month: txMonth,
    categoryId: t.categoryId,
    amount: amt,
    note: `Fixed: ${t.name}${note ? ` — ${String(note).trim()}` : ""}`,
    fromAccountId: t.fromAccountId,
    toAccountId: null,
    paidByUserId,
    receivedByUserId: null,
    createdByUserId: req.user.userId,
  });

  inst.amount = amt;
  inst.note = note ? String(note).trim() : inst.note;
  inst.ledgerEntryId = entry._id;   // ✅ FIX
  inst.transactionId = tx._id;
  inst.status = "posted";
  await inst.save();

  res.json({ ok: true, item: inst });
});

export default router;