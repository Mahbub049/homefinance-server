import mongoose from "mongoose";

const splitSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerEntry", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    shareAmount: { type: Number, required: true }, // how much this user bears
  },
  { timestamps: true }
);

splitSchema.index({ ledgerEntryId: 1, userId: 1 }, { unique: true });

export default mongoose.model("Split", splitSchema);