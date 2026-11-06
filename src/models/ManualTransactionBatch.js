import mongoose from 'mongoose';

// Audit/response receipt for a single atomic day-entry save. Each transaction
// remains an independent manual Transaction (and independent Ledger/Split rows).
const manualTransactionBatchSchema = new mongoose.Schema({
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
  date: { type: Date, required: true },
  month: { type: String, required: true },
  transactionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true }],
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

export default mongoose.model('ManualTransactionBatch', manualTransactionBatchSchema);
