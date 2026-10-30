import test from 'node:test';
import assert from 'node:assert/strict';
import {addEmiMonths,scheduleForPlan,buildResumedSchedule,installmentIndexForMonth} from '../src/utils/emiSchedule.js';
import {bdClock,dueSavingsRule,savingsScheduledDate} from '../src/utils/savingsAutoRules.js';
const plan={months:6,startMonth:'2026-05',totalPayable:6000,monthlyAmount:1000};
test('legacy EMI months remain unchanged',()=>{
  assert.deepEqual(scheduleForPlan(plan),['2026-05','2026-06','2026-07','2026-08','2026-09','2026-10']);
});
test('one paid then paused three months resumes remaining five without inventing historical payments',()=>{
  const s=buildResumedSchedule(plan,['2026-05'],'2026-11');
  assert.deepEqual(s,['2026-05','2026-11','2026-12','2027-01','2027-02','2027-03']);
  assert.equal(installmentIndexForMonth({...plan,scheduleMonths:s},'2026-07'),-1);
  assert.equal(installmentIndexForMonth({...plan,scheduleMonths:s},'2027-03'),5);
});
test('cannot reschedule before recorded paid month',()=>assert.throws(()=>buildResumedSchedule(plan,['2026-05'],'2026-05')));
test('rescheduling across year is calendar-safe',()=>assert.equal(addEmiMonths('2026-11',4),'2027-03'));
test('auto savings due day 31 falls on last day of shorter month',()=>{
  const feb={year:2027,month:2,day:28,monthKey:'2027-02'};
  const rule={active:true,startMonth:'2027-01',endMonth:'2027-12',dayOfMonth:31};
  assert.equal(dueSavingsRule(rule,feb),true);
  assert.equal(savingsScheduledDate(rule,feb).toISOString(),'2027-02-28T06:00:00.000Z');
});
test('future or paused rules do not execute',()=>{
  assert.equal(dueSavingsRule({active:false,startMonth:'2026-11',dayOfMonth:10},bdClock(new Date('2026-11-18T10:00:00Z'))),false);
});
test('Bangladesh date uses UTC+6 reliably',()=>assert.equal(bdClock(new Date('2026-10-30T19:00:00Z')).monthKey,'2026-10'));
