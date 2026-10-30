import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeEmiDues} from '../src/utils/emiAccounting.js';
const plan={_id:'plan1',status:'active',productName:'Test',months:4,startMonth:'2026-09',totalPayable:4000,monthlyAmount:1000,scheduleMonths:['2026-09','2026-12','2027-01','2027-02']};
test('resumed plan does not bill paused calendar months',()=>{
 const v=summarizeEmiDues([plan],[{planId:'plan1',month:'2026-09',status:'paid',paidAt:'2026-09-15'}],'2026-11');
 assert.equal(v.dueThrough,1000);assert.equal(v.dueThisMonth,0);assert.equal(v.unpaidThrough,0);
});
test('resume future month bills correct indexed amount',()=>{
 const v=summarizeEmiDues([plan],[{planId:'plan1',month:'2026-09',status:'paid',paidAt:'2026-09-15'}],'2026-12');
 assert.equal(v.dueThrough,2000);assert.equal(v.unpaidThrough,1000);assert.equal(v.dueThisMonth,1000);
});
test('paused plans do not add active due',()=>{
 const v=summarizeEmiDues([{...plan,status:'paused'}],[], '2026-12');
 assert.equal(v.dueThrough,0);assert.ok(v.excludedClosedPlans.length);
});
