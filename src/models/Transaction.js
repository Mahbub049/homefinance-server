import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },

    txType: {
      type: String,
      enum: ["income", "expense", "transfer"],
      required: true,
      index: true,
    },

    date: { type: Date, required: true },
    month: { type: String, required: true, index: true }, // YYYY-MM

    // Only for income/expense
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },

    amount: { type: Number, required: true },
    note: { type: String, default: "" },

    // Accounts
    fromAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    toAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },

    // Optional attribution
    paidByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    receivedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

transactionSchema.index({ familyId: 1, month: 1, txType: 1 });

export default mongoose.model("Transaction", transactionSchema);