import mongoose from 'mongoose';
import { Router } from 'express';
import GroceryChecklistItem from '../models/GroceryChecklistItem.js';
import { requireAuth } from '../middlewares/auth.js';
import { requireFamily } from '../middlewares/familyGuard.js';

const router = Router();
router.use(requireAuth, requireFamily);
const safeText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validId = (id) => mongoose.isValidObjectId(id);

router.get('/', async (req, res) => {
  try {
    const items = await GroceryChecklistItem.find({ familyId: req.familyId }).sort({ createdAt: 1, _id: 1 }).lean();
    res.json({ ok: true, items });
  } catch (error) { res.status(500).json({ ok:false, message: 'বাজারের তালিকা আনা যায়নি।' }); }
});
router.post('/', async (req, res) => {
  try {
    // Both fields are intentionally optional. A blank row can be filled later.
    if (req.body?.name !== undefined && typeof req.body.name !== 'string') return res.status(400).json({ok:false,message:'পণ্যের নাম সঠিক নয়।'});
    if (req.body?.quantity !== undefined && typeof req.body.quantity !== 'string') return res.status(400).json({ok:false,message:'পরিমাণ সঠিক নয়।'});
    const item = await GroceryChecklistItem.create({
      familyId: req.familyId,
      name: safeText(req.body?.name, 160),
      quantity: safeText(req.body?.quantity, 80),
    });
    res.status(201).json({ok:true,item});
  } catch (error) {res.status(500).json({ok:false,message:'পণ্য যোগ করা যায়নি।'});}
});
router.patch('/:id', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ok:false,message:'আইডি সঠিক নয়।'});
  const update = {};
  for (const key of ['name','quantity']) {
    if (req.body?.[key] !== undefined) {
      if(typeof req.body[key] !== 'string') return res.status(400).json({ok:false,message:'তথ্য সঠিক নয়।'});
      update[key] = safeText(req.body[key], key === 'name' ? 160 : 80);
    }
  }
  if (req.body?.checked !== undefined) {
    if(typeof req.body.checked !== 'boolean') return res.status(400).json({ok:false,message:'চেকবক্স সঠিক নয়।'});
    update.checked = req.body.checked;
  }
  if(!Object.keys(update).length) return res.status(400).json({ok:false,message:'কোনো পরিবর্তন নেই।'});
  try {
    const item = await GroceryChecklistItem.findOneAndUpdate({ _id:req.params.id, familyId:req.familyId }, {$set:update},{new:true,runValidators:true});
    if(!item) return res.status(404).json({ok:false,message:'পণ্যটি পাওয়া যায়নি।'});
    res.json({ok:true,item});
  } catch(error) {res.status(500).json({ok:false,message:'পরিবর্তন সংরক্ষণ করা যায়নি।'});}
});
router.delete('/:id', async(req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({ok:false,message:'আইডি সঠিক নয়।'});
  try {
    const item = await GroceryChecklistItem.findOneAndDelete({_id:req.params.id,familyId:req.familyId});
    if(!item) return res.status(404).json({ok:false,message:'পণ্যটি পাওয়া যায়নি।'});
    res.json({ok:true});
  } catch(error){res.status(500).json({ok:false,message:'পণ্যটি মুছতে সমস্যা হয়েছে।'});}
});
export default router;
