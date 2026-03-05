import mongoose from "mongoose";

const fixedTemplateSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },

    name: { type: String, required: true, trim: true }, // Rent, Internet, ChatGPT
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },

	// Expenses are paid from an account (Cash/Bank/bKash/etc.)
	fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },

    // If isVariable=true, amount will be entered each month (so defaultAmount can be null)
    isVariable: { type: Boolean, default: false },
	defaultAmount: { type: Number, default: null },
	// NOTE: Savings is handled via Transfers (Scrum 3). Fixed templates generate EXPENSE transactions only.

    // default split config
    defaultSplitType: { type: String, enum: ["personal", "equal", "ratio", "fixed"], default: "equal" },

    // personal
    personalUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

	// (legacy) "type" field removed in Scrum 4
    // ratio: [{userId, ratio}] sum=100
    ratios: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        ratio: { type: Number },
      },
    ],

    // fixed: [{userId, amount}] sum=defaultAmount (optional usage)
    fixed: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        amount: { type: Number },
      },
    ],

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

fixedTemplateSchema.index({ familyId: 1, name: 1 }, { unique: true });

export default mongoose.model("FixedTemplate", fixedTemplateSchema);