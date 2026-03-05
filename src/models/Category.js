import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    kind: { type: String, enum: ["income", "expense"], required: true },
    // Classification layer (Scrum 1)
    // income: money coming in
    // living: day-to-day expenses
    // debt: EMI/loan/credit payments
    // investment: savings/investments (DPS/SIP/etc.)
    financialType: {
      type: String,
      enum: ["income", "living", "debt", "investment"],
      // Backward compatibility: existing categories in DB won't have this field.
      // Default derives from kind; you can update later from Category settings.
      default: function () {
        return this.kind === "income" ? "income" : "living";
      },
      required: true,
    },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

categorySchema.index({ familyId: 1, kind: 1, name: 1 }, { unique: true });

export default mongoose.model("Category", categorySchema);