import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireFamily } from "../middlewares/familyGuard.js";
import PlannedPurchase from "../models/PlannedPurchase.js";
import FamilyMember from "../models/FamilyMember.js";

const router = Router();

function normalizePriority(priority) {
  return ["high", "medium", "low"].includes(priority) ? priority : "medium";
}

function normalizeOwnershipType(ownershipType) {
  return ["personal", "shared"].includes(ownershipType)
    ? ownershipType
    : "shared";
}

function normalizePaymentMode(paymentMode) {
  return ["undecided", "cash", "emi", "either"].includes(paymentMode)
    ? paymentMode
    : "undecided";
}

function normalizeStatus(status) {
  return ["planned", "bought", "cancelled"].includes(status)
    ? status
    : "planned";
}

async function validatePersonalForUserId({ familyId, ownershipType, personalForUserId }) {
  if (ownershipType !== "personal") {
    return { ok: true, personalForUserId: null };
  }

  if (!personalForUserId) {
    return {
      ok: false,
      message: "Please select who this personal purchase is for",
    };
  }

  const member = await FamilyMember.findOne({
    familyId,
    userId: personalForUserId,
  });

  if (!member) {
    return {
      ok: false,
      message: "Selected personal member does not belong to this family",
    };
  }

  return { ok: true, personalForUserId };
}

/**
 * GET /api/planned-purchases
 */
router.get("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const items = await PlannedPurchase.find({ familyId: req.familyId }).sort({
      status: 1,
      sortOrder: 1,
      createdAt: -1,
    });

    return res.json({
      ok: true,
      items,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Failed to load planned purchases",
    });
  }
});

/**
 * POST /api/planned-purchases
 */
router.post("/", requireAuth, requireFamily, async (req, res) => {
  try {
    const {
      productName,
      category,
      brand,
      expectedPrice,
      productLink,
      notes,
      priority,
      ownershipType,
      personalForUserId,
      paymentMode,
    } = req.body || {};

    if (!String(productName || "").trim()) {
      return res.status(400).json({
        ok: false,
        message: "Product name is required",
      });
    }

    const normalizedOwnershipType = normalizeOwnershipType(ownershipType);
    const personalValidation = await validatePersonalForUserId({
      familyId: req.familyId,
      ownershipType: normalizedOwnershipType,
      personalForUserId,
    });

    if (!personalValidation.ok) {
      return res.status(400).json({
        ok: false,
        message: personalValidation.message,
      });
    }

    const existingCount = await PlannedPurchase.countDocuments({
      familyId: req.familyId,
      status: "planned",
    });

    const item = await PlannedPurchase.create({
      familyId: req.familyId,
      productName: String(productName).trim(),
      category: String(category || "").trim(),
      brand: String(brand || "").trim(),
      expectedPrice: Number(expectedPrice || 0),
      productLink: String(productLink || "").trim(),
      notes: String(notes || "").trim(),
      priority: normalizePriority(priority),
      ownershipType: normalizedOwnershipType,
      personalForUserId: personalValidation.personalForUserId,
      paymentMode: normalizePaymentMode(paymentMode),
      status: "planned",
      sortOrder: existingCount + 1,
      createdByUserId: req.user?.userId || null,
    });

    return res.status(201).json({
      ok: true,
      message: "Planned purchase created successfully",
      item,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Failed to create planned purchase",
    });
  }
});

/**
 * PUT /api/planned-purchases/:id
 */
router.put("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const { id } = req.params;

    const item = await PlannedPurchase.findOne({
      _id: id,
      familyId: req.familyId,
    });

    if (!item) {
      return res.status(404).json({
        ok: false,
        message: "Planned purchase not found",
      });
    }

    const {
      productName,
      category,
      brand,
      expectedPrice,
      productLink,
      notes,
      priority,
      ownershipType,
      personalForUserId,
      paymentMode,
      status,
    } = req.body || {};

    if (!String(productName || "").trim()) {
      return res.status(400).json({
        ok: false,
        message: "Product name is required",
      });
    }

    const normalizedOwnershipType = normalizeOwnershipType(ownershipType);
    const personalValidation = await validatePersonalForUserId({
      familyId: req.familyId,
      ownershipType: normalizedOwnershipType,
      personalForUserId,
    });

    if (!personalValidation.ok) {
      return res.status(400).json({
        ok: false,
        message: personalValidation.message,
      });
    }

    item.productName = String(productName).trim();
    item.category = String(category || "").trim();
    item.brand = String(brand || "").trim();
    item.expectedPrice = Number(expectedPrice || 0);
    item.productLink = String(productLink || "").trim();
    item.notes = String(notes || "").trim();
    item.priority = normalizePriority(priority);
    item.ownershipType = normalizedOwnershipType;
    item.personalForUserId = personalValidation.personalForUserId;
    item.paymentMode = normalizePaymentMode(paymentMode);
    item.status = normalizeStatus(status);

    await item.save();

    return res.json({
      ok: true,
      message: "Planned purchase updated successfully",
      item,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Failed to update planned purchase",
    });
  }
});

