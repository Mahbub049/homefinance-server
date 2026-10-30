import { scheduleForPlan } from "./emiSchedule.js";
import { round2, splitEqual, splitFixed, splitPersonal, splitRatio } from './splitCalc.js';

function failure(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

const id = (value) => String(value?._id || value || '').trim();
const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100);

// New plans distribute cents evenly. Existing plans keep their saved monthlyAmount,
// so deploying a patch cannot silently rewrite previously promised installments.
export function newPlanRegularAmount(totalPayable, months) {
  if (!Number.isFinite(Number(totalPayable)) || Number(totalPayable) <= 0 || !Number.isInteger(Number(months)) || Number(months) <= 0) {
    failure('Invalid EMI total or duration');
  }
  if (cents(totalPayable) < Number(months)) failure('EMI total is too small for this number of installments (minimum ৳0.01 each)');
  return Math.ceil(cents(totalPayable) / Number(months)) / 100;
}

export function regularAmount(plan) {
  const persisted = Number(plan?.monthlyAmount);
  if (Number.isFinite(persisted) && persisted > 0) return round2(persisted);
  // Legacy fallback (do not change existing schedules with a saved amount).
  return Math.ceil(Number(plan?.totalPayable || 0) / Number(plan?.months || 1));
}

export function amountForIndex(plan, index) {
  const count = Number(plan?.months);
  if (!Number.isInteger(count) || count <= 0 || index < 0 || index >= count) return 0;
  const standard = regularAmount(plan);
  const last = round2(Number(plan.totalPayable) - standard * (count - 1));
  if (last <= 0 || !Number.isFinite(last)) {
    failure('This legacy EMI plan has an invalid final amount. Review its schedule before recording payment.');
  }
  return index === count - 1 ? last : standard;
}

export function validatePlanSplit({ splitType, personalUserId, ratios = [], fixed = [] }, familyUserIds, standardAmount) {
  const allowed = new Set(familyUserIds.map(id));
  const type = String(splitType || 'equal');
  if (!['equal', 'personal', 'ratio', 'fixed'].includes(type)) failure('Invalid EMI split type');
  if (!allowed.size) failure('No family members configured');
  if (type === 'personal') {
    if (!allowed.has(id(personalUserId))) failure('Choose a valid family member for personal EMI');
    return;
  }
  const rows = type === 'ratio' ? ratios : type === 'fixed' ? fixed : [];
  if (type === 'equal') return;
  if (!Array.isArray(rows) || !rows.length) failure('EMI split rows required');
  const users = rows.map((row) => id(row?.userId));
  if (new Set(users).size !== users.length || users.some((member) => !allowed.has(member))) {
    failure('EMI split contains duplicate or invalid family members');
  }
  const values = rows.map((r) => Number(type === 'fixed' ? r.amount : r.ratio));
  if (values.some((v) => !Number.isFinite(v) || v < 0)) failure('EMI split values must be non-negative');
  const total = values.reduce((sum, n) => sum + n, 0);
  if (type === 'ratio' && Math.abs(total - 100) > 0.00001) failure('EMI percentages must sum to 100');
  if (type === 'fixed' && Math.abs(round2(total) - round2(standardAmount)) > 0.009) {
    failure(`Fixed member amounts must add up to the regular EMI of ৳${round2(standardAmount).toFixed(2)}. The final installment is adjusted automatically.`);
  }
}

