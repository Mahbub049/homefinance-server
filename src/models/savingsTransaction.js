import mongoose from "mongoose";

const savingsTransactionSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "SavingsAccount", required: true },

    month: { type: String, required: true }, // YYYY-MM
    amount: { type: Number, required: true },

    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

savingsTransactionSchema.index({ familyId: 1, accountId: 1, month: 1 }, { unique: true });

export default mongoose.models.SavingsTransaction ||
mongoose.model("SavingsTransaction", savingsTransactionSchema);