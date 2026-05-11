import { Router } from "express";
import bcrypt from "bcrypt";
import User from "../models/User.js";
import { signToken } from "../utils/jwt.js";

const router = Router();

function safeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
  };
}

// Register
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({
        ok: false,
        message: "Missing fields",
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is missing in server environment variables");
      return res.status(500).json({
        ok: false,
        message: "Server JWT configuration missing",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await User.findOne({ email: normalizedEmail });

    if (existing) {
      return res.status(409).json({
        ok: false,
        message: "Email already used",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
    });

    const token = signToken({ userId: user._id });

    return res.json({
      ok: true,
      token,
      user: safeUser(user),
    });
  } catch (e) {
    console.error("REGISTER ERROR:", e);

    return res.status(500).json({
      ok: false,
      message: "Register failed",
      error: process.env.NODE_ENV === "development" ? e.message : undefined,
    });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        message: "Missing fields",
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is missing in server environment variables");
      return res.status(500).json({
        ok: false,
        message: "Server JWT configuration missing",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(401).json({
        ok: false,
        message: "Invalid credentials",
      });
    }

    if (!user.passwordHash) {
      console.error("User exists but passwordHash is missing:", normalizedEmail);

      return res.status(500).json({
        ok: false,
        message: "User password data is missing. Please register again or reset this user.",
      });
    }

    const isPasswordCorrect = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordCorrect) {
      return res.status(401).json({
        ok: false,
        message: "Invalid credentials",
      });
    }

    const token = signToken({ userId: user._id });

    return res.json({
      ok: true,
      token,
      user: safeUser(user),
    });
  } catch (e) {
    console.error("LOGIN ERROR:", e);

    return res.status(500).json({
      ok: false,
      message: "Login failed",
      error: process.env.NODE_ENV === "development" ? e.message : undefined,
    });
  }
});

export default router;