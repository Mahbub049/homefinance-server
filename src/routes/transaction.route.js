import mongoose from "mongoose";
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Transaction from "../models/Transaction.js";
import Category from "../models/Category.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Account from "../models/Account.js";

import { splitEqual, splitPersonal, splitRatio, splitFixed } from "../utils/splitCalc.js";

function monthKey(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function cleanId(value) {
  if (!value) return null;
  if (typeof value === "object") return value._id || value.id || null;
  return value;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function accountOwnerMatchesMember(account, memberUserId, memberNameByUserId) {
  const owner = String(account?.owner || "").trim().toLowerCase();

  if (!owner) return true;
  if (["joint", "shared", "family"].includes(owner)) return true;

  const memberName = String(memberNameByUserId.get(String(memberUserId)) || "")
    .trim()
    .toLowerCase();

  if (!memberName) return true;

  const memberParts = memberName.split(/\s+/).filter(Boolean);

  return (
    memberName.includes(owner) ||
    owner.includes(memberName) ||
    memberParts.some((part) => owner.includes(part) || part.includes(owner))
  );
}

async function buildExpensePayments({ familyId, amount, paidByUserId, fromAccountId, paymentMode, paymentParts }) {
  const mode = paymentMode === "split" ? "split" : "single";

  const members = await FamilyMember.find({ familyId })
    .populate("userId", "name")
    .lean();

  const validUserIds = members.map((m) => String(cleanId(m.userId))).filter(Boolean);
  const memberNameByUserId = new Map(
    members.map((m) => [String(cleanId(m.userId)), String(m.userId?.name || "")])
  );

  const accountIds = mode === "split"
    ? (Array.isArray(paymentParts) ? paymentParts.map((p) => cleanId(p.accountId)).filter(Boolean) : [])
    : [fromAccountId].filter(Boolean);

  const accounts = await Account.find({
    familyId,
    _id: { $in: accountIds },
    isActive: { $ne: false },
  }).lean();

  const accountById = new Map(accounts.map((a) => [String(a._id), a]));

  if (mode === "single") {
    if (!paidByUserId) {
      const err = new Error("Paid By required for expense");
      err.status = 400;
      throw err;
    }

    if (!fromAccountId) {
      const err = new Error("From account required for expense");
      err.status = 400;
      throw err;
    }

    if (!validUserIds.includes(String(paidByUserId))) {
      const err = new Error("Invalid Paid By member");
      err.status = 400;
      throw err;
    }

    const account = accountById.get(String(fromAccountId));
    if (!account) {
      const err = new Error("Selected account not found");
      err.status = 400;
      throw err;
    }

    if (!["cash", "bank", "wallet"].includes(String(account.type || "").toLowerCase())) {
      const err = new Error("Expense payment must be made from a cash, bank, or wallet account");
      err.status = 400;
      throw err;
    }

    if (!accountOwnerMatchesMember(account, paidByUserId, memberNameByUserId)) {
      const err = new Error("Selected account does not belong to the selected payer");
      err.status = 400;
      throw err;
    }

    return {
      paymentMode: "single",
      paidByUserId,
      fromAccountId,
      paymentParts: [{ userId: paidByUserId, accountId: fromAccountId, amount: round2(amount) }],
    };
  }

  const rows = Array.isArray(paymentParts)
    ? paymentParts.map((p) => ({
        userId: cleanId(p.userId),
        accountId: cleanId(p.accountId),
        amount: Number(p.amount || 0),
      }))
    : [];

  if (rows.length < 2) {
    const err = new Error("Split payment needs at least two payment rows");
    err.status = 400;
    throw err;
  }

  for (const row of rows) {
    if (!row.userId || !validUserIds.includes(String(row.userId))) {
      const err = new Error("Invalid member in split payment");
      err.status = 400;
      throw err;
    }

    if (!row.accountId || !accountById.has(String(row.accountId))) {
      const err = new Error("Select a valid account for every split payment row");
      err.status = 400;
      throw err;
    }

    if (!row.amount || row.amount <= 0) {
      const err = new Error("Every split payment amount must be greater than 0");
      err.status = 400;
      throw err;
    }

    const account = accountById.get(String(row.accountId));
    if (!["cash", "bank", "wallet"].includes(String(account.type || "").toLowerCase())) {
      const err = new Error("Split payment accounts must be cash, bank, or wallet accounts");
      err.status = 400;
      throw err;
    }

    if (!accountOwnerMatchesMember(account, row.userId, memberNameByUserId)) {
      const err = new Error("One selected account does not belong to the selected payer");
      err.status = 400;
      throw err;
    }
  }

  const totalPaid = round2(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  if (totalPaid !== round2(amount)) {
    const err = new Error("Split payment amounts must sum to the total transaction amount");
    err.status = 400;
    throw err;
  }

  return {
    paymentMode: "split",
    paidByUserId: null,
    fromAccountId: null,
    paymentParts: rows.map((row) => ({ ...row, amount: round2(row.amount) })),
  };
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

async function buildExpenseSplit({ familyId, amount, paidByUserId, split }) {
  const members = await FamilyMember.find({ familyId }).select("userId").lean();
  const userIds = members.map((m) => String(m.userId));

  if (userIds.length === 0) {
    const err = new Error("No family members found for split");
    err.status = 400;
    throw err;
  }

  const splitType = split?.type || "personal";

  if (!["personal", "equal", "ratio", "fixed"].includes(splitType)) {
    const err = new Error("Invalid split type");
    err.status = 400;
    throw err;
  }

  let splitRows = [];
  let normalizedSplit = {
    type: splitType,
    personalUserId: null,
    ratios: [],
    fixed: [],
  };

  if (splitType === "equal") {
    splitRows = splitEqual(amount, userIds);
    normalizedSplit = { ...normalizedSplit, type: "equal" };
  }

  if (splitType === "personal") {
    const personalUserId = cleanId(split?.personalUserId) || paidByUserId;
    if (!personalUserId || !userIds.includes(String(personalUserId))) {
      const err = new Error("Select a valid member for Personal split");
      err.status = 400;
      throw err;
    }

    splitRows = splitPersonal(amount, personalUserId);
    normalizedSplit = {
      ...normalizedSplit,
      type: "personal",
      personalUserId,
    };
  }

  if (splitType === "ratio") {
    const ratios = Array.isArray(split?.ratios)
      ? split.ratios.map((r) => ({
          userId: cleanId(r.userId),
          ratio: Number(r.ratio || 0),
        }))
      : [];

    if (ratios.length === 0) {
      const err = new Error("Ratio split requires member ratios");
      err.status = 400;
      throw err;
    }

    const invalid = ratios.find((r) => !r.userId || !userIds.includes(String(r.userId)));
    if (invalid) {
      const err = new Error("Invalid member in Ratio split");
      err.status = 400;
      throw err;
    }

    splitRows = splitRatio(amount, ratios);
    normalizedSplit = {
      ...normalizedSplit,
      type: "ratio",
      ratios,
    };
  }

  if (splitType === "fixed") {
    const fixed = Array.isArray(split?.fixed)
      ? split.fixed.map((f) => ({
          userId: cleanId(f.userId),
          amount: Number(f.amount || 0),
        }))
      : [];

    if (fixed.length === 0) {
      const err = new Error("Fixed split requires member amounts");
      err.status = 400;
      throw err;
    }

    const invalid = fixed.find((f) => !f.userId || !userIds.includes(String(f.userId)));
    if (invalid) {
      const err = new Error("Invalid member in Fixed split");
      err.status = 400;
      throw err;
    }

    splitRows = splitFixed(amount, fixed);
    normalizedSplit = {
      ...normalizedSplit,
      type: "fixed",
      fixed,
    };
  }

  if (!Array.isArray(splitRows) || splitRows.length === 0) {
    const err = new Error("Invalid split data");
    err.status = 400;
    throw err;
  }

  return { splitRows, normalizedSplit };
}

async function syncTransactionLedger({ req, tx, payload }) {
  const { txType, date, categoryId, amount, note, paidByUserId, receivedByUserId, splitRows } = payload;
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

  let rowsToInsert = [];
  if (txType === "income" && receivedByUserId) {
    rowsToInsert = [{ userId: receivedByUserId, shareAmount: amt }];
  }

  if (txType === "expense") {
    rowsToInsert = Array.isArray(splitRows) && splitRows.length > 0
      ? splitRows
      : paidByUserId
        ? [{ userId: paidByUserId, shareAmount: amt }]
        : [];
  }

  if (rowsToInsert.length > 0) {
    await Split.insertMany(
      rowsToInsert.map((r) => ({
        familyId: req.familyId,
        ledgerEntryId: le._id,
        userId: r.userId,
        shareAmount: Number(r.shareAmount || 0),
      }))
    );
  }
}

async function validateTransactionInput(req, body = {}) {
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
    paymentMode,
    paymentParts,
    split,
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
  }

  if (txType === "transfer") {
    if (!fromAccountId || !toAccountId) {
      return { ok: false, message: "From & To accounts required" };
    }
    if (String(fromAccountId) === String(toAccountId)) {
      return { ok: false, message: "From and To accounts must be different" };
    }
  }

  let normalizedSplit = null;
  let splitRows = [];
  let normalizedPayment = {
    paymentMode: txType === "expense" ? "single" : undefined,
    paidByUserId: txType === "expense" ? paidByUserId || null : null,
    fromAccountId: txType === "expense" ? fromAccountId || null : null,
    paymentParts: [],
  };

  if (txType === "expense") {
    try {
      normalizedPayment = await buildExpensePayments({
        familyId: req.familyId,
        amount: amt,
        paidByUserId,
        fromAccountId,
        paymentMode,
        paymentParts,
      });

      const splitFallbackPayer = normalizedPayment.paidByUserId || normalizedPayment.paymentParts?.[0]?.userId || null;

      const result = await buildExpenseSplit({
        familyId: req.familyId,
        amount: amt,
        paidByUserId: splitFallbackPayer,
        split,
      });
      normalizedSplit = result.normalizedSplit;
      splitRows = result.splitRows;
    } catch (e) {
      return { ok: false, message: e?.message || "Invalid split/payment data" };
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
      fromAccountId: txType === "expense"
        ? normalizedPayment.fromAccountId
        : txType === "income"
          ? null
          : fromAccountId || null,
      toAccountId: txType === "expense" ? null : toAccountId || null,
      paidByUserId: txType === "expense" ? normalizedPayment.paidByUserId : null,
      receivedByUserId: txType === "income" ? receivedByUserId || null : null,
      paymentMode: txType === "expense" ? normalizedPayment.paymentMode : "single",
      paymentParts: txType === "expense" ? normalizedPayment.paymentParts : [],
      split: txType === "expense" ? normalizedSplit : null,
      splitRows,
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
    .populate("receivedByUserId")
    .populate("paymentParts.userId", "name")
    .populate("paymentParts.accountId", "name type owner")
    .populate("split.personalUserId", "name")
    .populate("split.ratios.userId", "name")
    .populate("split.fixed.userId", "name");

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
    const check = await validateTransactionInput(req, req.body || {});
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
      paymentMode: payload.paymentMode,
      paymentParts: payload.paymentParts,
      split: payload.split,
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

    const check = await validateTransactionInput(req, req.body || {});
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
    existing.paymentMode = payload.paymentMode;
    existing.paymentParts = payload.paymentParts;
    existing.split = payload.split;
    await existing.save();

    await syncTransactionLedger({ req, tx: existing, payload });

    res.json({ ok: true, item: existing });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Update failed" });
  }
});

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
