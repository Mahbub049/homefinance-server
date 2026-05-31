import { Router } from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Account from "../models/Account.js";
import FamilyMember from "../models/FamilyMember.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import TaxRecord from "../models/TaxRecord.js";
import Transaction from "../models/Transaction.js";

const router = Router();

const RECORD_TYPES = [
  "income",
  "rebate",
  "asset",
  "liability",
  "tax_paid",
  "business_expense",
  "document",
  "note",
];

function cleanId(value) {
  if (!value) return null;
  if (typeof value === "object") return value._id || value.id || null;
  return value;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function parseYearStart(input) {
  const n = Number(input);
  const now = new Date();
  const fallback = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;

  if (!Number.isInteger(n) || n < 2000 || n > 2100) return fallback;
  return n;
}

function taxYearRange(yearStart) {
  return {
    start: new Date(yearStart, 6, 1, 0, 0, 0, 0), // 1 July
    end: new Date(yearStart + 1, 5, 30, 23, 59, 59, 999), // 30 June
    label: `${yearStart}-${yearStart + 1}`,
  };
}

function monthKey(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthsInTaxYear(yearStart) {
  const months = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const d = new Date(yearStart, 6 + offset, 1);
    months.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      income: 0,
      expenditure: 0,
      rebate: 0,
      taxPaid: 0,
    });
  }
  return months;
}

function addToMap(map, key, amount, extra = {}) {
  const safeKey = key || "Uncategorized";
  const current = map.get(safeKey) || { name: safeKey, total: 0, count: 0, ...extra };
  current.total = round2(Number(current.total || 0) + Number(amount || 0));
  current.count = Number(current.count || 0) + 1;
  map.set(safeKey, current);
}

function isAllMembers(memberId) {
  return !memberId || memberId === "all" || memberId === "family";
}

function memberNameMap(members) {
  return new Map(
    members.map((m) => [String(cleanId(m.userId)), String(m.userId?.name || "").trim().toLowerCase()])
  );
}

function accountMatchesMember(account, selectedMemberId, namesByUserId) {
  if (isAllMembers(selectedMemberId)) return true;

  const owner = String(account?.owner || "").trim().toLowerCase();
  if (!owner || ["joint", "shared", "family"].includes(owner)) return true;

  const memberName = String(namesByUserId.get(String(selectedMemberId)) || "").trim().toLowerCase();
  if (!memberName) return false;

  const parts = memberName.split(/\s+/).filter(Boolean);
  return memberName.includes(owner) || owner.includes(memberName) || parts.some((part) => owner.includes(part) || part.includes(owner));
}

function normalizedRecord(input = {}, fallbackDate) {
  const recordType = String(input.recordType || "").trim();
  const amount = round2(input.amount);
  const date = input.date ? new Date(input.date) : fallbackDate;

  return {
    recordType,
    title: String(input.title || "").trim(),
    category: String(input.category || "").trim(),
    institution: String(input.institution || "").trim(),
    amount: Number.isFinite(amount) ? amount : 0,
    proofRef: String(input.proofRef || "").trim(),
    note: String(input.note || "").trim(),
    date,
    userId: cleanId(input.userId),
  };
}

async function getMembers(familyId) {
  return FamilyMember.find({ familyId })
    .populate("userId", "name email")
    .sort({ createdAt: 1 })
    .lean();
}

