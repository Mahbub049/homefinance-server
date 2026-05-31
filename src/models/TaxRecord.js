import mongoose from "mongoose";

const taxRecordSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    taxYearStart: {
      type: Number,
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
    },
    recordType: {
      type: String,
      enum: [
        "income",
        "rebate",
        "asset",
        "liability",
        "tax_paid",
        "business_expense",
        "document",
        "note",
      ],
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      default: "",
      trim: true,
    },
    institution: {
      type: String,
      default: "",
      trim: true,
    },
    amount: {
      type: Number,
      default: 0,
    },
    proofRef: {
      type: String,
      default: "",
      trim: true,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
    createdByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

taxRecordSchema.index({ familyId: 1, taxYearStart: 1, recordType: 1 });

taxRecordSchema.virtual("taxYearLabel").get(function () {
  return `${this.taxYearStart}-${this.taxYearStart + 1}`;
});

export default mongoose.models.TaxRecord || mongoose.model("TaxRecord", taxRecordSchema);
