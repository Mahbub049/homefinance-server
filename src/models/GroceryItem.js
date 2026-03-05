import mongoose from "mongoose";

const groceryItemSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    txnId: { type: mongoose.Schema.Types.ObjectId, ref: "GroceryTransaction", required: true, index: true },

    name: { type: String, required: true, trim: true },
    brand: { type: String, default: "", trim: true },

    unit: { type: String, default: "", trim: true }, // kg, pcs, liter
    qty: { type: Number, required: true },
    unitPrice: { type: Number, required: true },

    // Optional: product validity/period (user may not know end date yet)
    productStartDate: { type: Date, default: null },
    productEndDate: { type: Date, default: null },

    itemDiscount: { type: Number, default: 0 }, // optional
    lineTotal: { type: Number, required: true }, // computed (qty*unitPrice - itemDiscount)

    note: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("GroceryItem", groceryItemSchema);