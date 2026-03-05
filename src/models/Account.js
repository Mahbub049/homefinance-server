import mongoose from "mongoose";

const accountSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true },

    type: {
      type: String,
      enum: ["cash", "bank", "wallet", "savings", "investment"],
      default: "bank",
      required: true,
    },

    owner: {
      type: String,
      enum: ["Mahbub", "Mirza", "Joint"],
      default: "Joint",
      required: true,
    },

    openingBalance: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

accountSchema.index({ familyId: 1, name: 1 }, { unique: true });

export default mongoose.model("Account", accountSchema);