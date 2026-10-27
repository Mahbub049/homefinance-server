// Validates new or explicitly edited entries; never mutates or reconciles past data.
import Account from '../models/Account.js';
import Category from '../models/Category.js';
import FamilyMember from '../models/FamilyMember.js';
import MonthlyBalance from '../models/MonthlyBalance.js';
import { monthOf, validMonth, positiveMoney, ownerAllowed, postingError, assertSavingsAccountTypes } from './postingRules.js';

export async function requireOpenMonth(familyId, month) {
  if (!validMonth(month)) throw postingError('Invalid month; use YYYY-MM');
  // Old closing snapshots may not have a closedAt timestamp. A saved
  // closingBalance still makes the month closed and must block new postings.
  const closed = await MonthlyBalance.exists({ familyId, month,
    $or: [{ closedAt: { $ne: null } }, { closingBalance: { $ne: null } }],
  });
  if (closed) throw postingError(`The ${month} month is closed. Reopen and reconcile that month before changing its financial entries.`, 409);
}

async function requirePayer(familyId, userId) {
  if (!userId) throw postingError('Select the member who paid');
  const membership = await FamilyMember.findOne({ familyId, userId }).populate('userId', 'name');
  if (!membership) throw postingError('Selected payer is not a member of this family');
  return membership.userId?.name || '';
}

export async function verifyExpensePosting({ familyId, date, paidByUserId, fromAccountId, categoryId, amount }) {
  positiveMoney(amount);
  const month = monthOf(date);
  if (!month) throw postingError('Invalid payment date');
  await requireOpenMonth(familyId, month);
  const [name, account, category] = await Promise.all([
    requirePayer(familyId, paidByUserId),
    Account.findOne({ _id: fromAccountId, familyId, isActive: { $ne: false } }),
    Category.findOne({ _id: categoryId, familyId, kind: 'expense' }),
  ]);
  if (!category) throw postingError('Select a valid expense category');
  if (!account || !['cash', 'bank', 'wallet'].includes(account.type)) {
    throw postingError('Select an active cash, bank or wallet payment account');
  }
  if (!ownerAllowed(account.owner, name)) {
    throw postingError('This payment account does not belong to the selected payer');
  }
  return { month, account, category };
}

export async function verifySavingsPosting({ familyId, date, paidByUserId, fromAccountId, toAccountId, amount }) {
  positiveMoney(amount);
  const month = monthOf(date);
  if (!month) throw postingError('Invalid deposit date');
  await requireOpenMonth(familyId, month);
  if (!paidByUserId) throw postingError('Select the member making the savings deposit');
  const [name, from, to] = await Promise.all([
    requirePayer(familyId, paidByUserId),
    Account.findOne({ _id: fromAccountId, familyId, isActive: { $ne: false } }),
    Account.findOne({ _id: toAccountId, familyId, isActive: { $ne: false } }),
  ]);
  assertSavingsAccountTypes(from, to);
  if (!ownerAllowed(from.owner, name) || !ownerAllowed(to.owner, name)) {
    throw postingError('Both deposit accounts must belong to the selected member or be Joint accounts');
  }
  return { month, from, to };
}
