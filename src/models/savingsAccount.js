import mongoose from "mongoose";

const savingsAccountSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true },

    name: { type: String, required: true },
    type: { type: String, enum: ["dps", "fdr", "custom"], required: true },

    startMonth: { type: String, required: true }, // YYYY-MM
    durationMonths: { type: Number, required: true },

    monthlyAmount: { type: Number, required: true },
    interestRate: { type: Number, default: 0 }, // annual %

    splitType: {
      type: String,
      enum: ["equal", "personal", "ratio", "fixed"],
      default: "equal",
    },

    personalUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    status: { type: String, enum: ["active", "matured"], default: "active" },

    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("SavingsAccount", savingsAccountSchema);