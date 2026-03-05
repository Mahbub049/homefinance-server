import mongoose from "mongoose";

const groceryTxnSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: "Family", required: true, index: true },

    txnDate: { type: Date, required: true },
    month: { type: String, required: true, index: true }, // YYYY-MM

    shopName: { type: String, default: "", trim: true },
    location: { type: String, default: "", trim: true },

    paymentMethodId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentMethod", default: null },
    cardLabelId: { type: mongoose.Schema.Types.ObjectId, ref: "CardLabel", default: null },

    // Expense category for Grocery
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },

    paidByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // ✅ Link to Transactions module (so it appears in Ledger/Transactions page)
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },

    // charges
    discountTotal: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    vatAmount: { type: Number, default: 0 },
    vatIncluded: { type: Boolean, default: true }, // if true, VAT already included in item prices

    // computed totals
    itemsSubtotal: { type: Number, required: true }, // sum of item line totals
    totalPayable: { type: Number, required: true }, // final total payable

    note: { type: String, default: "" },

    // ✅ Link to ledger entry (for family split reporting etc.)
    ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerEntry", required: true },

    fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export default mongoose.model("GroceryTransaction", groceryTxnSchema);