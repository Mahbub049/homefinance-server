import mongoose from "mongoose";

const ledgerEntrySchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },

    entryType: { type: String, enum: ["income", "expense"], required: true }, // income / expense
    // Classification layer (Scrum 1)
    // income | living | debt | investment
    financialType: {
      type: String,
      enum: ["income", "living", "debt", "investment"],
      required: true,
      index: true,
    },
    module: { type: String, default: "manual" }, // later: fixed, grocery, emi etc.

    date: { type: Date, required: true },
    month: { type: String, required: true, index: true }, // "YYYY-MM"

    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },

    amountTotal: { type: Number, required: true }, // total amount of this entry

    // for expenses (who paid)
    paidByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // for income (who received)
    receivedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    note: { type: String, default: "" },

    // Optional linkage back to the source record that generated this ledger entry.
    // Helps delete/rebuild safely.
    sourceType: { type: String, default: "" }, // "transaction" | "grocery" | "emi" | "fixed" | ...
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },

    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// One source record should map to at most one ledger entry per family.
ledgerEntrySchema.index(
  { familyId: 1, sourceType: 1, sourceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceType: { $exists: true, $ne: "" },
      sourceId: { $exists: true, $ne: null },
    },
  }
);

export default mongoose.model("LedgerEntry", ledgerEntrySchema);