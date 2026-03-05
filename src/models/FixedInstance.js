import mongoose from "mongoose";

const fixedInstanceSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "FixedTemplate", required: true },

    month: { type: String, required: true, index: true }, // "YYYY-MM"
    date: { type: Date, required: true },

    // For variable templates, amount will be null until user posts the month value.
    amount: { type: Number, default: null },
    note: { type: String, default: "" },

    // link to ledger
    ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerEntry", default: null },

    // link to transaction (Scrum 4)
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },

    // pending: exists for month but amount not posted yet
    // posted: ledger created
    // "active" kept for backward compatibility (older DB rows)
    status: { type: String, enum: ["pending", "posted", "active", "deleted"], default: "posted" },
  },
  { timestamps: true }
);

fixedInstanceSchema.index({ familyId: 1, templateId: 1, month: 1 }, { unique: true });

export default mongoose.model("FixedInstance", fixedInstanceSchema);