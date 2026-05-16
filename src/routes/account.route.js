import { Router } from "express";
import Account from "../models/Account.js";
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
      openingBalance: Number(openingBalance || 0),
      isActive: typeof isActive === "boolean" ? isActive : true,
    });

    res.status(201).json({ ok: true, item });
  } catch (e) {
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

    current.name = nextName;

    if (type !== undefined) current.type = type;
    if (owner !== undefined) current.owner = owner;
    if (openingBalance !== undefined) {
      current.openingBalance = Number(openingBalance || 0);
    }
    if (isActive !== undefined) {
      current.isActive = !!isActive;
    }

    await current.save();

    res.json({ ok: true, item: current });
  } catch (e) {
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

    const deleted = await Account.findOneAndDelete({
      _id: id,
      familyId: req.familyId,
    });

    if (!deleted) {
      return res.status(404).json({
        ok: false,
        message: "Account not found",
      });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e?.message || "Delete failed",
    });
  }
});

export default router;