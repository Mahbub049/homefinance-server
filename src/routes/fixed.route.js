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
    if (cat) {
      financialType = cat.financialType || (cat.kind === "income" ? "income" : "living");
    }
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

  if (!month) {
    return res.status(400).json({ ok: false, message: "month required (YYYY-MM)" });
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

  const inst = await createPostedInstance({
    familyId: req.familyId,
    template,
    month,
    date,
    amount: finalAmount,
    paidByUserId,
    fromAccountId,
    note: note || "",
    createdByUserId: req.user.userId,
  });

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
  if (!month) {
    return res.status(400).json({ ok: false, message: "month required (YYYY-MM)" });
  }

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

  inst.amount = finalAmount;
  inst.note = note?.trim() || "";
  inst.date = date;
  inst.paidByUserId = paidByUserId;
  inst.fromAccountId = fromAccountId;
  inst.ledgerEntryId = entry._id;
  inst.transactionId = tx._id;
  inst.status = "posted";
  await inst.save();

  const populated = await FixedInstance.findById(inst._id)
    .populate("templateId")
    .populate("transactionId")
    .populate("paidByUserId", "name")
    .populate("fromAccountId", "name type");

  res.json({ ok: true, item: populated });
});

router.delete("/instances/:id", requireAuth, requireFamily, async (req, res) => {
  const inst = await FixedInstance.findOne({
    _id: req.params.id,
    familyId: req.familyId,
  });

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

export default router;