async function calculateAccountBalances({ familyId, endDate, selectedMemberId, members }) {
  const namesByUserId = memberNameMap(members);
  const accounts = await Account.find({ familyId, isActive: { $ne: false } }).sort({ owner: 1, type: 1, name: 1 }).lean();
  const accountById = new Map(accounts.map((a) => [String(a._id), a]));
  const balances = new Map(accounts.map((a) => [String(a._id), round2(a.openingBalance)]));

  const txs = await Transaction.find({ familyId, date: { $lte: endDate } })
    .select("txType amount fromAccountId toAccountId paymentMode paymentParts date")
    .lean();

  function add(accountId, delta) {
    if (!accountId) return;
    const key = String(accountId);
    if (!balances.has(key)) return;
    balances.set(key, round2(Number(balances.get(key) || 0) + Number(delta || 0)));
  }

  for (const tx of txs) {
    const amount = Number(tx.amount || 0);
    if (tx.txType === "income") {
      add(tx.toAccountId, amount);
    } else if (tx.txType === "transfer") {
      add(tx.fromAccountId, -amount);
      add(tx.toAccountId, amount);
    } else if (tx.txType === "expense") {
      if (tx.paymentMode === "split" && Array.isArray(tx.paymentParts) && tx.paymentParts.length) {
        for (const part of tx.paymentParts) {
          add(part.accountId, -Number(part.amount || 0));
        }
      } else {
        add(tx.fromAccountId, -amount);
      }
    }
  }

  const assetAccounts = [];
  let totalAssets = 0;

  for (const account of accounts) {
    if (!accountMatchesMember(account, selectedMemberId, namesByUserId)) continue;

    const balance = round2(balances.get(String(account._id)) || 0);
    const item = {
      id: account._id,
      name: account.name,
      owner: account.owner,
      type: account.type,
      balance,
      isTaxAsset: ["cash", "bank", "wallet", "savings", "investment"].includes(String(account.type || "")),
    };

    assetAccounts.push(item);
    if (item.isTaxAsset) totalAssets = round2(totalAssets + balance);
  }

  return { totalAssets, assetAccounts };
}

