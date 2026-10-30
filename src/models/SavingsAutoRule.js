import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  familyId: {type: mongoose.Schema.Types.ObjectId, ref:'Family',required:true,index:true},
  paidByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  fromAccountId:{type:mongoose.Schema.Types.ObjectId,ref:'Account',required:true},
  toAccountId:{type:mongoose.Schema.Types.ObjectId,ref:'Account',required:true},
  amount:{type:Number,required:true,min:0.01},
  dayOfMonth:{type:Number,required:true,min:1,max:31},
  startMonth:{type:String,required:true},
  endMonth:{type:String,default:''},
  note:{type:String,default:''},
  active:{type:Boolean,default:true,index:true},
  createdByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
},{timestamps:true});
export default mongoose.model('SavingsAutoRule',schema);
