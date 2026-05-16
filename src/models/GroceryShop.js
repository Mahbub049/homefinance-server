import mongoose from "mongoose";

const groceryShopSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Family",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    location: {
      type: String,
      trim: true,
      default: "",
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

groceryShopSchema.index(
  { familyId: 1, name: 1 },
  { unique: true }
);

export default mongoose.model("GroceryShop", groceryShopSchema);