async function buildTaxSummary({ familyId, yearStart, selectedMemberId }) {
  const range = taxYearRange(yearStart);
  const members = await getMembers(familyId);
  const namesByUserId = memberNameMap(members);
  const selectedAll = isAllMembers(selectedMemberId);
  const selectedMemberObjectId = !selectedAll && mongoose.Types.ObjectId.isValid(selectedMemberId)
    ? new mongoose.Types.ObjectId(selectedMemberId)
    : null;

  const monthlyTrend = monthsInTaxYear(yearStart);
  const trendByMonth = new Map(monthlyTrend.map((m) => [m.month, m]));

  const totals = {
    income: 0,
    annualExpenditure: 0,
    businessExpense: 0,
    rebateEligible: 0,
    taxPaid: 0,
    manualIncome: 0,
    manualRebate: 0,
    manualAssets: 0,
    manualLiabilities: 0,
    assets: 0,
    liabilities: 0,
    netWorth: 0,
    cashSurplus: 0,
  };

  const incomeByCategory = new Map();
  const expenseByCategory = new Map();
  const expenseByFinancialType = new Map();
  const rebateByCategory = new Map();
  const topExpenseItems = [];
  const rebateCandidates = [];

  const entries = await LedgerEntry.find({
    familyId,
    date: { $gte: range.start, $lte: range.end },
  })
    .populate("categoryId", "name kind financialType")
    .populate("paidByUserId", "name")
    .populate("receivedByUserId", "name")
    .sort({ date: -1, createdAt: -1 })
    .lean();

  const entryIds = entries.map((e) => e._id);
  const splits = entryIds.length
    ? await Split.find({ familyId, ledgerEntryId: { $in: entryIds } }).populate("userId", "name").lean()
    : [];

  const splitMap = new Map();
  for (const s of splits) {
    const key = String(s.ledgerEntryId);
    if (!splitMap.has(key)) splitMap.set(key, []);
    splitMap.get(key).push(s);
  }

  for (const entry of entries) {
    const categoryName = entry.categoryId?.name || "Uncategorized";
    const financialType = entry.financialType || entry.categoryId?.financialType || (entry.entryType === "income" ? "income" : "living");
    const mk = entry.month || monthKey(entry.date);
    const trendRow = trendByMonth.get(mk);

    if (entry.entryType === "income") {
      if (!selectedAll && String(cleanId(entry.receivedByUserId)) !== String(selectedMemberId)) continue;

      const amount = round2(entry.amountTotal);
      totals.income = round2(totals.income + amount);
      addToMap(incomeByCategory, categoryName, amount);
      if (trendRow) trendRow.income = round2(trendRow.income + amount);
      continue;
    }

    if (entry.entryType === "expense") {
      let amount = round2(entry.amountTotal);

      if (!selectedAll) {
        const entrySplits = splitMap.get(String(entry._id)) || [];
        amount = round2(
          entrySplits
            .filter((s) => String(cleanId(s.userId)) === String(selectedMemberId))
            .reduce((sum, s) => sum + Number(s.shareAmount || 0), 0)
        );
      }

      if (amount <= 0) continue;

      totals.annualExpenditure = round2(totals.annualExpenditure + amount);
      addToMap(expenseByCategory, categoryName, amount, { financialType });
      addToMap(expenseByFinancialType, financialType, amount);
      if (trendRow) trendRow.expenditure = round2(trendRow.expenditure + amount);

      topExpenseItems.push({
        id: entry._id,
        date: entry.date,
        title: entry.note || categoryName,
        category: categoryName,
        financialType,
        amount,
        sourceType: entry.sourceType || entry.module || "ledger",
      });

      if (financialType === "investment") {
        totals.rebateEligible = round2(totals.rebateEligible + amount);
        addToMap(rebateByCategory, categoryName, amount);
        if (trendRow) trendRow.rebate = round2(trendRow.rebate + amount);
        rebateCandidates.push({
          id: entry._id,
          date: entry.date,
          title: entry.note || categoryName,
          category: categoryName,
          amount,
          source: "Investment expense category",
        });
      }
    }
  }

  const accounts = await Account.find({ familyId, isActive: { $ne: false } }).lean();
  const accountById = new Map(accounts.map((a) => [String(a._id), a]));

  const transferInvestments = await Transaction.find({
    familyId,
    txType: "transfer",
    date: { $gte: range.start, $lte: range.end },
  })
    .populate("fromAccountId", "name owner type")
    .populate("toAccountId", "name owner type")
    .sort({ date: -1, createdAt: -1 })
    .lean();

  for (const tx of transferInvestments) {
    const toAccount = tx.toAccountId || accountById.get(String(tx.toAccountId));
    const fromAccount = tx.fromAccountId || accountById.get(String(tx.fromAccountId));
    const toType = String(toAccount?.type || "").toLowerCase();

    if (!["savings", "investment"].includes(toType)) continue;

    const memberMatches = selectedAll || accountMatchesMember(toAccount, selectedMemberId, namesByUserId) || accountMatchesMember(fromAccount, selectedMemberId, namesByUserId);
    if (!memberMatches) continue;

    const amount = round2(tx.amount);
    const category = toType === "investment" ? "Investment Account Transfer" : "Savings Account Transfer";
    const mk = tx.month || monthKey(tx.date);
    const trendRow = trendByMonth.get(mk);

    totals.rebateEligible = round2(totals.rebateEligible + amount);
    addToMap(rebateByCategory, category, amount);
    if (trendRow) trendRow.rebate = round2(trendRow.rebate + amount);

    rebateCandidates.push({
      id: tx._id,
      date: tx.date,
      title: `${fromAccount?.name || "Account"} → ${toAccount?.name || "Savings/Investment"}`,
      category,
      amount,
      source: "Transfer to savings/investment account",
    });
  }

  const manualFilter = {
    familyId,
    taxYearStart: yearStart,
  };

  if (!selectedAll && selectedMemberObjectId) {
    manualFilter.userId = selectedMemberObjectId;
  }

  const manualRecords = await TaxRecord.find(manualFilter)
    .populate("userId", "name email")
    .sort({ date: -1, createdAt: -1 })
    .lean();

  for (const record of manualRecords) {
    const amount = round2(record.amount);
    const category = record.category || record.title || record.recordType;
    const mk = monthKey(record.date);
    const trendRow = trendByMonth.get(mk);

    if (record.recordType === "income") {
      totals.income = round2(totals.income + amount);
      totals.manualIncome = round2(totals.manualIncome + amount);
      addToMap(incomeByCategory, category, amount);
      if (trendRow) trendRow.income = round2(trendRow.income + amount);
    }

    if (record.recordType === "rebate") {
      totals.rebateEligible = round2(totals.rebateEligible + amount);
      totals.manualRebate = round2(totals.manualRebate + amount);
      addToMap(rebateByCategory, category, amount);
      if (trendRow) trendRow.rebate = round2(trendRow.rebate + amount);
      rebateCandidates.push({
        id: record._id,
        date: record.date,
        title: record.title,
        category,
        amount,
        source: "Manual tax record",
      });
    }

    if (record.recordType === "business_expense") {
      totals.annualExpenditure = round2(totals.annualExpenditure + amount);
      totals.businessExpense = round2(totals.businessExpense + amount);
      addToMap(expenseByCategory, category, amount, { financialType: "business_expense" });
      addToMap(expenseByFinancialType, "business_expense", amount);
      if (trendRow) trendRow.expenditure = round2(trendRow.expenditure + amount);
      topExpenseItems.push({
        id: record._id,
        date: record.date,
        title: record.title,
        category,
        financialType: "business_expense",
        amount,
        sourceType: "manual_tax_record",
      });
    }

    if (record.recordType === "asset") {
      totals.manualAssets = round2(totals.manualAssets + amount);
    }

    if (record.recordType === "liability") {
      totals.manualLiabilities = round2(totals.manualLiabilities + amount);
    }

    if (record.recordType === "tax_paid") {
      totals.taxPaid = round2(totals.taxPaid + amount);
      if (trendRow) trendRow.taxPaid = round2(trendRow.taxPaid + amount);
    }
  }

  const balanceData = await calculateAccountBalances({
    familyId,
    endDate: range.end,
    selectedMemberId,
    members,
  });

  totals.assets = round2(balanceData.totalAssets + totals.manualAssets);
  totals.liabilities = round2(totals.manualLiabilities);
  totals.netWorth = round2(totals.assets - totals.liabilities);
  totals.cashSurplus = round2(totals.income - totals.annualExpenditure);

  topExpenseItems.sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
  rebateCandidates.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const selectedMember = selectedAll
    ? null
    : members.find((m) => String(cleanId(m.userId)) === String(selectedMemberId)) || null;

  return {
    taxYear: {
      startYear: yearStart,
      label: range.label,
      startDate: range.start,
      endDate: range.end,
    },
    selectedMember: selectedMember
      ? {
          id: cleanId(selectedMember.userId),
          name: selectedMember.userId?.name || "Member",
          email: selectedMember.userId?.email || "",
        }
      : null,
    members: members.map((m) => ({
      id: cleanId(m.userId),
      name: m.userId?.name || "Member",
      email: m.userId?.email || "",
      role: m.role,
    })),
    totals,
    incomeByCategory: Array.from(incomeByCategory.values()).sort((a, b) => b.total - a.total),
    expenseByCategory: Array.from(expenseByCategory.values()).sort((a, b) => b.total - a.total),
    expenseByFinancialType: Array.from(expenseByFinancialType.values()).sort((a, b) => b.total - a.total),
    rebateByCategory: Array.from(rebateByCategory.values()).sort((a, b) => b.total - a.total),
    monthlyTrend,
    topExpenseItems: topExpenseItems.slice(0, 12),
    rebateCandidates: rebateCandidates.slice(0, 25),
    assetAccounts: balanceData.assetAccounts,
    manualRecords,
    checklist: [
      { key: "salary", label: "Salary certificate / income proof", done: totals.income > 0 },
      { key: "bank", label: "Bank statements and account balances", done: balanceData.assetAccounts.length > 0 },
      { key: "rebate", label: "DPS/FDR/savings certificate/life insurance proofs", done: totals.rebateEligible > 0 },
      { key: "taxPaid", label: "TDS / challan / previous tax payment proof", done: totals.taxPaid > 0 },
      { key: "asset", label: "Asset and liability snapshot", done: totals.assets > 0 || totals.liabilities > 0 },
    ],
  };
}

