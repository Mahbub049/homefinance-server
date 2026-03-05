import { Router } from "express";
import CardLabel from "../models/CardLabel.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

const router = Router();

router.get("/", requireAuth, requireFamily, async (req, res) => {
  const items = await CardLabel.find({ familyId: req.familyId }).sort({ label: 1 });
  res.json({ ok: true, items });
});

router.post("/", requireAuth, requireFamily, async (req, res) => {
  const { label, last4 } = req.body || {};
  if (!label) return res.status(400).json({ ok: false, message: "Label required" });

  const item = await CardLabel.create({
    familyId: req.familyId,
    label: label.trim(),
    last4: (last4 || "").trim(),
  });

  res.json({ ok: true, item });
});

router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  const { label, last4, isActive } = req.body || {};
  const item = await CardLabel.findOneAndUpdate(
    { _id: req.params.id, familyId: req.familyId },
    {
      ...(label !== undefined ? { label: label.trim() } : {}),
      ...(last4 !== undefined ? { last4: (last4 || "").trim() } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    },
    { new: true }
  );

  if (!item) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({ ok: true, item });
});

router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  const item = await CardLabel.findOneAndDelete({ _id: req.params.id, familyId: req.familyId });
  if (!item) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({ ok: true });
});

export default router;