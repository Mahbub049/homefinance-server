export const bdClock = (instant = new Date()) => {
  const dt = new Date(instant.getTime()+6*3600000);
  return {year:dt.getUTCFullYear(),month:dt.getUTCMonth()+1,day:dt.getUTCDate(),monthKey:`${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}`};
};
export function dueSavingsRule(rule, time = bdClock()) {
  if (!rule.active || time.monthKey < rule.startMonth || (rule.endMonth && time.monthKey > rule.endMonth)) return false;
  const days=new Date(Date.UTC(time.year,time.month,0)).getUTCDate();
  return time.day >= Math.min(Number(rule.dayOfMonth),days);
}
export function savingsScheduledDate(rule,time=bdClock()) {
  const days=new Date(Date.UTC(time.year,time.month,0)).getUTCDate();
  const day=Math.min(Number(rule.dayOfMonth),days);
  // Noon in Dhaka (06:00 UTC), avoiding UTC servers shifting day 1 into the previous month.
  return new Date(Date.UTC(time.year,time.month-1,day,6));
}