/**
 * PATCH /api/planned-purchases/reorder
 */
router.patch("/reorder", requireAuth, requireFamily, async (req, res) => {
  try {
    const { orderedIds } = req.body || {};

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "orderedIds array is required",
      });
    }

    const items = await PlannedPurchase.find({
      familyId: req.familyId,
      status: "planned",
      _id: { $in: orderedIds },
    }).select("_id");

    if (items.length !== orderedIds.length) {
      return res.status(400).json({
        ok: false,
        message: "Some planned items were not found",
      });
    }

    const bulkOps = orderedIds.map((id, index) => ({
      updateOne: {
        filter: {
          _id: id,
          familyId: req.familyId,
          status: "planned",
        },
        update: {
          $set: {
            sortOrder: index + 1,
          },
        },
      },
    }));

    if (bulkOps.length > 0) {
      await PlannedPurchase.bulkWrite(bulkOps);
    }

    return res.json({
      ok: true,
      message: "Planned purchase order updated successfully",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Failed to reorder planned purchases",
    });
  }
});

/**
 * PATCH /api/planned-purchases/:id/mark-bought
 */
router.patch("/:id/mark-bought", requireAuth, requireFamily, async (req, res) => {
  try {
    const { id } = req.params;

    const item = await PlannedPurchase.findOne({
      _id: id,
      familyId: req.familyId,
    });

    if (!item) {
      return res.status(404).json({
        ok: false,
        message: "Planned purchase not found",
      });
    }

    item.status = "bought";
    item.sortOrder = 0;
    await item.save();

    const remainingPlanned = await PlannedPurchase.find({
      familyId: req.familyId,
      status: "planned",
    }).sort({ sortOrder: 1, createdAt: -1 });

    const reorderOps = remainingPlanned.map((plannedItem, index) => ({
      updateOne: {
        filter: { _id: plannedItem._id },
        update: { $set: { sortOrder: index + 1 } },
      },
    }));

    if (reorderOps.length > 0) {
      await PlannedPurchase.bulkWrite(reorderOps);
    }

    return res.json({
      ok: true,
      message: "Item marked as bought",
      item,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Failed to mark item as bought",
    });
  }
});

/**
 * PATCH /api/planned-purchases/:id/mark-planned
 */
router.patch("/:id/mark-planned", requireAuth, requireFamily, async (req, res) => {
  try {
    const { id } = req.params;

    const item = await PlannedPurchase.findOne({
      _id: id,
      familyId: req.familyId,
    });

    if (!item) {
      return res.status(404).json({
        ok: false,
        message: "Planned purchase not found",
      });
    }

    const plannedCount = await PlannedPurchase.countDocuments({
      familyId: req.familyId,
      status: "planned",
    });

    item.status = "planned";
    item.sortOrder = plannedCount + 1;
    await item.save();

    return res.json({
      ok: true,
      message: "Item moved back to active planned list",
      item,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Failed to move item back to planned list",
    });
  }
});

/**
 * DELETE /api/planned-purchases/:id
 */
router.delete("/:id", requireAuth, requireFamily, async (req, res) => {
  try {
    const { id } = req.params;

    const item = await PlannedPurchase.findOneAndDelete({
      _id: id,
      familyId: req.familyId,
    });

    if (!item) {
      return res.status(404).json({
        ok: false,
        message: "Planned purchase not found",
      });
    }

    if (item.status === "planned") {
      const remainingPlanned = await PlannedPurchase.find({
        familyId: req.familyId,
        status: "planned",
      }).sort({ sortOrder: 1, createdAt: -1 });

      const reorderOps = remainingPlanned.map((plannedItem, index) => ({
        updateOne: {
          filter: { _id: plannedItem._id },
          update: { $set: { sortOrder: index + 1 } },
        },
      }));

      if (reorderOps.length > 0) {
        await PlannedPurchase.bulkWrite(reorderOps);
      }
    }

    return res.json({
      ok: true,
      message: "Planned purchase deleted successfully",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Failed to delete planned purchase",
    });
  }
});

export default router;