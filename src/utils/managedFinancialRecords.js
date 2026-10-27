import EMIInstallment from '../models/EMIInstallment.js';
import FixedInstance from '../models/FixedInstance.js';
import GroceryTransaction from '../models/GroceryTransaction.js';

export function isManagedTransactionSource(sourceType) {
  const value = String(sourceType || '').trim().toLowerCase();
  return Boolean(value && !['manual', 'transaction'].includes(value));
}

export function isManagedLedgerModule(moduleName, sourceType) {
  const module = String(moduleName || '').trim().toLowerCase();
  return (module && module !== 'manual') || String(sourceType || '') === 'shared_purchase_installment';
}

// Legacy Fixed and Grocery payments do not all have a transaction.sourceType.
// Check the parent record, not just source metadata, before allowing a generic edit.
export async function sourceOwnerOfTransaction(familyId, tx) {
  if (isManagedTransactionSource(tx?.sourceType)) return String(tx.sourceType);
  const [emi, fixed, grocery] = await Promise.all([
    EMIInstallment.exists({ familyId, transactionId: tx._id }),
    FixedInstance.exists({ familyId, transactionId: tx._id }),
    GroceryTransaction.exists({ familyId, transactionId: tx._id }),
  ]);
  if (emi) return 'EMI';
  if (fixed) return 'Fixed Expenses';
  if (grocery) return 'Grocery';
  return null;
}

export async function sourceOwnerOfLedger(familyId, entry, tx) {
  if (isManagedLedgerModule(entry?.module, entry?.sourceType)) return String(entry.module || 'Shared Purchases');
  if (tx) {
    const owner = await sourceOwnerOfTransaction(familyId, tx);
    if (owner) return owner;
  }
  const [emi, fixed, grocery] = await Promise.all([
    EMIInstallment.exists({ familyId, ledgerEntryId: entry._id }),
    FixedInstance.exists({ familyId, ledgerEntryId: entry._id }),
    GroceryTransaction.exists({ familyId, ledgerEntryId: entry._id }),
  ]);
  if (emi) return 'EMI';
  if (fixed) return 'Fixed Expenses';
  if (grocery) return 'Grocery';
  return null;
}
