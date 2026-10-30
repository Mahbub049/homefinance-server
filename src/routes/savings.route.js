import { Router } from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import FamilyMember from "../models/FamilyMember.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import User from "../models/User.js";
import { verifySavingsPosting } from '../utils/postingPreflight.js';
import { positiveMoney } from '../utils/postingRules.js';
import { requireOpenMonth } from '../utils/postingPreflight.js';
import { existingFinancialPosting, createIdempotentFinancialPosting } from '../utils/idempotentFinancialPosting.js';

import SavingsAutoRule from '../models/SavingsAutoRule.js';
import SavingsAutoExecution from '../models/SavingsAutoExecution.js';
import {runSavingsAuto} from '../utils/runSavingsAuto.js';
import {bdClock} from '../utils/savingsAutoRules.js';
const router = Router();

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

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month, amount) {
  const p = parseMonth(month);
  if (!p) return null;

  const d = new Date(p.y, p.m - 1 + amount, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function lastMonths(endMonth, count = 12) {
  const validEnd = parseMonth(endMonth) ? endMonth : currentMonth();
  const start = addMonths(validEnd, -(count - 1));
  const months = [];

  for (let i = 0; i < count; i++) {
    months.push(addMonths(start, i));
  }

  return months.filter(Boolean);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/* =========================================================
   Savings V2

   Savings is NOT an expense.
   Savings deposit = Transfer transaction.
   Example: EBL Account -> TBL DPS Account

   Endpoints:
   GET  /api/savings/accounts
   GET  /api/savings/overview?month=YYYY-MM
   GET  /api/savings/yearly-summary?endMonth=YYYY-MM
   POST /api/savings/deposit
========================================================= */

// List only savings/investment accounts
router.get("/accounts", requireAuth, requireFamily, async (req, res) => {
  const items = await Account.find({
    familyId: req.familyId,
    type: { $in: ["savings", "investment"] },
  }).sort({ name: 1 });

  res.json({ ok: true, items });
});

// Overview: savings account balances + this-month in/out
router.get("/overview", requireAuth, requireFamily, async (req, res) => {
  const { month } = req.query;

  if (!month) {
    return res.status(400).json({
      ok: false,
      message: "month is required",
    });
  }

  const monthEnd = endOfMonthDate(month);

  if (!monthEnd) {
    return res.status(400).json({
      ok: false,
      message: "Invalid month",
    });
  }

  const savingsAccounts = await Account.find({
    familyId: req.familyId,
    type: { $in: ["savings", "investment"] },
  }).sort({ name: 1 });

  const ids = savingsAccounts.map((a) => a._id);

  if (ids.length === 0) {
    return res.json({
      ok: true,
      month,
      totals: {
        deposited: 0,
        withdrawn: 0,
        net: 0,
        totalBalance: 0,
      },
      accounts: [],
    });
  }

  const touchingMatch = {
    familyId: new mongoose.Types.ObjectId(req.familyId),
    txType: "transfer",
    date: { $lte: monthEnd },
    $or: [
      { fromAccountId: { $in: ids } },
      { toAccountId: { $in: ids } },
    ],
  };

  const rows = await Transaction.aggregate([
    { $match: touchingMatch },
    {
      $project: {
        fromAccountId: 1,
        toAccountId: 1,
        amount: 1,
        month: 1,
        inAcc: {
          $cond: [{ $in: ["$toAccountId", ids] }, "$toAccountId", null],
        },
        outAcc: {
          $cond: [{ $in: ["$fromAccountId", ids] }, "$fromAccountId", null],
        },
      },
    },
    {
      $facet: {
        balance: [
          {
            $project: {
              pairs: [
                { acc: "$inAcc", amt: "$amount" },
                { acc: "$outAcc", amt: { $multiply: ["$amount", -1] } },
              ],
            },
          },
          { $unwind: "$pairs" },
          { $match: { "pairs.acc": { $ne: null } } },
          {
            $group: {
              _id: "$pairs.acc",
              net: { $sum: "$pairs.amt" },
            },
          },
        ],

        monthTotals: [
          { $match: { month } },
          {
            $project: {
              toSavings: {
                $cond: [{ $in: ["$toAccountId", ids] }, true, false],
              },
              fromSavings: {
                $cond: [{ $in: ["$fromAccountId", ids] }, true, false],
              },
              amount: 1,
            },
          },
          {
            $group: {
              _id: null,
              deposited: {
                // Savings → Savings is an internal move, NOT new saving.
                $sum: { $cond: [{ $and: ["$toSavings", { $not: ["$fromSavings"] }] }, "$amount", 0] },
              },
              withdrawn: {
                $sum: { $cond: [{ $and: ["$fromSavings", { $not: ["$toSavings"] }] }, "$amount", 0] },
              },
            },
          },
        ],

        monthByAccount: [
          { $match: { month } },
          {
            $project: {
              pairs: [
                {
                  acc: {
                    $cond: [{ $in: ["$toAccountId", ids] }, "$toAccountId", null],
                  },
                  dep: "$amount",
                  wdr: 0,
                },
                {
                  acc: {
                    $cond: [{ $in: ["$fromAccountId", ids] }, "$fromAccountId", null],
                  },
                  dep: 0,
                  wdr: "$amount",
                },
              ],
            },
          },
          { $unwind: "$pairs" },
          { $match: { "pairs.acc": { $ne: null } } },
          {
            $group: {
              _id: "$pairs.acc",
              deposited: { $sum: "$pairs.dep" },
              withdrawn: { $sum: "$pairs.wdr" },
            },
          },
        ],
      },
    },
  ]);

  const balanceMap = new Map();

  for (const r of rows?.[0]?.balance || []) {
    balanceMap.set(String(r._id), r.net);
  }

  const monthMap = new Map();

  for (const r of rows?.[0]?.monthByAccount || []) {
    monthMap.set(String(r._id), {
      deposited: r.deposited || 0,
      withdrawn: r.withdrawn || 0,
    });
  }

  const mt = rows?.[0]?.monthTotals?.[0] || {
    deposited: 0,
    withdrawn: 0,
  };

  const totals = {
    deposited: mt.deposited || 0,
    withdrawn: mt.withdrawn || 0,
    net: (mt.deposited || 0) - (mt.withdrawn || 0),
    totalBalance: 0,
  };

  const accounts = savingsAccounts.map((a) => {
    const netTransfers = balanceMap.get(String(a._id)) || 0;
    const currentBalance =
      Number(a.openingBalance || 0) + Number(netTransfers || 0);

    totals.totalBalance += currentBalance;

    const ms = monthMap.get(String(a._id)) || {
      deposited: 0,
      withdrawn: 0,
    };

    return {
      _id: a._id,
      name: a.name,
      type: a.type,
      owner: a.owner,
      openingBalance: a.openingBalance || 0,
      currentBalance,
      monthDeposited: ms.deposited,
      monthWithdrawn: ms.withdrawn,
    };
  });

  res.json({
    ok: true,
    month,
    totals,
    accounts,
  });
});

router.get("/yearly-summary", requireAuth, requireFamily, async (req, res) => {
  try {
    const endMonth = String(req.query.endMonth || currentMonth()).trim();
    const months = lastMonths(endMonth, 12);

    if (!months.length) {
      return res.status(400).json({
        ok: false,
        message: "Invalid month range",
      });
    }

    const allAccounts = await Account.find({
      familyId: req.familyId,
      isActive: true,
    })
      .select("_id name owner type")
      .lean();

    const ownerNames = Array.from(
      new Set(
        allAccounts
          .map((account) => String(account.owner || "").trim())
          .filter((owner) => owner && owner.toLowerCase() !== "joint")
      )
    );

    const output = new Map();

    for (const owner of ownerNames) {
      output.set(owner, {
        id: `owner:${owner}`,
        name: owner,
        owner,
        totalCashSaved: 0,
        totalSaved: 0,
        months: months.map((month) => ({
          month,
          income: 0,
          expense: 0,
          transferIn: 0,
          transferOut: 0,
          transferNet: 0,
          monthlySaved: 0,
          cumulativeSaved: 0,

          // old aliases so frontend will not break
          saved: 0,
          withdrawn: 0,
          netSaved: 0,
          totalBeforeSaving: 0,
          remainingAfterSavings: 0,
        })),
      });
    }

    const monthIndex = new Map(months.map((month, index) => [month, index]));

    function getRealOwner(owner) {
      const clean = String(owner || "").trim();
      if (!clean) return "";
      if (clean.toLowerCase() === "joint") return "Joint";

      const matched = ownerNames.find(
        (item) => item.toLowerCase() === clean.toLowerCase()
      );

      return matched || clean;
    }

    function ownerParts(owner) {
      const realOwner = getRealOwner(owner);

      if (!realOwner) return [];

      if (realOwner === "Joint") {
        if (ownerNames.length === 0) return [];
        const ratio = 1 / ownerNames.length;
        return ownerNames.map((name) => ({
          owner: name,
          ratio,
        }));
      }

      if (!output.has(realOwner)) return [];

      return [{ owner: realOwner, ratio: 1 }];
    }

    function addOwnerAmount(owner, month, field, amount, ratio = 1) {
      const realOwner = getRealOwner(owner);
      const member = output.get(realOwner);
      const index = monthIndex.get(month);

      if (!member || index === undefined) return;

      member.months[index][field] += Number(amount || 0) * Number(ratio || 1);
    }

    function addUserAmount(userId, month, field, amount) {
      const userIdText = String(userId || "");

      if (!userIdText) return;

      const matchedOwner = ownerNames.find((owner) =>
        userIdText.toLowerCase().includes(owner.toLowerCase())
      );

      if (matchedOwner) {
        addOwnerAmount(matchedOwner, month, field, amount);
      }
    }

    const familyMembers = await FamilyMember.find({
      familyId: req.familyId,
    })
      .populate("userId", "name email")
      .lean();

    const userIdToOwner = new Map();

    for (const member of familyMembers || []) {
      const user = member.userId || {};
      const userId = String(user._id || member.userId || "");
      const name = String(user.name || "").toLowerCase();

      const matchedOwner = ownerNames.find((owner) =>
        name.includes(owner.toLowerCase())
      );

      if (userId && matchedOwner) {
        userIdToOwner.set(userId, matchedOwner);
      }
    }

    function addByUserId(userId, month, field, amount) {
      const owner = userIdToOwner.get(String(userId || ""));
      if (!owner) return;

      addOwnerAmount(owner, month, field, amount);
    }

    const ledgerEntries = await LedgerEntry.find({
      familyId: req.familyId,
      month: { $in: months },
      entryType: { $in: ["income", "expense"] },
    })
      .select("_id month entryType amountTotal paidByUserId receivedByUserId")
      .lean();

    const ledgerIds = ledgerEntries.map((entry) => entry._id);

    const splitRows = ledgerIds.length
      ? await Split.find({
        familyId: req.familyId,
        ledgerEntryId: { $in: ledgerIds },
      })
        .select("ledgerEntryId userId shareAmount")
        .lean()
      : [];

    const splitMap = new Map();

    for (const row of splitRows) {
      const key = String(row.ledgerEntryId);

      if (!splitMap.has(key)) {
        splitMap.set(key, []);
      }

      splitMap.get(key).push(row);
    }

    for (const entry of ledgerEntries) {
      const splits = splitMap.get(String(entry._id)) || [];
      const field = entry.entryType === "income" ? "income" : "expense";

      if (splits.length > 0) {
        for (const split of splits) {
          addByUserId(split.userId, entry.month, field, split.shareAmount);
        }
      } else {
        const fallbackUserId =
          entry.entryType === "income"
            ? entry.receivedByUserId
            : entry.paidByUserId;

        addByUserId(fallbackUserId, entry.month, field, entry.amountTotal);
      }
    }

    const accountMap = new Map(
      allAccounts.map((account) => [String(account._id), account])
    );

    const transfers = await Transaction.find({
      familyId: req.familyId,
      txType: "transfer",
      month: { $in: months },
    })
      .select("month amount fromAccountId toAccountId")
      .lean();

    for (const tx of transfers) {
      const amount = Number(tx.amount || 0);

      const fromAccount = accountMap.get(String(tx.fromAccountId));
      const toAccount = accountMap.get(String(tx.toAccountId));

      const fromOwner = getRealOwner(fromAccount?.owner);
      const toOwner = getRealOwner(toAccount?.owner);

      if (!fromOwner || !toOwner || fromOwner === toOwner) {
        continue;
      }

      for (const part of ownerParts(fromOwner)) {
        addOwnerAmount(
          part.owner,
          tx.month,
          "transferOut",
          amount,
          part.ratio
        );
      }

      for (const part of ownerParts(toOwner)) {
        addOwnerAmount(
          part.owner,
          tx.month,
          "transferIn",
          amount,
          part.ratio
        );
      }
    }

    const members = Array.from(output.values()).map((member) => {
      let cumulativeSaved = 0;

      member.months = member.months.map((item) => {
        const transferNet =
          Number(item.transferIn || 0) - Number(item.transferOut || 0);

        const monthlySaved =
          Number(item.income || 0) -
          Number(item.expense || 0) +
          transferNet;

        cumulativeSaved += monthlySaved;

        return {
          ...item,
          income: round2(item.income),
          expense: round2(item.expense),
          transferIn: round2(item.transferIn),
          transferOut: round2(item.transferOut),
          transferNet: round2(transferNet),
          monthlySaved: round2(monthlySaved),
          cumulativeSaved: round2(cumulativeSaved),

          // compatibility aliases
          saved: round2(monthlySaved),
          withdrawn: monthlySaved < 0 ? round2(Math.abs(monthlySaved)) : 0,
          netSaved: round2(monthlySaved),
          totalBeforeSaving: round2(Number(item.income || 0) + transferNet),
          remainingAfterSavings: round2(cumulativeSaved),
        };
      });

      member.totalCashSaved = round2(cumulativeSaved);
      member.totalSaved = round2(cumulativeSaved);

      return member;
    });

    res.json({
      ok: true,
      endMonth: months[months.length - 1],
      startMonth: months[0],
      months,
      members,
    });
  } catch (e) {
    console.error("Savings yearly summary error:", e);

    res.status(500).json({
      ok: false,
      message: e?.message || "Savings yearly summary failed",
    });
  }
});

// Scheduled savings setup; no banking API is connected.
router.get('/auto/rules',requireAuth,requireFamily,async(req,res)=>{
  const items=await SavingsAutoRule.find({familyId:req.familyId}).sort({createdAt:-1}).lean();
  res.json({ok:true,items});
});
router.post('/auto/rules',requireAuth,requireFamily,async(req,res)=>{
  try {
    const {paidByUserId,fromAccountId,toAccountId,amount,dayOfMonth,startMonth,endMonth,note}=req.body||{};
    const day=Number(dayOfMonth), amt=Number(amount);
    if(!Number.isInteger(day)||day<1||day>31||!Number.isFinite(amt)||amt<=0||!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(startMonth))||(endMonth&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(endMonth)))||(endMonth&&endMonth<startMonth))
      return res.status(400).json({ok:false,message:'টাকা, তারিখ বা মেয়াদ সঠিক নয়।'});
    if(String(startMonth)<bdClock().monthKey) return res.status(409).json({ok:false,message:'অতীতের মাস থেকে স্বয়ংক্রিয় এন্ট্রি চালু করা যাবে না।'});
    if(String(startMonth)===bdClock().monthKey && day<bdClock().day) return res.status(409).json({ok:false,message:'এই মাসের নির্ধারিত দিন পার হয়ে গেছে; পরের মাস থেকে নিয়ম শুরু করুন।'});
    await verifySavingsPosting({familyId:req.familyId,date:new Date(`${startMonth}-15T12:00:00.000Z`),paidByUserId,fromAccountId,toAccountId,amount:amt});
    const item=await SavingsAutoRule.create({familyId:req.familyId,paidByUserId,fromAccountId,toAccountId,amount:amt,dayOfMonth:day,startMonth,endMonth:endMonth||'',note:String(note||'').trim(),createdByUserId:req.user.userId});
    res.status(201).json({ok:true,item});
  }catch(error){res.status(error.status||500).json({ok:false,message:error.message||'নিয়ম সংরক্ষণ হয়নি।'});}
});
router.patch('/auto/rules/:id',requireAuth,requireFamily,async(req,res)=>{
  try {
    // Pause/resume only. Historical executed transfers are preserved.
    if(typeof req.body?.active!=='boolean') return res.status(400).json({ok:false,message:'চালু বা বন্ধ নির্বাচন করুন।'});
    const item=await SavingsAutoRule.findOneAndUpdate({familyId:req.familyId,_id:req.params.id},{$set:{active:req.body.active}},{new:true});
    if(!item)return res.status(404).json({ok:false,message:'নিয়ম পাওয়া যায়নি।'});
    res.json({ok:true,item});
  }catch(error){res.status(500).json({ok:false,message:error.message});}
});
router.delete('/auto/rules/:id',requireAuth,requireFamily,async(req,res)=>{
  const item=await SavingsAutoRule.findOne({familyId:req.familyId,_id:req.params.id});
  if(!item)return res.status(404).json({ok:false,message:'নিয়ম পাওয়া যায়নি।'});
  const used=await SavingsAutoExecution.exists({familyId:req.familyId,ruleId:item._id});
  if(used){item.active=false;await item.save();return res.json({ok:true,archived:true});}
  await item.deleteOne();res.json({ok:true});
});
router.get('/auto/history',requireAuth,requireFamily,async(req,res)=>{
  const rows=await SavingsAutoExecution.find({familyId:req.familyId}).sort({createdAt:-1}).limit(36).lean();
  res.json({ok:true,items:rows});
});
// Keep this endpoint private. It runs only from a protected external daily scheduler.
router.get('/auto/run',async(req,res)=>{
  const secret=process.env.CRON_SECRET;
  if(!secret||req.get('Authorization')!==`Bearer ${secret}`)return res.status(401).json({ok:false,message:'Unauthorized'});
  try {res.json({ok:true,...await runSavingsAuto()});}
  catch(error){res.status(500).json({ok:false,message:error.message});}
});

router.get('/deposits',requireAuth,requireFamily,async(req,res)=>{
  const rows=await Transaction.find({familyId:req.familyId,txType:'transfer',sourceType:{$in:['savings_deposit','savings_auto']}}).sort({date:-1}).limit(80).populate('fromAccountId','name').populate('toAccountId','name').lean();
  res.json({ok:true,items:rows});
});
router.delete('/deposits/:id',requireAuth,requireFamily,async(req,res)=>{
  try {
    const tx=await Transaction.findOne({_id:req.params.id,familyId:req.familyId});
    if(!tx||tx.txType!=='transfer'||!['savings_deposit','savings_auto'].includes(tx.sourceType))return res.status(404).json({ok:false,message:'এই সঞ্চয় এন্ট্রি ফেরত নেওয়া যাবে না।'});
    if(tx.month<bdClock().monthKey||tx.month<'2026-10')return res.status(409).json({ok:false,message:'আগের মাসের এন্ট্রি পরিবর্তন করা যাবে না।'});
    await requireOpenMonth(req.familyId,tx.month);
    await mongoose.connection.transaction(async session=>{
      const exists=await Transaction.findOne({_id:tx._id,familyId:req.familyId}).session(session);
      if(!exists)throw new Error('এন্ট্রি ইতিমধ্যে মুছে গেছে।');
      if(tx.sourceType==='savings_auto'){
        // Keep execution record as a tombstone so cron does not post again.
        const audit=await SavingsAutoExecution.findOne({familyId:req.familyId,transactionId:tx._id}).session(session);
        if(!audit)throw new Error('স্বয়ংক্রিয় এন্ট্রির ইতিহাস নেই; পরিবর্তন বাতিল।');
      }
      await Transaction.deleteOne({_id:tx._id,familyId:req.familyId}).session(session);
    });
    res.json({ok:true});
  }catch(error){res.status(error.status||500).json({ok:false,message:error.message||'এন্ট্রি ফেরত নেওয়া যায়নি।'});}
});

// Manual deposit as a transfer
router.post("/deposit", requireAuth, requireFamily, async (req, res) => {
  try {
    const replay = await existingFinancialPosting(req, 'savings.deposit');
    if (replay) {
      const item = await Transaction.findOne({ _id: replay.resultId, familyId: req.familyId });
      if (!item) return res.status(409).json({ ok: false, message: 'This deposit was already recorded, but its transaction was later removed. Review transaction history.' });
      return res.status(200).json({ ok: true, item, replayed: true });
    }
    const {
      paidByUserId,
      date,
      fromAccountId,
      toAccountId,
      amount,
      note,
    } = req.body || {};

    const d = new Date(date || Date.now());

    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({
        ok: false,
        message: "Invalid date",
      });
    }

    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}`;

    const amt = Number(amount);

    try { positiveMoney(amt, 'Deposit'); }
    catch (error) { return res.status(error.status || 400).json({ ok: false, message: error.message }); }

    if (!fromAccountId || !toAccountId) {
      return res.status(400).json({
        ok: false,
        message: "From & To accounts required",
      });
    }

    if (String(fromAccountId) === String(toAccountId)) {
      return res.status(400).json({
        ok: false,
        message: "From and To accounts must be different",
      });
    }

    const [fromAcc, toAcc] = await Promise.all([
      Account.findOne({
        _id: fromAccountId,
        familyId: req.familyId,
        isActive: true,
      }),
      Account.findOne({
        _id: toAccountId,
        familyId: req.familyId,
        isActive: true,
      }),
    ]);

    if (!fromAcc || !toAcc) {
      return res.status(400).json({
        ok: false,
        message: "Invalid account selection",
      });
    }

    if (!["cash", "bank", "wallet"].includes(fromAcc.type)) {
      return res.status(400).json({
        ok: false,
        message: "From account must be a cash, bank, or wallet account",
      });
    }

    if (!["savings", "investment"].includes(toAcc.type)) {
      return res.status(400).json({
        ok: false,
        message: "To account must be a savings or investment account",
      });
    }

    // The original transfer is the only financial record: never add an expense
    // Ledger row or a second savings transaction for this same deposit.
    try {
      await verifySavingsPosting({ familyId: req.familyId, date: d, paidByUserId,
        fromAccountId, toAccountId, amount: amt });
    } catch (error) {
      return res.status(error.status || 400).json({ ok: false, message: error.message });
    }

    const result = await createIdempotentFinancialPosting(req, 'savings.deposit', async () => {
      await requireOpenMonth(req.familyId, month);
      const item = await Transaction.create({
      familyId: req.familyId,
      txType: "transfer",
      budgetImpact: false,
      ledgerEligible: false,
      settlementImpact: false,
      sourceType: 'savings_deposit',
      date: d,
      month,
      categoryId: null,
      amount: amt,
      note: String(note || "").trim(),
      fromAccountId,
      toAccountId,
      paidByUserId: paidByUserId || null,
      receivedByUserId: null,
      createdByUserId: req.user.userId,
      });
      return item._id;
    });
    const item = await Transaction.findOne({ _id: result.resultId, familyId: req.familyId });
    if (!item) throw new Error('Deposit was saved but could not be loaded; please refresh');
    res.status(result.replayed ? 200 : 201).json({ ok: true, item, replayed: result.replayed });
  } catch (e) {
    res.status(e?.status || 500).json({
      ok: false,
      message: e?.message || "Deposit failed",
    });
  }
});

export default router;