import dotenv from "dotenv";
import { connectDB } from "../config/db.js";
import Category from "../models/Category.js";
import LedgerEntry from "../models/LedgerEntry.js";

dotenv.config();

function guessCategoryFinancialType(cat) {
  if (cat.kind === "income") return "income";

  const name = String(cat.name || "").toLowerCase();
  // Debt keywords
  if (name.includes("emi") || name.includes("loan") || name.includes("install") || name.includes("credit")) {
    return "debt";
  }
  // Investment keywords
  if (name.includes("saving") || name.includes("dps") || name.includes("fdr") || name.includes("invest")) {
    return "investment";
  }
  return "living";
}

async function run() {
  await connectDB(process.env.MONGO_URI);

  // 1) Categories
  const cats = await Category.find({ $or: [{ financialType: { $exists: false } }, { financialType: null }] });
  let catUpdated = 0;
  for (const c of cats) {
    c.financialType = guessCategoryFinancialType(c);
    await c.save();
    catUpdated++;
  }

  // 2) Ledger entries
  const entries = await LedgerEntry.find({ $or: [{ financialType: { $exists: false } }, { financialType: null }] });
  let entryUpdated = 0;
  for (const e of entries) {
    if (e.entryType === "income") {
      e.financialType = "income";
    } else {
      const cat = await Category.findById(e.categoryId);
      e.financialType = cat?.financialType || "living";
    }
    await e.save();
    entryUpdated++;
  }

  console.log("✅ Backfill done:");
  console.log("  Categories updated:", catUpdated);
  console.log("  Ledger entries updated:", entryUpdated);
  process.exit(0);
}

run().catch((e) => {
  console.error("❌ Backfill failed:", e);
  process.exit(1);
});
