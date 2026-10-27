import { Router } from "express";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import MonthlyBalance from "../models/MonthlyBalance.js";
import CreditCardStatement from "../models/CreditCardStatement.js";
import { parseOpeningBalance, guardHistoricalAccountUpdate, sensitiveAccountChanges } from "../utils/accountHistoryRules.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

const router = Router();

// list
router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const items = await Account.find({ familyId: req.familyId }).sort({
      owner: 1,
      name: 1,
    });

    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e?.message || "Failed to load accounts",
    });
  }
});

// create
router.post("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const { name, type, owner, openingBalance, isActive } = req.body || {};

    const cleanName = String(name || "").trim();
    const cleanOwner = owner || "Joint";

    if (!cleanName) {
      return res.status(400).json({
        ok: false,
        message: "Account name required",
      });
    }

    const parsedOpening = openingBalance === undefined ? 0 : parseOpeningBalance(openingBalance);
    const existing = await Account.findOne({
      familyId: req.familyId,
      owner: cleanOwner,
      name: cleanName,
    });

    if (existing) {
      return res.status(409).json({
        ok: false,
        message: `${cleanOwner} already has an account named "${cleanName}"`,
      });
    }

    const item = await Account.create({
      familyId: req.familyId,
      name: cleanName,
      type: type || "bank",
      owner: cleanOwner,
      openingBalance: parsedOpening,
      isActive: typeof isActive === "boolean" ? isActive : true,
    });

    res.status(201).json({ ok: true, item });
  } catch (e) {
    if (e?.status === 400 || e?.status === 409) {
      return res.status(e.status).json({ ok: false, message: e.message, fields: e.fields || [] });
    }
    if (e?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "This owner already has an account with this name",
      });
    }

    res.status(500).json({
      ok: false,
      message: e?.message || "Create failed",
    });
  }
});

// update
router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, owner, openingBalance, isActive } = req.body || {};

    const current = await Account.findOne({
      _id: id,
      familyId: req.familyId,
    });

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: "Account not found",
      });
    }

    const nextName =
      name !== undefined ? String(name || "").trim() : current.name;

    const nextOwner = owner !== undefined ? owner : current.owner;
    const nextOpening = openingBalance !== undefined ? parseOpeningBalance(openingBalance) : undefined;
    if (isActive !== undefined && typeof isActive !== "boolean") {
      return res.status(400).json({ ok: false, message: "isActive must be true or false" });
    }

    if (!nextName) {
      return res.status(400).json({
        ok: false,
        message: "Account name required",
      });
    }

    const duplicate = await Account.findOne({
      _id: { $ne: id },
      familyId: req.familyId,
      owner: nextOwner,
      name: nextName,
    });

    if (duplicate) {
      return res.status(409).json({
        ok: false,
        message: `${nextOwner} already has an account named "${nextName}"`,
      });
    }

    // Before touching a historic account, prohibit changes that silently
    // rewrite Wallet, settlement attribution, saved savings or prior closings.
    const changes = sensitiveAccountChanges(current, { type, owner, openingBalance: nextOpening });
    if (changes.length) {
      const [transactionHistory, savedClosingHistory, cardSnapshotHistory] = await Promise.all([
        Transaction.exists({ familyId: req.familyId, $or: [
          { fromAccountId: current._id }, { toAccountId: current._id },
          { "paymentParts.accountId": current._id },
        ] }),
        MonthlyBalance.exists({ familyId: req.familyId, $or: [
          { "accountsOpening.accountId": current._id }, { "accountsClosing.accountId": current._id },
        ] }),
        CreditCardStatement.exists({ familyId: req.familyId, accountId: current._id }),
      ]);
      guardHistoricalAccountUpdate(current, { type, owner, openingBalance: nextOpening },
        Boolean(transactionHistory || savedClosingHistory || cardSnapshotHistory));
    }

    current.name = nextName;
    if (type !== undefined) current.type = type;
    if (owner !== undefined) current.owner = owner;
    if (nextOpening !== undefined) current.openingBalance = nextOpening;
    if (isActive !== undefined) current.isActive = isActive;

    await current.save();

    res.json({ ok: true, item: current });
  } catch (e) {
    if (e?.status === 400 || e?.status === 409) {
      return res.status(e.status).json({ ok: false, message: e.message, fields: e.fields || [] });
    }
    if (e?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "This owner already has an account with this name",
      });
    }

    res.status(500).json({
      ok: false,
      message: e?.message || "Update failed",
    });
  }
});

// delete
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const { id } = req.params;

    const account = await Account.findOne({ _id: id, familyId: req.familyId });
    if (!account) return res.status(404).json({ ok: false, message: "Account not found" });

    // A hard delete makes historic cash reconciliation impossible. Keep linked
    // accounts as inactive instead; they remain visible in financial statements.
    const [hasTransaction, hasSnapshot] = await Promise.all([
      Transaction.exists({ familyId: req.familyId, $or: [
        { fromAccountId: id }, { toAccountId: id }, { "paymentParts.accountId": id },
      ] }),
      MonthlyBalance.exists({ familyId: req.familyId, $or: [
        { "accountsOpening.accountId": id }, { "accountsClosing.accountId": id },
      ] }),
    ]);
    if (hasTransaction || hasSnapshot || Math.abs(Number(account.openingBalance || 0)) > 0.009) {
      return res.status(409).json({
        ok: false,
        message: "This account has financial history or an opening balance. Set it to inactive instead of deleting it, so Wallet and Carry Forward stay accurate.",
      });
    }
    await account.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e?.message || "Delete failed",
    });
  }
});

export default router;