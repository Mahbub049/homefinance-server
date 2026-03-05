import { Router } from "express";
import PaymentMethod from "../models/PaymentMethod.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

const router = Router();

router.get("/", requireAuth, requireFamily, async (req, res) => {
  const items = await PaymentMethod.find({ familyId: req.familyId }).sort({ name: 1 });
  res.json({ ok: true, items });
});

router.post("/", requireAuth, requireFamily, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, message: "Name required" });

  const item = await PaymentMethod.create({ familyId: req.familyId, name: name.trim() });
  res.json({ ok: true, item });
});

router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  const { name, isActive } = req.body || {};
  const item = await PaymentMethod.findOneAndUpdate(
    { _id: req.params.id, familyId: req.familyId },
    { ...(name !== undefined ? { name: name.trim() } : {}), ...(isActive !== undefined ? { isActive } : {}) },
    { new: true }
  );
  if (!item) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({ ok: true, item });
});

router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  const item = await PaymentMethod.findOneAndDelete({ _id: req.params.id, familyId: req.familyId });
  if (!item) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({ ok: true });
});

export default router;