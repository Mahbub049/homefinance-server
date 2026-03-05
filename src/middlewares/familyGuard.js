import FamilyMember from "../models/FamilyMember.js";

export async function requireFamily(req, res, next) {
  const member = await FamilyMember.findOne({ userId: req.user.userId });
  if (!member) return res.status(400).json({ ok: false, message: "You are not in a family" });

  req.familyId = member.familyId.toString();
  next();
}