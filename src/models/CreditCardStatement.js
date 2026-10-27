import mongoose from 'mongoose';

const creditCardStatementSchema = new mongoose.Schema({
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  outstanding: { type: Number, required: true, min: 0 },
  note: { type: String, default: '', maxlength: 300 },
}, { timestamps: true });

creditCardStatementSchema.index({ familyId: 1, accountId: 1, month: 1 }, { unique: true });

export default mongoose.model('CreditCardStatement', creditCardStatementSchema);