export function splitInstallment(plan, amount, familyUserIds) {
  const total = round2(amount);
  if (total <= 0) failure('EMI installment must be positive');
  const type = String(plan?.splitType || 'equal');
  if (type === 'personal') return splitPersonal(total, id(plan.personalUserId));
  if (type === 'ratio') return splitRatio(total, plan.ratios || []);
  if (type === 'equal') return splitEqual(total, familyUserIds.map(id));
  if (type !== 'fixed') failure('Invalid EMI split type');
  const configured = plan.fixed || [];
  const standard = regularAmount(plan);
  validatePlanSplit(plan, familyUserIds, standard);
  if (Math.abs(total - standard) < 0.009) return splitFixed(total, configured);
  // Preserve configured proportions on the adjusted final installment.
  // Distribute exact cents by largest remainder: no negative shares or drift.
  const totalCents = cents(total);
  const weights = configured.map((row) => cents(row.amount));
  const weightTotal = weights.reduce((sum, n) => sum + n, 0);
  if (!weightTotal) failure('Fixed EMI shares cannot all be zero');
  const exact = weights.map((weight) => (totalCents * weight) / weightTotal);
  const allocated = exact.map(Math.floor);
  let remainder = totalCents - allocated.reduce((sum, n) => sum + n, 0);
  const order = exact.map((n, index) => ({ index, fractional: n - allocated[index] }))
    .sort((x, y) => y.fractional - x.fractional || x.index - y.index);
  for (let i = 0; i < remainder; i++) allocated[order[i % order.length].index] += 1;
  return configured.map((row, index) => ({ userId: row.userId, shareAmount: allocated[index] / 100 }));
}

// Pure as-of-month ACTIVE obligation summary: includes ungenerated installments
// and earlier unpaid bills. Closed-plan historical payment gaps are returned
// separately for manual review, never silently treated as active obligations.
// Actual cash expense remains generated ONLY when a bill is marked paid.
export function summarizeEmiDues(plans, installments, selectedMonth) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(selectedMonth))) failure('Valid month (YYYY-MM) required');
  const installmentMap = new Map(installments.map((i) => [`${id(i.planId)}:${i.month}`, i]));
  const entries = [];
  const excludedClosedPlans = [];
  let excludedClosedThisMonth = 0;
  let dueThrough = 0, unpaidThrough = 0, overdue = 0, dueThisMonth = 0, paidThrough = 0;
  for (const plan of plans) {
    const closed = String(plan.status || 'active').toLowerCase() !== 'active';
    let excludedCurrent = 0;
    let excludedUnverified = 0;
    const start = String(plan.startMonth || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)) continue;
    const schedule = scheduleForPlan(plan);
    for (let i = 0; i < schedule.length; i++) {
      const dueMonth = schedule[i];
      if (dueMonth > selectedMonth) break;
      const amount = amountForIndex(plan, i);
      const inst = installmentMap.get(`${id(plan._id)}:${dueMonth}`);
      // Historical as-of balance must not include a future-dated payment.
      const paidAtMonth = inst?.paidAt ? new Date(inst.paidAt).toISOString().slice(0, 7) : null;
      const paid = inst?.status === 'paid' && (!paidAtMonth || paidAtMonth <= selectedMonth);
      if (closed) {
        if (dueMonth === selectedMonth) excludedCurrent = round2(excludedCurrent + amount);
        if (!paid) excludedUnverified = round2(excludedUnverified + amount);
        continue;
      }
      dueThrough = round2(dueThrough + amount);
      if (dueMonth === selectedMonth) dueThisMonth = round2(dueThisMonth + amount);
      if (paid) paidThrough = round2(paidThrough + amount);
      else {
        unpaidThrough = round2(unpaidThrough + amount);
        if (dueMonth < selectedMonth) overdue = round2(overdue + amount);
        entries.push({ planId: id(plan._id), productName: plan.productName, month: dueMonth, amount, generated: Boolean(inst), overdue: dueMonth < selectedMonth });
      }
    }
    if (closed && (excludedCurrent || excludedUnverified)) {
      excludedClosedThisMonth = round2(excludedClosedThisMonth + excludedCurrent);
      excludedClosedPlans.push({
        planId: id(plan._id), productName: plan.productName,
        scheduledThisMonth: excludedCurrent,
        unverifiedUnpaidThrough: excludedUnverified,
      });
    }
  }
  return {
    month: selectedMonth, dueThrough, paidThrough, unpaidThrough, overdue,
    dueThisMonth, unpaidCount: entries.length, entries,
    excludedClosedThisMonth, excludedClosedPlans,
  };
}
