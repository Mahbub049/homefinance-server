import { Router } from "express";
import bcrypt from "bcrypt";
import User from "../models/User.js";
import { signToken } from "../utils/jwt.js";

const router = Router();

// Register
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res.status(400).json({ ok: false, message: "Missing fields" });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ ok: false, message: "Email already used" });

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      passwordHash,
    });

    const token = signToken({ userId: user._id });

    res.json({
      ok: true,
      token,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Register failed" });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ ok: false, message: "Missing fields" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ ok: false, message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, message: "Invalid credentials" });

    const token = signToken({ userId: user._id });

    res.json({
      ok: true,
      token,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Login failed" });
  }
});

export default router;