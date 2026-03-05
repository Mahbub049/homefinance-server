import mongoose from "mongoose";

const familyMemberSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["admin", "member"], default: "member" },
  },
  { timestamps: true }
);

familyMemberSchema.index({ familyId: 1, userId: 1 }, { unique: true });

export default mongoose.model("FamilyMember", familyMemberSchema);