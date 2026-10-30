import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  familyId:{type:mongoose.Schema.Types.ObjectId,ref:'Family',required:true},
  ruleId:{type:mongoose.Schema.Types.ObjectId,ref:'SavingsAutoRule',required:true},
  month:{type:String,required:true},
  transactionId:{type:mongoose.Schema.Types.ObjectId,ref:'Transaction',required:true},
},{timestamps:true});
schema.index({familyId:1,ruleId:1,month:1},{unique:true});
export default mongoose.model('SavingsAutoExecution',schema);
