import mongoose from "mongoose";
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import MonthlyBalance from "../models/MonthlyBalance.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
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

function snapshotTotal(accounts = []) {
  return round2(
    accounts.reduce((sum, item) => sum + Number(item.balance || 0), 0)
  );
}

function cleanSnapshotRow(row, fallback = {}) {
  return {
    accountId: row.accountId || row._id || fallback.accountId,
    name: row.name || fallback.name || "",
    type: row.type || fallback.type || "",
    owner: row.owner || fallback.owner || "",
    balance: round2(row.balance ?? row.openingBalance ?? fallback.balance ?? 0),
    systemBalance:
      row.systemBalance === null || row.systemBalance === undefined
        ? null
        : round2(row.systemBalance),
    manualEdited: !!row.manualEdited,
  };
}

async function txSummaryForMonth(familyIdString, month) {
  const familyObjectId = new mongoose.Types.ObjectId(familyIdString);

  const rows = await Transaction.aggregate([
    { $match: { familyId: familyObjectId, month } },
    { $group: { _id: "$txType", total: { $sum: "$amount" } } },
  ]);

  const out = {
    income: 0,
    expense: 0,
    transfer: 0,
  };

  for (const r of rows) {
    if (r._id === "income") out.income = Number(r.total || 0);
    if (r._id === "expense") out.expense = Number(r.total || 0);
    if (r._id === "transfer") out.transfer = Number(r.total || 0);
  }

  out.netCashflow = out.income - out.expense;

  for (const key of Object.keys(out)) {
    out[key] = round2(out[key]);
  }

  return out;
}

async function balancesAtDateRaw(familyIdString, asOfDate) {
  const familyObjectId = new mongoose.Types.ObjectId(familyIdString);

  const accounts = await Account.find({
    familyId: familyObjectId,
    isActive: true,
  })
    .select("name type owner openingBalance")
    .sort({ owner: 1, name: 1 })
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

  for (const r of inflows) {
    inMap[String(r._id)] = Number(r.total || 0);
  }

  for (const r of outflows) {
    outMap[String(r._id)] = Number(r.total || 0);
  }

  let total = 0;

  const items = accounts.map((account) => {
    const id = String(account._id);
    const opening = Number(account.openingBalance || 0);
    const balance = opening + Number(inMap[id] || 0) - Number(outMap[id] || 0);

    total += balance;

    return {
      accountId: account._id,
      name: account.name,
      type: account.type,
      owner: account.owner,
      balance: round2(balance),
    };
  });

  return {
    accounts: items,
    total: round2(total),
  };
}

async function accountMovementsForMonth(familyIdString, month) {
  const familyObjectId = new mongoose.Types.ObjectId(familyIdString);

  const inflows = await Transaction.aggregate([
    {
      $match: {
        familyId: familyObjectId,
        month,
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
        month,
        fromAccountId: { $ne: null },
        txType: { $in: ["expense", "transfer"] },
      },
    },
    { $group: { _id: "$fromAccountId", total: { $sum: "$amount" } } },
  ]);

  const map = Object.create(null);

  for (const r of inflows) {
    const id = String(r._id);
    if (!map[id]) map[id] = { inflow: 0, outflow: 0 };
    map[id].inflow += Number(r.total || 0);
  }

  for (const r of outflows) {
    const id = String(r._id);
    if (!map[id]) map[id] = { inflow: 0, outflow: 0 };
    map[id].outflow += Number(r.total || 0);
  }

  return map;
}

async function openingSnapshotForMonth(familyIdString, month) {
  const familyObjectId = new mongoose.Types.ObjectId(familyIdString);
  const previousMonth = prevMonth(month);

  if (previousMonth) {
    const previousDoc = await MonthlyBalance.findOne({
      familyId: familyObjectId,
      month: previousMonth,
      closingBalance: { $ne: null },
    }).lean();

    if (previousDoc?.accountsClosing?.length) {
      const accounts = previousDoc.accountsClosing.map((row) =>
        cleanSnapshotRow(row)
      );

      return {
        accounts,
        total: snapshotTotal(accounts),
        source: "previous_closed_month",
      };
    }
  }

  const bounds = monthBounds(month);
  const raw = await balancesAtDateRaw(familyIdString, bounds.start);

  return {
    ...raw,
    source: "system_calculated",
  };
}

function buildClosingSnapshotFromOpening(openingAccounts = [], movements = {}) {
  const accounts = openingAccounts.map((account) => {
    const id = String(account.accountId);
    const movement = movements[id] || { inflow: 0, outflow: 0 };

    const closing =
      Number(account.balance || 0) +
      Number(movement.inflow || 0) -
      Number(movement.outflow || 0);

    return {
      accountId: account.accountId,
      name: account.name,
      type: account.type,
      owner: account.owner,
      balance: round2(closing),
      systemBalance: round2(closing),
      manualEdited: false,
    };
  });

  return {
    accounts,
    total: snapshotTotal(accounts),
  };
}

