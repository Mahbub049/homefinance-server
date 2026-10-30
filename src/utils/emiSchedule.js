// A calendar schedule is explicit after a paused plan is resumed. Older plans
// retain their original consecutive-month schedule without a data migration.
export function addEmiMonths(month, offset) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw new Error('সঠিক মাস নির্বাচন করুন।');
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function scheduleForPlan(plan) {
  const count = Number(plan?.months || 0);
  if (!Number.isInteger(count) || count <= 0 || count > 120) return [];
  const stored = Array.isArray(plan?.scheduleMonths) ? plan.scheduleMonths.map(String) : [];
  if (stored.length === count && stored.every((m,i) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && (!i || m > stored[i-1]))) return stored;
  return Array.from({length:count}, (_,i) => addEmiMonths(String(plan.startMonth), i));
}
export function installmentIndexForMonth(plan, month) { return scheduleForPlan(plan).indexOf(month); }
export function buildResumedSchedule(plan, paidMonths, resumeMonth) {
  const previous = scheduleForPlan(plan);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(resumeMonth))) throw new Error('সঠিক শুরুর মাস নির্বাচন করুন।');
  const paid = new Set(paidMonths.map(String));
  if (paid.size !== paidMonths.length || [...paid].some(m => !previous.includes(m))) throw new Error('পরিশোধিত কিস্তির ইতিহাসে অসংগতি রয়েছে।');
  if ([...paid].some(m => m >= resumeMonth)) throw new Error('ইতিমধ্যে পরিশোধিত মাসের আগের মাস থেকে আবার শুরু করা যাবে না।');
  const result = [];
  let next = resumeMonth;
  for (const m of previous) {
    if (paid.has(m)) result.push(m);
    else { result.push(next); next = addEmiMonths(next, 1); }
  }
  if (result.some((m,i) => i && m <= result[i-1])) throw new Error('বাকি মাসগুলোর নতুন সময়সূচি সাজানো যায়নি।');
  return result;
}
