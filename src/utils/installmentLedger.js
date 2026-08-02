import EMIInstallment from "../models/EMIInstallment.js";
import SharedPurchaseInstallment from "../models/SharedPurchaseInstallment.js";
import LedgerEntry from "../models/LedgerEntry.js";
import Split from "../models/Split.js";

/**
 * Removes legacy ledger rows that were created before an EMI/shared repayment
 * was actually paid. Pending rows are schedules only and must not affect the
 * dashboard, monthly spend, debt totals, or ordinary member settlement.
 */
export async function cleanupPendingInstallmentLedgers(familyId, month = null) {
  const monthFilter = month ? { month } : {};

  const [pendingEmis, pendingShared] = await Promise.all([
    EMIInstallment.find({
      familyId,
      ...monthFilter,
      status: { $ne: "paid" },
      ledgerEntryId: { $ne: null },
    })
      .select("_id ledgerEntryId categoryId")
      .lean(),
    SharedPurchaseInstallment.find({
      familyId,
      ...monthFilter,
      paymentRequired: true,
      status: { $ne: "paid" },
      ledgerEntryId: { $ne: null },
    })
      .select("_id ledgerEntryId")
      .lean(),
  ]);

  const emiLedgerIds = pendingEmis.map((row) => row.ledgerEntryId).filter(Boolean);
  const sharedLedgerIds = pendingShared.map((row) => row.ledgerEntryId).filter(Boolean);
  const ledgerIds = [...emiLedgerIds, ...sharedLedgerIds];

  if (!ledgerIds.length) {
    return { removed: 0, emiUpdated: 0, sharedUpdated: 0 };
  }

  // Older EMI installments did not store categoryId directly. Preserve it
  // before deleting the premature ledger entry so payment can recreate it.
  const legacyEmiEntries = emiLedgerIds.length
    ? await LedgerEntry.find({ familyId, _id: { $in: emiLedgerIds } })
        .select("_id categoryId")
        .lean()
    : [];
  const categoryByLedgerId = new Map(
    legacyEmiEntries.map((entry) => [String(entry._id), entry.categoryId || null])
  );

  const emiOps = pendingEmis.map((row) => {
    const categoryId = row.categoryId || categoryByLedgerId.get(String(row.ledgerEntryId)) || null;
    return {
      updateOne: {
        filter: { _id: row._id, familyId },
        update: {
          $set: {
            ledgerEntryId: null,
            ...(categoryId ? { categoryId } : {}),
          },
        },
      },
    };
  });

  const sharedOps = pendingShared.map((row) => ({
    updateOne: {
      filter: { _id: row._id, familyId },
      update: { $set: { ledgerEntryId: null } },
    },
  }));

  await Promise.all([
    Split.deleteMany({ familyId, ledgerEntryId: { $in: ledgerIds } }),
    LedgerEntry.deleteMany({ familyId, _id: { $in: ledgerIds } }),
    emiOps.length ? EMIInstallment.bulkWrite(emiOps) : Promise.resolve(),
    sharedOps.length ? SharedPurchaseInstallment.bulkWrite(sharedOps) : Promise.resolve(),
  ]);

  return {
    removed: ledgerIds.length,
    emiUpdated: pendingEmis.length,
    sharedUpdated: pendingShared.length,
  };
}
