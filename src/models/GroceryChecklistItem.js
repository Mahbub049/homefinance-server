import mongoose from 'mongoose';

// This is one ongoing checklist per family, not a financial transaction.
const groceryChecklistItemSchema = new mongoose.Schema({
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
  name: { type: String, default: '', maxlength: 160 },
  quantity: { type: String, default: '', maxlength: 80 },
  checked: { type: Boolean, default: false, index: true },
}, { timestamps: true });

groceryChecklistItemSchema.index({ familyId: 1, createdAt: 1, _id: 1 });
export default mongoose.models.GroceryChecklistItem || mongoose.model('GroceryChecklistItem', groceryChecklistItemSchema);
