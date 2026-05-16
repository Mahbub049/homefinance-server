import mongoose from "mongoose";

const monthlyAccountSnapshotSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    name: { type: String, default: "" },
    type: { type: String, default: "" },
    owner: { type: String, default: "" },
    balance: { type: Number, default: 0 },

    // only for closing snapshot
    systemBalance: { type: Number, default: null },
    manualEdited: { type: Boolean, default: false },
  },
  { _id: false }
);

const monthlyBalanceSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },

    month: {
      type: String,
      required: true,
      index: true,
    },

    openingBalance: {
      type: Number,
      required: true,
      default: 0,
    },

    closingBalance: {
      type: Number,
      default: null,
    },

    accountsOpening: {
      type: [monthlyAccountSnapshotSchema],
      default: [],
    },

    accountsClosing: {
      type: [monthlyAccountSnapshotSchema],
      default: [],
    },

    manualAdjusted: {
      type: Boolean,
      default: false,
    },

    closedAt: {
      type: Date,
      default: null,
    },

    closedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

monthlyBalanceSchema.index({ familyId: 1, month: 1 }, { unique: true });

export default mongoose.model("MonthlyBalance", monthlyBalanceSchema);