import mongoose from 'mongoose';
import SavingsAutoRule from '../models/SavingsAutoRule.js';
import SavingsAutoExecution from '../models/SavingsAutoExecution.js';
import Transaction from '../models/Transaction.js';
import {bdClock,dueSavingsRule,savingsScheduledDate} from './savingsAutoRules.js';
import {verifySavingsPosting} from './postingPreflight.js';

// Called only by an authenticated deployment scheduler with CRON_SECRET.
// It records *assumed* account transfers in HomeFinance; it cannot pay a bank.
export async function runSavingsAuto(instant=new Date()) {
  const time=bdClock(instant);
  const rules=await SavingsAutoRule.find({active:true,startMonth:{$lte:time.monthKey},$or:[{endMonth:''},{endMonth:{$gte:time.monthKey}}]}).lean();
  const result={checked:rules.length,recorded:0,already:0,errors:[]};
  for(const rule of rules){
    if(!dueSavingsRule(rule,time)) continue;
    try {
      const existing=await SavingsAutoExecution.exists({familyId:rule.familyId,ruleId:rule._id,month:time.monthKey});
      if(existing){result.already++;continue;}
      const date=savingsScheduledDate(rule,time);
      await verifySavingsPosting({familyId:rule.familyId,date,paidByUserId:rule.paidByUserId,fromAccountId:rule.fromAccountId,toAccountId:rule.toAccountId,amount:rule.amount});
      await mongoose.connection.transaction(async session => {
        const inside=await SavingsAutoExecution.findOne({familyId:rule.familyId,ruleId:rule._id,month:time.monthKey}).session(session);
        if(inside) return;
        const [tx]=await Transaction.create([{
          familyId:rule.familyId,txType:'transfer',date,month:time.monthKey,amount:rule.amount,
          note:`[স্বয়ংক্রিয় সঞ্চয়: ব্যাংকে নিশ্চিত নয়] ${rule.note||''}`.trim(),
          budgetImpact:false,ledgerEligible:false,settlementImpact:false,
          sourceType:'savings_auto',sourceId:rule._id,
          fromAccountId:rule.fromAccountId,toAccountId:rule.toAccountId,paidByUserId:rule.paidByUserId,
          createdByUserId:rule.createdByUserId,
        }],{session});
        await SavingsAutoExecution.create([{familyId:rule.familyId,ruleId:rule._id,month:time.monthKey,transactionId:tx._id}],{session});
        result.recorded++;
      });
    } catch(error) {
      if(error.code===11000) result.already++;
      else result.errors.push({ruleId:String(rule._id),message:String(error.message||error)});
    }
  }
  return result;
}
