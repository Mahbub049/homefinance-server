/** Database adapter for scheduled large-purchase reporting. */
import SharedPurchaseInstallment from "../models/SharedPurchaseInstallment.js";
import SharedPurchase from "../models/SharedPurchase.js";
import { idString } from "./sharedPurchaseSchedule.js";
import { buildSharedBudgetView } from "./sharedBudgetMath.js";

export async function loadSharedBudgetMonth(familyId, month, ledgerEntries = []) {
  const installments = await SharedPurchaseInstallment.find({ familyId, month })
    .populate("userId", "name")
    .lean();
  const ids = [...new Set(installments.map((x) => idString(x.purchaseId)).filter(Boolean))];
  const purchases = ids.length
    ? await SharedPurchase.find({ familyId, _id: { $in: ids } })
      .populate("categoryId", "name kind financialType")
      .lean()
    : [];
  return buildSharedBudgetView({ month, ledgerEntries, installments, purchases });
}
