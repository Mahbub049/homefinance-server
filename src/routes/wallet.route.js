import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import User from "../models/User.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// GET /api/wallet/summary?month=YYYY-MM
router.get("/summary", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = (req.query.month || "").trim();
    if (!month) {
      return res.status(400).json({ ok: false, message: "month required" });
    }

    // Get family members
    const members = await FamilyMember.find({ familyId: req.familyId })
      .populate("userId", "name email");

    const userIds = members.map(m => m.userId._id);

    // -----------------------------
    // 1️⃣ Income per user
    // -----------------------------
    const incomeEntries = await LedgerEntry.find({
      familyId: req.familyId,
      entryType: "income",
      month,
    });

    const incomeMap = {};
    for (const u of userIds) incomeMap[u] = 0;

    for (const entry of incomeEntries) {
      if (entry.receivedByUserId) {
        incomeMap[entry.receivedByUserId] =
          round2(incomeMap[entry.receivedByUserId] + entry.amountTotal);
      }
    }

    // -----------------------------
    // 2️⃣ Expense paid per user
    // -----------------------------
    const expenseEntries = await LedgerEntry.find({
      familyId: req.familyId,
      entryType: "expense",
      month,
    });

    const paidMap = {};
    for (const u of userIds) paidMap[u] = 0;

    for (const entry of expenseEntries) {
      if (entry.paidByUserId) {
        paidMap[entry.paidByUserId] =
          round2(paidMap[entry.paidByUserId] + entry.amountTotal);
      }
    }

    // 3️⃣ Share per user (from Split) — ONLY EXPENSE entries
    const expenseEntryIds = expenseEntries.map(e => e._id);

    const splits = await Split.find({
      familyId: req.familyId,
      ledgerEntryId: { $in: expenseEntryIds },
    });

    const shareMap = {};
    for (const u of userIds) shareMap[u.toString()] = 0;

    for (const s of splits) {
      const uid = s.userId?.toString();
      if (!uid) continue;
      shareMap[uid] = round2((shareMap[uid] || 0) + Number(s.shareAmount || 0));
    }

    // -----------------------------
    // 4️⃣ Build Result
    // -----------------------------
    const resultUsers = [];

    for (const m of members) {
      const uid = m.userId._id.toString();
      const income = round2(incomeMap[uid] || 0);
      const paid = round2(paidMap[uid] || 0);
      const share = round2(shareMap[uid] || 0);
      const net = round2(paid - share);

      resultUsers.push({
        userId: uid,
        name: m.userId.name,
        income,
        paidExpense: paid,
        shareExpense: share,
        net,
      });
    }

    // -----------------------------
    // 5️⃣ Settlement Logic
    // -----------------------------
    let settlement = null;

    if (resultUsers.length === 2) {
      const [u1, u2] = resultUsers;

      if (u1.net > 0 && u2.net < 0) {
        settlement = {
          fromUserId: u2.userId,
          toUserId: u1.userId,
          amount: Math.abs(u2.net),
        };
      } else if (u2.net > 0 && u1.net < 0) {
        settlement = {
          fromUserId: u1.userId,
          toUserId: u2.userId,
          amount: Math.abs(u1.net),
        };
      }
    }

    res.json({
      ok: true,
      month,
      users: resultUsers,
      settlement,
    });

  } catch (err) {
    console.error("Wallet Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

export default router;