import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import XLSX from "xlsx";

import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

router.get("/monthly-summary", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ ok: false, message: "month required" });

  const members = await FamilyMember.find({ familyId: req.familyId }).populate("userId", "name email");
  const users = members.map((m) => ({ id: String(m.userId._id), name: m.userId.name }));

  const entries = await LedgerEntry.find({ familyId: req.familyId, month })
    .populate("categoryId", "name kind")
    .sort({ date: 1 });

  const entryIds = entries.map((e) => e._id);
  const splits = await Split.find({ familyId: req.familyId, ledgerEntryId: { $in: entryIds } });

  // splits map
  const splitByEntry = {};
  for (const s of splits) {
    const k = String(s.ledgerEntryId);
    if (!splitByEntry[k]) splitByEntry[k] = [];
    splitByEntry[k].push({ userId: String(s.userId), shareAmount: Number(s.shareAmount || 0) });
  }

  // compute totals
  let income = 0, expense = 0, savings = 0;
  const perUser = {};
  for (const u of users) perUser[u.id] = { name: u.name, income: 0, expense: 0, savings: 0 };

  const catMap = {}; // expense by category

  const entryRows = entries.map((e) => {
    const ss = splitByEntry[String(e._id)] || [];
    const shareText = ss
      .map((x) => {
        const u = users.find((uu) => uu.id === x.userId);
        return `${u ? u.name : x.userId}: ${round2(x.shareAmount)}`;
      })
      .join(" | ");

    if (e.entryType === "income") income += Number(e.amountTotal || 0);
    else {
      expense += Number(e.amountTotal || 0);
      const cat = e.categoryId?.name || "Other";
      catMap[cat] = (catMap[cat] || 0) + Number(e.amountTotal || 0);
    }

    if (e.module === "savings") savings += Number(e.amountTotal || 0);

    for (const s of ss) {
      if (!perUser[s.userId]) continue;
      if (e.entryType === "income") perUser[s.userId].income += s.shareAmount;
      else perUser[s.userId].expense += s.shareAmount;
      if (e.module === "savings") perUser[s.userId].savings += s.shareAmount;
    }

    return {
      Date: new Date(e.date).toISOString().slice(0, 10),
      Type: e.entryType,
      Module: e.module,
      Category: e.categoryId?.name || "-",
      Total: round2(e.amountTotal),
      Split: shareText,
      Note: e.note || "",
    };
  });

  const summaryRows = [
    { Metric: "Family Income", Value: round2(income) },
    { Metric: "Family Expense", Value: round2(expense) },
    { Metric: "Family Savings", Value: round2(savings) },
    { Metric: "Family Balance", Value: round2(income - expense) },
  ];

  for (const u of users) {
    const pu = perUser[u.id];
    summaryRows.push({ Metric: `${u.name} Income`, Value: round2(pu.income) });
    summaryRows.push({ Metric: `${u.name} Expense`, Value: round2(pu.expense) });
    summaryRows.push({ Metric: `${u.name} Savings`, Value: round2(pu.savings) });
    summaryRows.push({ Metric: `${u.name} Balance`, Value: round2(pu.income - pu.expense) });
  }

  const categoryRows = Object.entries(catMap)
    .map(([name, total]) => ({ Category: name, Total: round2(total) }))
    .sort((a, b) => b.Total - a.Total);

  // workbook
  const wb = XLSX.utils.book_new();

  const ws1 = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, ws1, "Summary");

  const ws2 = XLSX.utils.json_to_sheet(categoryRows);
  XLSX.utils.book_append_sheet(wb, ws2, "Expense_By_Category");

  const ws3 = XLSX.utils.json_to_sheet(entryRows);
  XLSX.utils.book_append_sheet(wb, ws3, "Entries");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Disposition", `attachment; filename="Monthly_Summary_${month}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

export default router;