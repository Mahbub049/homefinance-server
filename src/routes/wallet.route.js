import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

import Account from "../models/Account.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";
import FamilyMember from "../models/FamilyMember.js";
import Transaction from "../models/Transaction.js";

const router = Router();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function getId(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  return String(v._id || v.id || v);
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
    // -----------------------------
    const expenseEntries = await LedgerEntry.find({
      familyId: req.familyId,
      entryType: "expense",
      month,
    });

    const paidMap = {};
    for (const uid of userIdStrings) paidMap[uid] = 0;

    for (const entry of expenseEntries) {
      const uid = getId(entry.paidByUserId);
      if (uid && paidMap[uid] !== undefined) {
        paidMap[uid] = round2(paidMap[uid] + Number(entry.amountTotal || 0));
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
    // 6) Settlement suggestion for expense sharing only
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

export default router;