router.get("/summary", requireAuth, requireFamily, async (req, res) => {
  try {
    const yearStart = parseYearStart(req.query.yearStart);
    const memberId = req.query.memberId || "all";
    const summary = await buildTaxSummary({ familyId: req.familyId, yearStart, selectedMemberId: memberId });
    res.json({ ok: true, summary });
  } catch (e) {
    console.error("Tax summary failed", e);
    res.status(500).json({ ok: false, message: e?.message || "Tax summary failed" });
  }
});

router.get("/records", requireAuth, requireFamily, async (req, res) => {
  try {
    const yearStart = parseYearStart(req.query.yearStart);
    const memberId = req.query.memberId || "all";

    const filter = { familyId: req.familyId, taxYearStart: yearStart };
    if (!isAllMembers(memberId) && mongoose.Types.ObjectId.isValid(memberId)) {
      filter.userId = new mongoose.Types.ObjectId(memberId);
    }

    const items = await TaxRecord.find(filter)
      .populate("userId", "name email")
      .sort({ date: -1, createdAt: -1 });

    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Tax records failed" });
  }
});

router.post("/records", requireAuth, requireFamily, async (req, res) => {
  try {
    const yearStart = parseYearStart(req.body?.taxYearStart);
    const range = taxYearRange(yearStart);
    const data = normalizedRecord(req.body, range.start);

    if (!RECORD_TYPES.includes(data.recordType)) {
      return res.status(400).json({ ok: false, message: "Invalid record type" });
    }

    if (!data.title) {
      return res.status(400).json({ ok: false, message: "Title is required" });
    }

    if (Number.isNaN(data.date.getTime())) {
      return res.status(400).json({ ok: false, message: "Invalid date" });
    }

    if (["income", "rebate", "asset", "liability", "tax_paid", "business_expense"].includes(data.recordType) && data.amount <= 0) {
      return res.status(400).json({ ok: false, message: "Amount must be greater than 0" });
    }

    const item = await TaxRecord.create({
      familyId: req.familyId,
      userId: data.userId || null,
      taxYearStart: yearStart,
      date: data.date,
      recordType: data.recordType,
      title: data.title,
      category: data.category,
      institution: data.institution,
      amount: data.amount,
      proofRef: data.proofRef,
      note: data.note,
      createdByUserId: req.user.userId,
    });

    const populated = await TaxRecord.findById(item._id).populate("userId", "name email");
    res.status(201).json({ ok: true, item: populated });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Create tax record failed" });
  }
});