function applyManualClosingBalances(systemClosingAccounts = [], manualRows = []) {
  const manualMap = new Map();

  for (const row of manualRows || []) {
    if (!row?.accountId) continue;

    const n = Number(row.balance);
    if (Number.isNaN(n)) continue;

    manualMap.set(String(row.accountId), round2(n));
  }

  let manualAdjusted = false;

  const accounts = systemClosingAccounts.map((account) => {
    const id = String(account.accountId);
    const systemBalance = round2(account.systemBalance ?? account.balance);

    if (!manualMap.has(id)) {
      return {
        ...account,
        balance: systemBalance,
        systemBalance,
        manualEdited: false,
      };
    }

    const manualBalance = manualMap.get(id);
    const edited = round2(manualBalance) !== round2(systemBalance);

    if (edited) manualAdjusted = true;

    return {
      ...account,
      balance: manualBalance,
      systemBalance,
      manualEdited: edited,
    };
  });

  return {
    accounts,
    total: snapshotTotal(accounts),
    manualAdjusted,
  };
}

// GET /api/month-balance?month=YYYY-MM
router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();

    if (!parseMonth(month)) {
      return res.status(400).json({
        ok: false,
        message: "Valid month (YYYY-MM) required",
      });
    }

    const familyObjectId = new mongoose.Types.ObjectId(req.familyId);

    const openingSnap = await openingSnapshotForMonth(req.familyId, month);
    const movements = await accountMovementsForMonth(req.familyId, month);
    const systemClosingSnap = buildClosingSnapshotFromOpening(
      openingSnap.accounts,
      movements
    );
    const summary = await txSummaryForMonth(req.familyId, month);

    let doc = await MonthlyBalance.findOne({
      familyId: familyObjectId,
      month,
    });

    if (!doc) {
      doc = await MonthlyBalance.create({
        familyId: familyObjectId,
        month,
        openingBalance: openingSnap.total,
        closingBalance: null,
        accountsOpening: openingSnap.accounts,
      });
    } else if (doc.closingBalance === null || doc.closingBalance === undefined) {
      doc.openingBalance = openingSnap.total;
      doc.accountsOpening = openingSnap.accounts;
      await doc.save();
    }

    const savedOpening = doc.accountsOpening?.length
      ? doc.accountsOpening.map((row) => cleanSnapshotRow(row))
      : openingSnap.accounts;

    const savedClosing = doc.accountsClosing?.length
      ? doc.accountsClosing.map((row) => cleanSnapshotRow(row))
      : systemClosingSnap.accounts;

    const displayClosingTotal =
      doc.closingBalance !== null && doc.closingBalance !== undefined
        ? round2(doc.closingBalance)
        : snapshotTotal(savedClosing);

    res.json({
      ok: true,
      item: doc,
      computed: {
        month,
        openingSource: openingSnap.source,
        openingTotal: snapshotTotal(savedOpening),
        closingTotal: displayClosingTotal,
        systemClosingTotal: systemClosingSnap.total,
        accountsOpening: savedOpening,
        accountsClosing: savedClosing,
        systemAccountsClosing: systemClosingSnap.accounts,
        summary,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error?.message || "Failed to load carry forward data",
    });
  }
});

// POST /api/month-balance/close
// body: { month: "YYYY-MM", accountBalances: [{ accountId, balance }] }
router.post("/close", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = String(req.body?.month || "").trim();

    if (!parseMonth(month)) {
      return res.status(400).json({
        ok: false,
        message: "Valid month (YYYY-MM) required",
      });
    }

    const familyObjectId = new mongoose.Types.ObjectId(req.familyId);

    let doc = await MonthlyBalance.findOne({
      familyId: familyObjectId,
      month,
    });

    if (!doc) {
      doc = await MonthlyBalance.create({
        familyId: familyObjectId,
        month,
        openingBalance: 0,
        closingBalance: null,
      });
    }

    const openingSnap = await openingSnapshotForMonth(req.familyId, month);
    const movements = await accountMovementsForMonth(req.familyId, month);
    const systemClosingSnap = buildClosingSnapshotFromOpening(
      openingSnap.accounts,
      movements
    );

    const manual = applyManualClosingBalances(
      systemClosingSnap.accounts,
      req.body?.accountBalances || []
    );

    const summary = await txSummaryForMonth(req.familyId, month);

    doc.openingBalance = openingSnap.total;
    doc.closingBalance = manual.total;
    doc.accountsOpening = openingSnap.accounts;
    doc.accountsClosing = manual.accounts;
    doc.manualAdjusted = manual.manualAdjusted;
    doc.closedAt = new Date();
    doc.closedByUserId = req.user.userId;

    await doc.save();

    res.json({
      ok: true,
      item: doc,
      calc: {
        ...summary,
        openingTotal: openingSnap.total,
        closingTotal: manual.total,
        systemClosingTotal: systemClosingSnap.total,
        manualAdjusted: manual.manualAdjusted,
      },
      accounts: {
        opening: openingSnap.accounts,
        closing: manual.accounts,
        systemClosing: systemClosingSnap.accounts,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error?.message || "Close month failed",
    });
  }
});

export default router;