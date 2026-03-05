import mongoose from "mongoose";

const emiInstallmentSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "EMIPlan", required: true, index: true },

    month: { type: String, required: true, index: true }, // YYYY-MM
    dueDate: { type: Date, required: true },

    amount: { type: Number, required: true },

    // pending = bill created (no money moved yet)
    // paid = money moved (creates a Transaction)
    status: { type: String, enum: ["pending", "paid"], default: "pending" },

    // split-aware ledger entry (used by wallet/summary)
    ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerEntry", required: true },

    // who paid (used when status=paid)
    paidByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    paidAt: { type: Date, default: null },

    // real money movement (Transactions page totals use this)
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
  },
  { timestamps: true }
);

emiInstallmentSchema.index({ familyId: 1, planId: 1, month: 1 }, { unique: true });

export default mongoose.model("EMIInstallment", emiInstallmentSchema);