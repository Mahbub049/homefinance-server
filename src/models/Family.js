import mongoose from "mongoose";

const familySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    inviteCode: { type: String, required: true, unique: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Bumped within an atomic Wallet settlement to serialize competing saves.
    walletSettlementRevision: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("Family", familySchema);