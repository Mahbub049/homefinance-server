import mongoose from 'mongoose';

// New records only. No edits or backfill of historical transactions.
const financialPostingRequestSchema = new mongoose.Schema({
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true },
  operation: { type: String, enum: ['grocery.create', 'savings.deposit', 'creditCard.payment', 'manual.transaction.create', 'wallet.settlement', 'wallet.pastPending', 'sharedPurchase.create', 'sharedPurchase.pay'], required: true },
  key: { type: String, required: true },
  payloadHash: { type: String, required: true },
  resultId: { type: mongoose.Schema.Types.ObjectId, default: null },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

// Unlike a timestamp-based cooldown, this permanent index prevents accidental
// re-posting of the same request even after a lost response or server restart.
financialPostingRequestSchema.index(
  { familyId: 1, operation: 1, key: 1 },
  { unique: true, name: 'financial_posting_request_key' }
);

export default mongoose.model('FinancialPostingRequest', financialPostingRequestSchema);
