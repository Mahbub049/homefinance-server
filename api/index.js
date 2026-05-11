import dotenv from "dotenv";
import app from "../src/app.js";
import { connectDB } from "../src/config/db.js";

dotenv.config();

let dbReady = false;

export default async function handler(req, res) {
  try {
    if (!dbReady) {
      await connectDB(process.env.MONGO_URI);
      dbReady = true;
    }

    return app(req, res);
  } catch (error) {
    console.error("Vercel API Error:", error);
    return res.status(500).json({
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}