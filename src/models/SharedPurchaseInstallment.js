import mongoose from "mongoose";

const sharedPurchaseInstallmentSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SharedPurchase",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    month: { type: String, required: true, index: true },
    dueDate: { type: Date, required: true },
    amount: { type: Number, required: true },

    paymentRequired: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["allocated", "pending", "paid"],
      default: "pending",
      index: true,
    },

    ledgerEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LedgerEntry",
      default: null,
    },

    paymentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
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
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

sharedPurchaseInstallmentSchema.index(
  { familyId: 1, purchaseId: 1, userId: 1, month: 1 },
  { unique: true }
);

export default mongoose.model(
  "SharedPurchaseInstallment",
  sharedPurchaseInstallmentSchema
);
