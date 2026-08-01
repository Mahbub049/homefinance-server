import mongoose from "mongoose";

const shareSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    shareAmount: { type: Number, required: true },
    monthlyAmount: { type: Number, required: true },
  },
  { _id: false }
);

const sharedPurchaseSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },

    title: { type: String, required: true, trim: true },
    totalAmount: { type: Number, required: true },
    purchaseDate: { type: Date, required: true },

    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },

    payerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    payerAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },

    purchaseType: {
      type: String,
      enum: ["personal", "shared"],
      default: "shared",
      index: true,
    },

    startMonth: { type: String, required: true, index: true },
    endMonth: { type: String, required: true, index: true },
    months: { type: Number, required: true },

    shares: { type: [shareSchema], default: [] },

    upfrontTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
      index: true,
    },

    note: { type: String, default: "" },

    createdByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

sharedPurchaseSchema.index({ familyId: 1, createdAt: -1 });

export default mongoose.model("SharedPurchase", sharedPurchaseSchema);
