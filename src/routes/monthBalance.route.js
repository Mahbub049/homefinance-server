import mongoose from "mongoose";
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import MonthlyBalance from "../models/MonthlyBalance.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function parseMonth(yyyyMM) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(yyyyMM || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return { y, mm };
}

function prevMonth(yyyyMM) {
  const p = parseMonth(yyyyMM);
  if (!p) return null;
  let { y, mm } = p;
  mm -= 1;
  if (mm === 0) {
    mm = 12;
    y -= 1;
  }
  return `${y}-${String(mm).padStart(2, "0")}`;
}

function monthBounds(yyyyMM) {
  const p = parseMonth(yyyyMM);
  if (!p) return null;
  const start = new Date(p.y, p.mm - 1, 1, 0, 0, 0, 0);
  const end = new Date(p.y, p.mm, 1, 0, 0, 0, 0);
  return { start, end };
}

async function txSummaryForMonth(familyIdString, month) {
  const familyObjectId = new mongoose.Types.ObjectId(familyIdString);
  const rows = await Transaction.aggregate([
    { $match: { familyId: familyObjectId, month } },
    { $group: { _id: "$txType", total: { $sum: "$amount" } } },
  ]);

  const out = { income: 0, expense: 0, transfer: 0 };
  for (const r of rows) {
    if (r._id === "income") out.income = Number(r.total || 0);
    if (r._id === "expense") out.expense = Number(r.total || 0);
    if (r._id === "transfer") out.transfer = Number(r.total || 0);
  }
  out.netCashflow = out.income - out.expense;
  for (const k of Object.keys(out)) out[k] = round2(out[k]);
  return out;
}

async function balancesAtDate(familyIdString, asOfDate) {
  const familyObjectId = new mongoose.Types.ObjectId(familyIdString);
  const accounts = await Account.find({ familyId: familyObjectId, isActive: true })
    .select("name type openingBalance")
    .lean();

  const cutoff = new Date(asOfDate);

  const inflows = await Transaction.aggregate([
    {
      $match: {
        familyId: familyObjectId,
        date: { $lt: cutoff },
        toAccountId: { $ne: null },
        txType: { $in: ["income", "transfer"] },
      },
    },
    { $group: { _id: "$toAccountId", total: { $sum: "$amount" } } },
  ]);

  const outflows = await Transaction.aggregate([
    {
      $match: {
        familyId: familyObjectId,
        date: { $lt: cutoff },
        fromAccountId: { $ne: null },
        txType: { $in: ["expense", "transfer"] },
      },
    },
    { $group: { _id: "$fromAccountId", total: { $sum: "$amount" } } },
  ]);

  const inMap = Object.create(null);
  const outMap = Object.create(null);
  for (const r of inflows) inMap[String(r._id)] = Number(r.total || 0);
  for (const r of outflows) outMap[String(r._id)] = Number(r.total || 0);

  let total = 0;
  const items = accounts.map((a) => {
    const id = String(a._id);
    const opening = Number(a.openingBalance || 0);
    const bal = opening + Number(inMap[id] || 0) - Number(outMap[id] || 0);
    total += bal;
    return {
      accountId: a._id,
      name: a.name,
      type: a.type,
      openingBalance: round2(opening),
      balance: round2(bal),
    };
  });

  return { accounts: items, total: round2(total) };
}

/**
 * GET /api/month-balance?month=YYYY-MM
 */
router.get("/", requireAuth, requireFamily, async (req, res) => {
  const month = String(req.query.month || "").trim();
  if (!parseMonth(month))
    return res
      .status(400)
      .json({ ok: false, message: "Valid month (YYYY-MM) required" });

  const familyObjectId = new mongoose.Types.ObjectId(req.familyId);

  const bounds = monthBounds(month);
  if (!bounds)
    return res.status(400).json({ ok: false, message: "Valid month (YYYY-MM) required" });

  const openingSnap = await balancesAtDate(req.familyId, bounds.start);
  const closingSnap = await balancesAtDate(req.familyId, bounds.end);
  const summary = await txSummaryForMonth(req.familyId, month);

  let doc = await MonthlyBalance.findOne({ familyId: familyObjectId, month });
  if (!doc) {
    doc = await MonthlyBalance.create({
      familyId: familyObjectId,
      month,
      openingBalance: openingSnap.total,
      closingBalance: null,
    });
  } else {
    doc.openingBalance = openingSnap.total;
    await doc.save();
  }

  res.json({
    ok: true,
    item: doc,
    computed: {
      month,
      openingTotal: openingSnap.total,
      closingTotal: closingSnap.total,
      accountsOpening: openingSnap.accounts,
      accountsClosing: closingSnap.accounts,
      summary,
    },
  });
});

/**
 * POST /api/month-balance/close
 * body: { month: "YYYY-MM" }
 */
router.post("/close", requireAuth, requireFamily, async (req, res) => {
  const month = String(req.body?.month || "").trim();
  if (!parseMonth(month))
    return res
      .status(400)
      .json({ ok: false, message: "Valid month (YYYY-MM) required" });

  const familyObjectId = new mongoose.Types.ObjectId(req.familyId);

  const bounds = monthBounds(month);
  if (!bounds)
    return res.status(400).json({ ok: false, message: "Valid month (YYYY-MM) required" });

  let doc = await MonthlyBalance.findOne({ familyId: familyObjectId, month });
  if (!doc) {
    doc = await MonthlyBalance.create({
      familyId: familyObjectId,
      month,
      openingBalance: 0,
      closingBalance: null,
    });
  }

  const openingSnap = await balancesAtDate(req.familyId, bounds.start);
  const closingSnap = await balancesAtDate(req.familyId, bounds.end);
  const summary = await txSummaryForMonth(req.familyId, month);

  doc.openingBalance = openingSnap.total;
  doc.closingBalance = closingSnap.total;
  doc.closedAt = new Date();
  doc.closedByUserId = req.user.userId;
  await doc.save();

  res.json({
    ok: true,
    item: doc,
    calc: {
      ...summary,
      openingTotal: openingSnap.total,
      closingTotal: closingSnap.total,
    },
    accounts: {
      opening: openingSnap.accounts,
      closing: closingSnap.accounts,
    },
  });
});

export default router;