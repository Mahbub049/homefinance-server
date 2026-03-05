import mongoose from "mongoose";

const emiPlanSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },

    productName: { type: String, required: true, trim: true },
    brand: { type: String, default: "", trim: true },
    category: { type: String, default: "", trim: true }, // Electronics, Furniture, etc.

    purchaseDate: { type: Date, required: true },

    originalPrice: { type: Number, required: true },
    emiCharge: { type: Number, default: 0 }, // percentage (e.g., 0.9 means 0.9%)
    totalPayable: { type: Number, required: true },

    months: { type: Number, required: true }, // duration
    startMonth: { type: String, required: true, index: true }, // YYYY-MM
    endMonth: { type: String, required: true, index: true },   // YYYY-MM

    monthlyAmount: { type: Number, required: true }, // computed at creation

    // split config (applies to each installment)
    splitType: { type: String, enum: ["personal", "equal", "ratio", "fixed"], default: "equal" },
    personalUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    ratios: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, ratio: Number }],
    fixed: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, amount: Number }],

    status: { type: String, enum: ["active", "closed"], default: "active" },

    note: { type: String, default: "" },

    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export default mongoose.model("EMIPlan", emiPlanSchema);