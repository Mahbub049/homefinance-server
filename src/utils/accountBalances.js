import mongoose from "mongoose";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import { accountRowsFromMovements } from "./accountArithmetic.js";

/**
 * Canonical RAW account arithmetic used by monthly close, personal summary,
 * and year overview. `cutoffDate` is exclusive. Includes every actual expense
 * source, including all split-payment parts, and every real transfer.
 *
 * This is not yet a replacement for user-edited month-close snapshots. The
 * Phase 1B reconciliation release will roll forward manual close adjustments.
 */
export async function loadRawAccountBalances(familyId, cutoffDate, options = {}) {
  const familyObjectId = new mongoose.Types.ObjectId(familyId);
  const cutoff = new Date(cutoffDate);
  if (Number.isNaN(cutoff.getTime())) throw new Error("Invalid balance cutoff date");

  const query = { familyId: familyObjectId, isActive: true };
  if (Array.isArray(options.types)) query.type = { $in: options.types };
  const accounts = options.accounts || (await Account.find(query)
    .select("name type owner openingBalance")
    .sort({ owner: 1, name: 1 })
    .lean());
  const accountIds = accounts.map((a) => a._id);
  if (!accountIds.length) return { accounts: [], total: 0 };

  const sharedMatch = { familyId: familyObjectId, date: { $lt: cutoff } };
  const [inflows, directOutflows, splitOutflows] = await Promise.all([
    Transaction.aggregate([
      { $match: { ...sharedMatch, toAccountId: { $in: accountIds }, txType: { $in: ["income", "transfer"] } } },
      { $group: { _id: "$toAccountId", total: { $sum: "$amount" } } },
    ]),
    Transaction.aggregate([
      { $match: { ...sharedMatch, fromAccountId: { $in: accountIds }, $or: [
        { txType: "transfer" }, { txType: "expense", paymentMode: { $ne: "split" } },
      ] } },
      { $group: { _id: "$fromAccountId", total: { $sum: "$amount" } } },
    ]),
    Transaction.aggregate([
      { $match: { ...sharedMatch, txType: "expense", paymentMode: "split" } },
      { $unwind: "$paymentParts" },
      { $match: { "paymentParts.accountId": { $in: accountIds } } },
      { $group: { _id: "$paymentParts.accountId", total: { $sum: "$paymentParts.amount" } } },
    ]),
  ]);

  return accountRowsFromMovements(accounts, inflows, directOutflows, splitOutflows);
}
