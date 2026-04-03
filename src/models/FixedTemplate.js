import mongoose from "mongoose";

const fixedTemplateSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },

    name: { type: String, required: true, trim: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },

    // Template should NOT store account anymore
    isVariable: { type: Boolean, default: false },
    defaultAmount: { type: Number, default: null },

    defaultSplitType: {
      type: String,
      enum: ["personal", "equal", "ratio", "fixed"],
      default: "equal",
    },

    personalUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    ratios: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        ratio: { type: Number },
      },
    ],

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