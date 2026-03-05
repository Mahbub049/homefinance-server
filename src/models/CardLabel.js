import mongoose from "mongoose";

const cardLabelSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    label: { type: String, required: true, trim: true }, // "EBL Credit Card"
    last4: { type: String, default: "", trim: true },    // optional
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

cardLabelSchema.index({ familyId: 1, label: 1 }, { unique: true });

export default mongoose.model("CardLabel", cardLabelSchema);