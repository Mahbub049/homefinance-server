import mongoose from "mongoose";

const settlementSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },

    month: { type: String, required: true, index: true }, // YYYY-MM
    date: { type: Date, required: true },

    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    amount: { type: Number, required: true },

    // wallet = real account-to-account movement
    // past_pending = only records that an old outside-app issue is settled
    settlementType: {
      type: String,
      enum: ["wallet", "past_pending"],
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["settled"],
      default: "settled",
      index: true,
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

    // For wallet settlements this points to the transfer Transaction.
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      index: true,
    },

    // Controls whether this settlement should reduce the calculated monthly pending amount.
    // past_pending remains false because it is only a historical/manual mark.
    affectsWallet: { type: Boolean, default: false },
    affectsLedger: { type: Boolean, default: false },
    affectsMonthlySettlement: { type: Boolean, default: false },

    note: { type: String, default: "" },

    createdByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

settlementSchema.index({ familyId: 1, month: 1, createdAt: -1 });
settlementSchema.index({ familyId: 1, fromUserId: 1, toUserId: 1, month: 1 });

export default mongoose.model("Settlement", settlementSchema);
