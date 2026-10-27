import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
  cardAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, unique: true },
  date: { type: Date, required: true },
  month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  amount: { type: Number, required: true, min: 0.01 },
  note: { type: String, maxlength: 240, default: '' },
  status: { type: String, enum: ['posted', 'voided'], default: 'posted' },
  voidedAt: { type: Date, default: null },
  voidedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

schema.index({ familyId: 1, month: 1, cardAccountId: 1 });
export default mongoose.model('CreditCardPayment', schema);
