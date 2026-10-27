import { Router } from 'express';
import mongoose from 'mongoose';
import Account from '../models/Account.js';
import CreditCardStatement from '../models/CreditCardStatement.js';
import { requireAuth } from '../middlewares/auth.js';
import { requireFamily } from '../middlewares/familyGuard.js';
import { cardStatementCoverage, isCardCandidate, validateStatement } from '../utils/creditCardStatements.js';
import { validMonth } from '../utils/reconciledAccountMath.js';

const router = Router();
router.use(requireAuth, requireFamily);

// The only mutation is an explicit statement snapshot; NOT a cash/ledger post.
// Legacy bank-type accounts are recognized by their existing name for review.
router.get('/', async (req, res) => {
  try {
    const month = String(req.query.month || '');
    if (!validMonth(month)) return res.status(400).json({ ok: false, message: 'Month must be YYYY-MM' });
    const accounts = (await Account.find({ familyId: req.familyId }).select('_id name owner').lean()).filter(isCardCandidate);
    const statements = accounts.length ? await CreditCardStatement.find({ familyId: req.familyId, month, accountId: { $in: accounts.map(a => a._id) } }).lean() : [];
    return res.json({ ok: true, data: cardStatementCoverage(accounts, statements, month) });
  } catch (e) {
    console.error('Credit card statements read failed:', e);
    return res.status(500).json({ ok: false, message: 'Failed to read card statements' });
  }
});

router.put('/:accountId/:month', async (req, res) => {
  try {
    const { accountId, month } = req.params;
    if (!mongoose.isValidObjectId(accountId)) return res.status(400).json({ ok: false, message: 'Invalid account' });
    const err = validateStatement({ month, amount: req.body?.outstanding });
    if (err) return res.status(400).json({ ok: false, message: err });
    const account = await Account.findOne({ _id: accountId, familyId: req.familyId }).select('_id name').lean();
    if (!account) return res.status(404).json({ ok: false, message: 'Account not found' });
    if (!isCardCandidate(account)) return res.status(400).json({ ok: false, message: 'Only credit-card-named accounts can use this provisional statement tracker' });
    const note = String(req.body?.note || '').trim();
    if (note.length > 300) return res.status(400).json({ ok: false, message: 'Note is too long' });
    const statement = await CreditCardStatement.findOneAndUpdate(
      { familyId: req.familyId, accountId: account._id, month },
      { $set: { outstanding: Number(req.body.outstanding), note } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    return res.json({ ok: true, item: statement });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ ok: false, message: 'Statement was saved concurrently; refresh and retry' });
    console.error('Credit card statement save failed:', e);
    return res.status(500).json({ ok: false, message: 'Could not save card statement' });
  }
});

export default router;
