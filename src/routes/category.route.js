import { Router } from "express";
import Category from "../models/Category.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

const router = Router();

// list
router.get("/", requireAuth, requireFamily, async (req, res) => {
  const { kind } = req.query; // income / expense
  const filter = { familyId: req.familyId };
  if (kind) filter.kind = kind;

  const items = await Category.find(filter).sort({ kind: 1, name: 1 });
  res.json({ ok: true, items });
});

// create
router.post("/", requireAuth, requireFamily, async (req, res) => {
  const { kind, name, financialType } = req.body || {};
  if (!kind || !name) return res.status(400).json({ ok: false, message: "Missing fields" });

  const item = await Category.create({
    familyId: req.familyId,
    kind,
    ...(financialType ? { financialType } : {}),
    name: name.trim(),
  });

  res.json({ ok: true, item });
});

// update
router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  const { name, isActive, financialType } = req.body || {};

  const item = await Category.findOneAndUpdate(
    { _id: req.params.id, familyId: req.familyId },
    {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(financialType !== undefined ? { financialType } : {}),
    },
    { new: true }
  );

  if (!item) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({ ok: true, item });
});

// delete
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  const item = await Category.findOneAndDelete({ _id: req.params.id, familyId: req.familyId });
  if (!item) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({ ok: true });
});

export default router;