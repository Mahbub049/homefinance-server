import mongoose from "mongoose";

const monthlyBalanceSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },
    // "YYYY-MM"
    month: { type: String, required: true, index: true },

    // Carry-forward continuity
    openingBalance: { type: Number, required: true, default: 0 },
    closingBalance: { type: Number, default: null },

    // Bookkeeping (optional)
    closedAt: { type: Date, default: null },
    closedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

monthlyBalanceSchema.index({ familyId: 1, month: 1 }, { unique: true });

export default mongoose.model("MonthlyBalance", monthlyBalanceSchema);