router.put("/records/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const item = await TaxRecord.findOne({ _id: req.params.id, familyId: req.familyId });
    if (!item) return res.status(404).json({ ok: false, message: "Tax record not found" });

    const yearStart = parseYearStart(req.body?.taxYearStart || item.taxYearStart);
    const data = normalizedRecord(req.body, item.date);

    if (!RECORD_TYPES.includes(data.recordType)) {
      return res.status(400).json({ ok: false, message: "Invalid record type" });
    }

    if (!data.title) {
      return res.status(400).json({ ok: false, message: "Title is required" });
    }

    if (Number.isNaN(data.date.getTime())) {
      return res.status(400).json({ ok: false, message: "Invalid date" });
    }

    if (["income", "rebate", "asset", "liability", "tax_paid", "business_expense"].includes(data.recordType) && data.amount <= 0) {
      return res.status(400).json({ ok: false, message: "Amount must be greater than 0" });
    }

    item.userId = data.userId || null;
    item.taxYearStart = yearStart;
    item.date = data.date;
    item.recordType = data.recordType;
    item.title = data.title;
    item.category = data.category;
    item.institution = data.institution;
    item.amount = data.amount;
    item.proofRef = data.proofRef;
    item.note = data.note;
    await item.save();

    const populated = await TaxRecord.findById(item._id).populate("userId", "name email");
    res.json({ ok: true, item: populated });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Update tax record failed" });
  }
});

router.delete("/records/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const item = await TaxRecord.findOne({ _id: req.params.id, familyId: req.familyId });
    if (!item) return res.status(404).json({ ok: false, message: "Tax record not found" });

    await TaxRecord.deleteOne({ _id: item._id, familyId: req.familyId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Delete tax record failed" });
  }
});

export default router;
