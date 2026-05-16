import { Router } from "express";
import GroceryShop from "../models/GroceryShop.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";

const router = Router();

// GET /api/grocery-shops
router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const items = await GroceryShop.find({
      familyId: req.familyId,
      isActive: { $ne: false },
    }).sort({ name: 1, location: 1 });

    res.json({ ok: true, items });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error?.message || "Failed to load grocery shops",
    });
  }
});

// POST /api/grocery-shops
router.post("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const { name, location } = req.body || {};

    if (!String(name || "").trim()) {
      return res.status(400).json({
        ok: false,
        message: "Shop name required",
      });
    }

    const item = await GroceryShop.create({
      familyId: req.familyId,
      name: String(name || "").trim(),
      location: String(location || "").trim(),
    });

    res.json({ ok: true, item });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "This shop already exists",
      });
    }

    res.status(500).json({
      ok: false,
      message: error?.message || "Failed to create grocery shop",
    });
  }
});

// PUT /api/grocery-shops/:id
router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const { name, location, isActive } = req.body || {};

    if (name !== undefined && !String(name || "").trim()) {
      return res.status(400).json({
        ok: false,
        message: "Shop name required",
      });
    }

    const updateData = {};

    if (name !== undefined) {
      updateData.name = String(name || "").trim();
    }

    if (location !== undefined) {
      updateData.location = String(location || "").trim();
    }

    if (isActive !== undefined) {
      updateData.isActive = Boolean(isActive);
    }

    const item = await GroceryShop.findOneAndUpdate(
      {
        _id: req.params.id,
        familyId: req.familyId,
      },
      updateData,
      { new: true }
    );

    if (!item) {
      return res.status(404).json({
        ok: false,
        message: "Grocery shop not found",
      });
    }

    res.json({ ok: true, item });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "This shop already exists",
      });
    }

    res.status(500).json({
      ok: false,
      message: error?.message || "Failed to update grocery shop",
    });
  }
});

// DELETE /api/grocery-shops/:id
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const item = await GroceryShop.findOneAndDelete({
      _id: req.params.id,
      familyId: req.familyId,
    });

    if (!item) {
      return res.status(404).json({
        ok: false,
        message: "Grocery shop not found",
      });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error?.message || "Failed to delete grocery shop",
    });
  }
});

export default router;