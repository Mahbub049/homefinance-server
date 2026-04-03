import mongoose from "mongoose";

const plannedPurchaseSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },

    productName: {
      type: String,
      required: true,
      trim: true,
    },

    category: {
      type: String,
      default: "",
      trim: true,
    },

    brand: {
      type: String,
      default: "",
      trim: true,
    },

    expectedPrice: {
      type: Number,
      default: 0,
    },

    productLink: {
      type: String,
      default: "",
      trim: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    priority: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "medium",
      index: true,
    },

    ownershipType: {
      type: String,
      enum: ["personal", "shared"],
      default: "shared",
      index: true,
    },

    personalForUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    paymentMode: {
      type: String,
      enum: ["undecided", "cash", "emi", "either"],
      default: "undecided",
    },

    status: {
      type: String,
      enum: ["planned", "bought", "cancelled"],
      default: "planned",
      index: true,
    },

    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },

    createdByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

plannedPurchaseSchema.index({
  familyId: 1,
  status: 1,
  sortOrder: 1,
  createdAt: -1,
});

export default mongoose.model("PlannedPurchase", plannedPurchaseSchema);