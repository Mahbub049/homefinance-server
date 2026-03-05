import { Router } from "express";
import crypto from "crypto";
import Family from "../models/Family.js";
import FamilyMember from "../models/FamilyMember.js";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

function makeInviteCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 chars
}

// Get my family (if joined)
router.get("/me", requireAuth, async (req, res) => {
  const member = await FamilyMember.findOne({ userId: req.user.userId });
  if (!member) return res.json({ ok: true, family: null });

  const family = await Family.findById(member.familyId);
  res.json({ ok: true, family });
});

// Create family (only once)
router.post("/create", requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, message: "Family name required" });

  const already = await FamilyMember.findOne({ userId: req.user.userId });
  if (already) return res.status(400).json({ ok: false, message: "You already joined a family" });

  let inviteCode = makeInviteCode();
  // ensure unique
  while (await Family.findOne({ inviteCode })) inviteCode = makeInviteCode();

  const family = await Family.create({
    name,
    inviteCode,
    createdBy: req.user.userId,
  });

  await FamilyMember.create({
    familyId: family._id,
    userId: req.user.userId,
    role: "admin",
  });

  res.json({ ok: true, family });
});

// Join family by invite code
router.post("/join", requireAuth, async (req, res) => {
  const { inviteCode } = req.body || {};
  if (!inviteCode) return res.status(400).json({ ok: false, message: "Invite code required" });

  const already = await FamilyMember.findOne({ userId: req.user.userId });
  if (already) return res.status(400).json({ ok: false, message: "You already joined a family" });

  const family = await Family.findOne({ inviteCode: inviteCode.toUpperCase().trim() });
  if (!family) return res.status(404).json({ ok: false, message: "Family not found" });

  await FamilyMember.create({
    familyId: family._id,
    userId: req.user.userId,
    role: "member",
  });

  res.json({ ok: true, family });
});

router.get("/members", requireAuth, async (req, res) => {
  const member = await FamilyMember.findOne({ userId: req.user.userId });
  if (!member) return res.status(400).json({ ok: false, message: "Not in a family" });

  const members = await FamilyMember.find({ familyId: member.familyId }).populate("userId", "name email");
  res.json({
    ok: true,
    members: members.map((m) => ({
      id: m.userId._id,
      name: m.userId.name,
      email: m.userId.email,
      role: m.role,
    })),
  });
});

export default router;