import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function parseMonth(month) {
  const [y, m] = String(month || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return { y, m };
}

function endOfMonthDate(month) {
  const p = parseMonth(month);
  if (!p) return null;
  return new Date(p.y, p.m, 0, 23, 59, 59, 999);
}

// Savings V2: contributions are TRANSFERS into savings/investment accounts.
// We treat withdrawals as negative savings contribution.
async function computeSavingsV2(familyId, month) {
  const monthEnd = endOfMonthDate(month);
  if (!monthEnd) return { monthIn: 0, monthOut: 0, monthNet: 0, totalAsset: 0 };

  const savingsAccounts = await Account.find({
    familyId,
    isActive: true,
    type: { $in: ["savings", "investment"] },
  }).select("_id openingBalance");

  const ids = savingsAccounts.map((a) => a._id);
  if (ids.length === 0) return { monthIn: 0, monthOut: 0, monthNet: 0, totalAsset: 0 };

  // 1) Month in/out
  const mt = await Transaction.aggregate([
    {
      $match: {
        familyId: new mongoose.Types.ObjectId(familyId),
        txType: "transfer",
        month,
        $or: [{ fromAccountId: { $in: ids } }, { toAccountId: { $in: ids } }],
      },
    },
    {
      $project: {
        inAmt: { $cond: [{ $in: ["$toAccountId", ids] }, "$amount", 0] },
        outAmt: { $cond: [{ $in: ["$fromAccountId", ids] }, "$amount", 0] },
      },
    },
    { $group: { _id: null, monthIn: { $sum: "$inAmt" }, monthOut: { $sum: "$outAmt" } } },
  ]);

  const monthIn = round2(mt?.[0]?.monthIn || 0);
  const monthOut = round2(mt?.[0]?.monthOut || 0);
  const monthNet = round2(monthIn - monthOut);

  // 2) Total savings asset up to month end = sum(openingBalance) + net transfers up to monthEnd
  const rows = await Transaction.aggregate([
    {
      $match: {
        familyId: new mongoose.Types.ObjectId(familyId),
        txType: "transfer",
        date: { $lte: monthEnd },
        $or: [{ fromAccountId: { $in: ids } }, { toAccountId: { $in: ids } }],
      },
    },
    {
      $project: {
        pairs: [
          { acc: { $cond: [{ $in: ["$toAccountId", ids] }, "$toAccountId", null] }, amt: "$amount" },
          {
            acc: { $cond: [{ $in: ["$fromAccountId", ids] }, "$fromAccountId", null] },
            amt: { $multiply: ["$amount", -1] },
          },
        ],
      },
    },
    { $unwind: "$pairs" },
    { $match: { "pairs.acc": { $ne: null } } },
    { $group: { _id: null, net: { $sum: "$pairs.amt" } } },
  ]);

  const openingSum = round2(
    savingsAccounts.reduce((sum, a) => sum + Number(a.openingBalance || 0), 0)
  );
  const netTransfers = round2(rows?.[0]?.net || 0);
  const totalAsset = round2(openingSum + netTransfers);

  return { monthIn, monthOut, monthNet, totalAsset };
}

/* =====================================================
   MONTH SUMMARY
===================================================== */

router.get("/summary", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = req.query.month;
    if (!month) {
      return res.status(400).json({ ok: false, message: "month required" });
    }

    /* ===========================================
       1️⃣ LOAD FAMILY USERS
    =========================================== */
    const members = await FamilyMember.find({ familyId: req.familyId }).populate("userId", "name email");
    const users = members.map((m) => m.userId).filter(Boolean);

    /* ===========================================
       2️⃣ LOAD LEDGER ENTRIES (income + expense)
    =========================================== */
    const entries = await LedgerEntry.find({
      familyId: req.familyId,
      month,
    });

    // v2 classification totals (driven by LedgerEntry.financialType)
    let totalIncome = 0;
    let totalLiving = 0;
    let totalDebt = 0;
    let totalLedgerInvestment = 0;

    for (const e of entries) {
      const amt = Number(e.amountTotal || 0);
      const ft = e.financialType || (e.entryType === "income" ? "income" : "living");

      if (ft === "income") totalIncome += amt;
      else if (ft === "living") totalLiving += amt;
      else if (ft === "debt") totalDebt += amt;
      else if (ft === "investment") totalLedgerInvestment += amt;
    }

    totalIncome = round2(totalIncome);
    totalLiving = round2(totalLiving);
    totalDebt = round2(totalDebt);
    totalLedgerInvestment = round2(totalLedgerInvestment);

    /* ===========================================
       3️⃣ SAVINGS V2 (Account-based transfers)
       Savings deposit = transfer into savings/investment accounts.
       Withdraw = transfer out of savings/investment accounts.
       NOT an expense.
    =========================================== */

    const sv2 = await computeSavingsV2(req.familyId, month);
    const savingsContribution = sv2.monthNet; // net deposit - withdraw

    /* ===========================================
       4️⃣ TOTAL SAVINGS ASSET (up to this month)
    =========================================== */

    const totalSavingsAsset = sv2.totalAsset;

    /* ===========================================
       5️⃣ DISPOSABLE CALCULATION
    =========================================== */

    // investment for the month = ledger investment + savings contributions
    const totalInvestment = round2(totalLedgerInvestment + savingsContribution);

    const available = round2(totalIncome - totalLiving - totalDebt);
    const finalBalance = round2(available - totalInvestment);

    const savingsRate = totalIncome > 0 ? round2((totalInvestment / totalIncome) * 100) : 0;

    // legacy fields (keep so nothing else breaks)
    const legacyExpense = round2(totalLiving + totalDebt + totalLedgerInvestment);
    const legacyBalance = round2(totalIncome - legacyExpense);
    const legacyDisposable = round2(totalIncome - legacyExpense - savingsContribution);

    /* ===========================================
       6️⃣ SPLIT + SETTLEMENT LOGIC
    =========================================== */

    // ✅ Split model stores ledgerEntryId (NOT entryId) and does NOT store month.
    // Fetch splits only for the loaded month entries.
    const entryIds = entries.map((e) => e._id);
    const splits = await Split.find({
      familyId: req.familyId,
      ledgerEntryId: { $in: entryIds },
    });

    const splitByEntry = {};
    for (const s of splits) {
      const key = String(s.ledgerEntryId);
      if (!splitByEntry[key]) splitByEntry[key] = [];
      splitByEntry[key].push(s);
    }

    let paidMap = {};
    let shareMap = {};

    for (const u of users) {
      paidMap[String(u._id)] = 0;
      shareMap[String(u._id)] = 0;
    }

    for (const e of entries) {
      // Settlement applies to EXPENSE entries only
      if (e.entryType !== "expense") continue;

      const entrySplits = splitByEntry[String(e._id)] || [];

      // Who should bear the cost
      for (const s of entrySplits) {
        shareMap[String(s.userId)] += Number(s.shareAmount || 0);
      }

      // Who actually paid
      if (e.paidByUserId) {
        paidMap[String(e.paidByUserId)] += Number(e.amountTotal || 0);
      }
    }

    const settlement = users.map((u) => {
      const net = round2(
        (paidMap[String(u._id)] || 0) -
        (shareMap[String(u._id)] || 0)
      );

      return {
        userId: u._id,
        name: u.name,
        net, // positive → gets back, negative → owes
      };
    });

    /* ===========================================
       RESPONSE
    =========================================== */

    res.json({
      ok: true,
      data: {
        // ✅ v2 summary (new dashboard brain)
        summary: {
          income: totalIncome,
          living: totalLiving,
          debt: totalDebt,
          investment: totalInvestment,
          available,
          finalBalance,
          savingsRate,
          components: {
            ledgerInvestment: totalLedgerInvestment,
            savingsContribution,
          },
        },

        // 🧯 legacy (for old UI pieces / other pages)
        family: {
          income: totalIncome,
          expense: legacyExpense,
          savings: savingsContribution,
          balance: legacyBalance,
          disposable: legacyDisposable,
        },
        totalSavingsAsset,
        settlement,
      },
    });
  } catch (err) {
    console.error("Dashboard Summary Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

router.get("/trend", requireAuth, requireFamily, async (req, res) => {
  try {
    const now = new Date();
    const months = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      months.push(m);
    }

    const result = [];

    for (const m of months) {
      const entries = await LedgerEntry.find({ familyId: req.familyId, month: m });
      const sv2 = await computeSavingsV2(req.familyId, m);

      let income = 0;
      let living = 0;
      let debt = 0;
      let ledgerInvestment = 0;

      for (const e of entries) {
        const amt = Number(e.amountTotal || 0);
        const ft = e.financialType || (e.entryType === "income" ? "income" : "living");

        if (ft === "income") income += amt;
        else if (ft === "living") living += amt;
        else if (ft === "debt") debt += amt;
        else if (ft === "investment") ledgerInvestment += amt;
      }

      const savingsContribution = sv2.monthNet;
      const investment = ledgerInvestment + savingsContribution;
      const available = income - living - debt;
      const finalBalance = available - investment;
      const savingsRate = income > 0 ? (investment / income) * 100 : 0;

      // legacy
      const expense = living + debt + ledgerInvestment;

      result.push({
        month: m,
        income: round2(income),
        living: round2(living),
        debt: round2(debt),
        investment: round2(investment),
        available: round2(available),
        finalBalance: round2(finalBalance),
        savingsRate: round2(savingsRate),
        // legacy keys for older charts
        expense: round2(expense),
        savings: round2(savingsContribution),
      });
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error("Dashboard Trend Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

export default router;