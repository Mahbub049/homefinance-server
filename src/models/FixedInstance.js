import mongoose from "mongoose";

const fixedInstanceSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "FixedTemplate", required: true },

    month: { type: String, required: true, index: true },
    date: { type: Date, required: true },

    amount: { type: Number, default: null },
    note: { type: String, default: "" },

    paidByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },

    ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },

    status: {
      type: String,
      enum: ["pending", "posted", "active", "deleted"],
      default: "posted",
    },
  },
  { timestamps: true }
);

fixedInstanceSchema.index({ familyId: 1, templateId: 1, month: 1 }, { unique: true });

export default mongoose.model("FixedInstance", fixedInstanceSchema);