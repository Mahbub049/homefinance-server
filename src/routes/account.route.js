import { Router } from "express";
import Account from "../models/Account.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

const router = Router();

// list
router.get("/", requireAuth, requireFamily, async (req, res) => {
  const items = await Account.find({ familyId: req.familyId }).sort({ name: 1 });
  res.json({ ok: true, items });
});

// create
router.post("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const { name, type, owner, openingBalance, isActive } = req.body || {};
    if (!name || !String(name).trim())
      return res.status(400).json({ ok: false, message: "Account name required" });

    const item = await Account.create({
      familyId: req.familyId,
      name: String(name).trim(),
      type: type || "bank",
      owner: owner || "Joint",
      openingBalance: Number(openingBalance || 0),
      isActive: typeof isActive === "boolean" ? isActive : true,
    });

    res.status(201).json({ ok: true, item });
  } catch (e) {
    if (e?.code === 11000)
      return res.status(409).json({ ok: false, message: "Account already exists" });
    res.status(500).json({ ok: false, message: e?.message || "Create failed" });
  }
});

// update
router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, owner, openingBalance, isActive } = req.body || {};

    const item = await Account.findOneAndUpdate(
      { _id: id, familyId: req.familyId },
      {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(owner !== undefined ? { owner } : {}),
        ...(openingBalance !== undefined ? { openingBalance: Number(openingBalance || 0) } : {}),
        ...(isActive !== undefined ? { isActive: !!isActive } : {}),
      },
      { new: true }
    );

    if (!item) return res.status(404).json({ ok: false, message: "Not found" });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "Update failed" });
  }
});

// delete
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  const { id } = req.params;
  const deleted = await Account.findOneAndDelete({ _id: id, familyId: req.familyId });
  if (!deleted) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({ ok: true });
});

export default router;