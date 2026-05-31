import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Account from "../models/Account.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Transaction from "../models/Transaction.js";
import Settlement from "../models/Settlement.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function getId(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  return String(v._id || v.id || v);
}

function monthKey(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function buildOwnerToUserId(members = []) {
  const result = { Mahbub: "", Mirza: "", Joint: "" };

  const rows = members
    .map((m) => ({
      id: getId(m.userId),
      name: String(m.userId?.name || "").toLowerCase(),
    }))
    .filter((m) => m.id);

  const findByKeyword = (keyword) =>
    rows.find((m) => m.name.includes(String(keyword).toLowerCase()))?.id || "";

  result.Mahbub = findByKeyword("mahbub");
  result.Mirza = findByKeyword("mirza");

  return result;
}

function participantsForOwner(owner, ownerToUserId, memberIds) {
  const normalizedOwner = owner || "Joint";
  const ownerUserId = ownerToUserId[normalizedOwner] || "";

  // Personal account: full transfer effect belongs to that person.
  if (normalizedOwner !== "Joint" && ownerUserId && memberIds.includes(ownerUserId)) {
    return [{ userId: ownerUserId, ratio: 1 }];
  }

  // Joint or unknown owner: divide equally between family members.
  const count = Math.max(1, memberIds.length);
  return memberIds.map((userId) => ({ userId, ratio: 1 / count }));
}

async function calculateTransferEffects({ familyId, month, members }) {
  const memberIds = members.map((m) => getId(m.userId)).filter(Boolean);
  const ownerToUserId = buildOwnerToUserId(members);

  const effectMap = {};
  for (const userId of memberIds) {
    effectMap[userId] = {
      transferIn: 0,
      transferOut: 0,
      transferNet: 0,
    };
  }

  const [accounts, transfers] = await Promise.all([
    Account.find({ familyId }).select("_id owner name").lean(),
    Transaction.find({ familyId, month, txType: "transfer" })
      .select("amount fromAccountId toAccountId")
      .lean(),
  ]);

  const accountById = new Map(accounts.map((a) => [String(a._id), a]));

  for (const tx of transfers) {
    const amount = Number(tx.amount || 0);
    if (!amount || amount <= 0) continue;

    const fromAccount = accountById.get(getId(tx.fromAccountId));
    const toAccount = accountById.get(getId(tx.toAccountId));

    const fromOwner = fromAccount?.owner || "Joint";
    const toOwner = toAccount?.owner || "Joint";

    // Mahbub -> Mahbub or Mirza -> Mirza or Joint -> Joint:
    // this is only movement between accounts of the same owner.
    // It should not change personal balance.
    if (fromOwner === toOwner) continue;

    const fromParts = participantsForOwner(fromOwner, ownerToUserId, memberIds);
    const toParts = participantsForOwner(toOwner, ownerToUserId, memberIds);

    for (const p of fromParts) {
      if (!effectMap[p.userId]) continue;
      effectMap[p.userId].transferOut = round2(
        effectMap[p.userId].transferOut + amount * p.ratio
      );
    }

    for (const p of toParts) {
      if (!effectMap[p.userId]) continue;
      effectMap[p.userId].transferIn = round2(
        effectMap[p.userId].transferIn + amount * p.ratio
      );
    }
  }

  for (const userId of Object.keys(effectMap)) {
    effectMap[userId].transferNet = round2(
      effectMap[userId].transferIn - effectMap[userId].transferOut
    );
  }

  return effectMap;
}

function normalizeSettlement(doc) {
  const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;

  return {
    _id: plain._id,
    month: plain.month,
    date: plain.date,
    fromUserId: plain.fromUserId,
    toUserId: plain.toUserId,
    fromAccountId: plain.fromAccountId,
    toAccountId: plain.toAccountId,
    amount: round2(plain.amount || 0),
    settlementType: plain.settlementType,
    status: plain.status,
    note: plain.note || "",
    transactionId: plain.transactionId || null,
    affectsWallet: !!plain.affectsWallet,
    affectsLedger: !!plain.affectsLedger,
    affectsMonthlySettlement: !!plain.affectsMonthlySettlement,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

function buildSettlementInfo({ resultUsers, settlements }) {
  const byUser = new Map();

  for (const u of resultUsers) {
    byUser.set(String(u.userId), {
      userId: u.userId,
      name: u.name,
      net: round2(u.net || 0),
      shouldPay: u.net < 0 ? round2(Math.abs(u.net)) : 0,
      shouldReceive: u.net > 0 ? round2(u.net) : 0,
      settledPaid: 0,
      settledReceived: 0,
      pastMarkedPaid: 0,
      pastMarkedReceived: 0,
      pendingPay: u.net < 0 ? round2(Math.abs(u.net)) : 0,
      pendingReceive: u.net > 0 ? round2(u.net) : 0,
      status: u.net === 0 ? "settled" : "pending",
    });
  }

  for (const s of settlements) {
    if (s.status !== "settled") continue;

    const amount = round2(s.amount || 0);
    const fromId = getId(s.fromUserId);
    const toId = getId(s.toUserId);

    if (s.affectsMonthlySettlement) {
      if (byUser.has(fromId)) {
        byUser.get(fromId).settledPaid = round2(byUser.get(fromId).settledPaid + amount);
      }
      if (byUser.has(toId)) {
        byUser.get(toId).settledReceived = round2(byUser.get(toId).settledReceived + amount);
      }
    } else if (s.settlementType === "past_pending") {
      if (byUser.has(fromId)) {
        byUser.get(fromId).pastMarkedPaid = round2(byUser.get(fromId).pastMarkedPaid + amount);
      }
      if (byUser.has(toId)) {
        byUser.get(toId).pastMarkedReceived = round2(byUser.get(toId).pastMarkedReceived + amount);
      }
    }
  }

  const summary = Array.from(byUser.values()).map((row) => {
    const pendingPay = round2(Math.max(0, Number(row.shouldPay || 0) - Number(row.settledPaid || 0)));
    const pendingReceive = round2(Math.max(0, Number(row.shouldReceive || 0) - Number(row.settledReceived || 0)));

    return {
      ...row,
      pendingPay,
      pendingReceive,
      status: pendingPay <= 0.009 && pendingReceive <= 0.009 ? "settled" : "pending",
    };
  });

  const requiredTotal = round2(summary.reduce((sum, row) => sum + Number(row.shouldPay || 0), 0));
  const monthlySettled = round2(summary.reduce((sum, row) => sum + Number(row.settledPaid || 0), 0));
  const pendingTotal = round2(summary.reduce((sum, row) => sum + Number(row.pendingPay || 0), 0));
  const pastPendingSettled = round2(
    settlements
      .filter((s) => s.status === "settled" && s.settlementType === "past_pending")
      .reduce((sum, s) => sum + Number(s.amount || 0), 0)
  );

  let settlement = null;

  if (resultUsers.length === 2) {
    const payer = summary.find((row) => row.shouldPay > 0);
    const receiver = summary.find((row) => row.shouldReceive > 0);
    const amount = round2(Math.min(payer?.pendingPay || 0, receiver?.pendingReceive || 0));

    if (payer && receiver && amount > 0.009) {
      settlement = {
        fromUserId: payer.userId,
        toUserId: receiver.userId,
        amount,
      };
    }
  }

  return {
    settlement,
    settlementSummary: summary,
    settlementTotals: {
      requiredTotal,
      monthlySettled,
      pendingTotal,
      pastPendingSettled,
    },
  };
}

// GET /api/wallet/summary?month=YYYY-MM
router.get("/summary", requireAuth, requireFamily, async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();
    if (!month) {
      return res.status(400).json({ ok: false, message: "month required" });
    }

    const members = await FamilyMember.find({ familyId: req.familyId }).populate(
      "userId",
      "name email"
    );

    const userIds = members.map((m) => m.userId?._id).filter(Boolean);
    const userIdStrings = userIds.map((id) => String(id));

    // -----------------------------
    // 1) Income received per user
    // -----------------------------
    const incomeEntries = await LedgerEntry.find({
      familyId: req.familyId,
      entryType: "income",
      month,
    });

    const incomeMap = {};
    for (const uid of userIdStrings) incomeMap[uid] = 0;

    for (const entry of incomeEntries) {
      const uid = getId(entry.receivedByUserId);
      if (uid && incomeMap[uid] !== undefined) {
        incomeMap[uid] = round2(incomeMap[uid] + Number(entry.amountTotal || 0));
      }
    }

    // -----------------------------
    // 2) Expense paid per user
    //    Single payment: count the transaction amount for the selected payer.
    //    Split payment: count each payment part for the member who actually paid it.
    // -----------------------------
    const [expenseEntries, expenseTransactions] = await Promise.all([
      LedgerEntry.find({
        familyId: req.familyId,
        entryType: "expense",
        month,
      }),
      Transaction.find({
        familyId: req.familyId,
        txType: "expense",
        month,
      }).select("amount paidByUserId paymentMode paymentParts"),
    ]);

    const paidMap = {};
    for (const uid of userIdStrings) paidMap[uid] = 0;

    for (const tx of expenseTransactions) {
      const parts = Array.isArray(tx.paymentParts) ? tx.paymentParts : [];

      if (tx.paymentMode === "split" && parts.length > 0) {
        for (const part of parts) {
          const uid = getId(part.userId);
          if (uid && paidMap[uid] !== undefined) {
            paidMap[uid] = round2(paidMap[uid] + Number(part.amount || 0));
          }
        }
      } else {
        const uid = getId(tx.paidByUserId);
        if (uid && paidMap[uid] !== undefined) {
          paidMap[uid] = round2(paidMap[uid] + Number(tx.amount || 0));
        }
      }
    }

    // -----------------------------
    // 3) Expense share per user
    // -----------------------------
    const expenseEntryIds = expenseEntries.map((e) => e._id);

    const splits = await Split.find({
      familyId: req.familyId,
      ledgerEntryId: { $in: expenseEntryIds },
    });

    const shareMap = {};
    for (const uid of userIdStrings) shareMap[uid] = 0;

    for (const s of splits) {
      const uid = getId(s.userId);
      if (!uid || shareMap[uid] === undefined) continue;
      shareMap[uid] = round2(shareMap[uid] + Number(s.shareAmount || 0));
    }

    // -----------------------------
    // 4) Owner-aware transfer effect
    // -----------------------------
    const transferMap = await calculateTransferEffects({
      familyId: req.familyId,
      month,
      members,
    });

    // -----------------------------
    // 5) Build result
    // -----------------------------
    const resultUsers = [];

    for (const m of members) {
      const uid = getId(m.userId);
      if (!uid) continue;

      const income = round2(incomeMap[uid] || 0);
      const paid = round2(paidMap[uid] || 0);
      const share = round2(shareMap[uid] || 0);

      const transferIn = round2(transferMap[uid]?.transferIn || 0);
      const transferOut = round2(transferMap[uid]?.transferOut || 0);
      const transferNet = round2(transferIn - transferOut);

      // Settlement net keeps the original expense-sharing meaning:
      // positive = paid more than share; negative = paid less than share.
      const net = round2(paid - share);

      // Personal remaining includes owner-aware transfers:
      // same-owner transfer = 0 effect; cross-owner transfer changes balance.
      const remaining = round2(income - share + transferNet);

      // Cash-style view: income minus actual paid amount plus transfer net.
      const cashAfterPaid = round2(income - paid + transferNet);

      resultUsers.push({
        userId: uid,
        name: m.userId.name,
        income,
        paidExpense: paid,
        shareExpense: share,
        transferIn,
        transferOut,
        transferNet,
        net,
        remaining,
        cashAfterPaid,
      });
    }

    // -----------------------------
    // 6) Settlement records + pending suggestion
    // -----------------------------
    const settlements = (
      await Settlement.find({ familyId: req.familyId, month })
        .sort({ date: -1, createdAt: -1 })
        .populate("fromUserId", "name email")
        .populate("toUserId", "name email")
        .populate("fromAccountId", "name owner type")
        .populate("toAccountId", "name owner type")
        .lean()
    ).map(normalizeSettlement);

    const settlementInfo = buildSettlementInfo({ resultUsers, settlements });

    res.json({
      ok: true,
      month,
      users: resultUsers,
      settlement: settlementInfo.settlement,
      settlementSummary: settlementInfo.settlementSummary,
      settlementTotals: settlementInfo.settlementTotals,
      settlements,
      transferLogic: {
        sameOwner: "ignored",
        crossOwner: "from owner decreases, to owner increases",
        jointOwner: "shared equally among family members",
      },
    });
  } catch (err) {
    console.error("Wallet Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

// POST /api/wallet/settlements
// body for wallet settlement:
// { settlementType:"wallet", date, fromUserId, toUserId, amount, fromAccountId, toAccountId, note }
// body for past pending mark:
// { settlementType:"past_pending", date, fromUserId, toUserId, amount, note }
router.post("/settlements", requireAuth, requireFamily, async (req, res) => {
  try {
    const {
      settlementType = "wallet",
      date,
      fromUserId,
      toUserId,
      amount,
      fromAccountId,
      toAccountId,
      note,
    } = req.body || {};

    if (!["wallet", "past_pending"].includes(settlementType)) {
      return res.status(400).json({ ok: false, message: "Invalid settlement type" });
    }

    const amt = Number(amount || 0);
    if (!amt || amt <= 0) {
      return res.status(400).json({ ok: false, message: "Amount must be > 0" });
    }

    const dt = date ? new Date(date) : new Date();
    if (Number.isNaN(dt.getTime())) {
      return res.status(400).json({ ok: false, message: "Invalid date" });
    }

    const month = monthKey(dt);

    if (!fromUserId || !toUserId) {
      return res.status(400).json({ ok: false, message: "From and To member are required" });
    }

    if (String(fromUserId) === String(toUserId)) {
      return res.status(400).json({ ok: false, message: "From and To member must be different" });
    }

    const members = await FamilyMember.find({ familyId: req.familyId }).select("userId").lean();
    const memberIds = members.map((m) => String(m.userId));

    if (!memberIds.includes(String(fromUserId)) || !memberIds.includes(String(toUserId))) {
      return res.status(400).json({ ok: false, message: "Invalid family member selected" });
    }

    let transaction = null;

    if (settlementType === "wallet") {
      if (!fromAccountId || !toAccountId) {
        return res.status(400).json({ ok: false, message: "From and To accounts are required" });
      }

      if (String(fromAccountId) === String(toAccountId)) {
        return res.status(400).json({ ok: false, message: "From and To accounts must be different" });
      }

      const accounts = await Account.find({
        _id: { $in: [fromAccountId, toAccountId] },
        familyId: req.familyId,
      }).lean();

      if (accounts.length !== 2) {
        return res.status(400).json({ ok: false, message: "Invalid account selected" });
      }

      transaction = await Transaction.create({
        familyId: req.familyId,
        txType: "transfer",
        date: dt,
        month,
        categoryId: null,
        amount: amt,
        note: `[Settlement] ${(note || "Monthly settlement").trim()}`,
        fromAccountId,
        toAccountId,
        paidByUserId: null,
        receivedByUserId: null,
        createdByUserId: req.user.userId,
      });
    }

    const item = await Settlement.create({
      familyId: req.familyId,
      month,
      date: dt,
      fromUserId,
      toUserId,
      amount: amt,
      settlementType,
      status: "settled",
      fromAccountId: settlementType === "wallet" ? fromAccountId : null,
      toAccountId: settlementType === "wallet" ? toAccountId : null,
      transactionId: transaction?._id || null,
      affectsWallet: settlementType === "wallet",
      affectsLedger: settlementType === "wallet",
      affectsMonthlySettlement: settlementType === "wallet",
      note: (note || "").trim(),
      createdByUserId: req.user.userId,
    });

    res.status(201).json({ ok: true, item, transactionId: transaction?._id || null });
  } catch (err) {
    console.error("Create settlement error:", err);
    res.status(500).json({ ok: false, message: err?.message || "Create settlement failed" });
  }
});

// DELETE /api/wallet/settlements/:id
// If the settlement created a transfer transaction, this also removes that transfer.
router.delete("/settlements/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const item = await Settlement.findOne({ _id: req.params.id, familyId: req.familyId });
    if (!item) return res.status(404).json({ ok: false, message: "Settlement not found" });

    let removedTransaction = false;

    if (item.transactionId) {
      const ledgerEntries = await LedgerEntry.find({
        familyId: req.familyId,
        sourceId: item.transactionId,
      }).select("_id");

      for (const le of ledgerEntries) {
        await Split.deleteMany({ familyId: req.familyId, ledgerEntryId: le._id });
        await LedgerEntry.deleteOne({ _id: le._id, familyId: req.familyId });
      }

      const txDelete = await Transaction.deleteOne({ _id: item.transactionId, familyId: req.familyId });
      removedTransaction = txDelete.deletedCount > 0;
    }

    await Settlement.deleteOne({ _id: item._id, familyId: req.familyId });

    res.json({ ok: true, removedTransaction });
  } catch (err) {
    console.error("Delete settlement error:", err);
    res.status(500).json({ ok: false, message: err?.message || "Delete settlement failed" });
  }
});

export default router;
