import mongoose from "mongoose";

const paymentMethodSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    name: { type: String, required: true, trim: true }, // Cash, Card, bKash...
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

paymentMethodSchema.index({ familyId: 1, name: 1 }, { unique: true });

export default mongoose.model("PaymentMethod", paymentMethodSchema);