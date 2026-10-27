import mongoose from 'mongoose';
import { Router } from 'express';
import Account from '../models/Account.js';
import CreditCardPayment from '../models/CreditCardPayment.js';
import Transaction from '../models/Transaction.js';
import MonthlyBalance from '../models/MonthlyBalance.js';
import { requireAuth } from '../middlewares/auth.js';
import { requireFamily } from '../middlewares/familyGuard.js';
import { isCardCandidate } from '../utils/creditCardStatements.js';
import { activePaymentSummary, REPAYMENT_SOURCE, validateCardRepayment, validateCardFunding } from '../utils/creditCardPayments.js';
import { validMonth } from '../utils/reconciledAccountMath.js';
import { createIdempotentFinancialPosting } from '../utils/idempotentFinancialPosting.js';
import { runAtomicPosting, atomicPostingError } from '../utils/financialPostingTransaction.js';

const router = Router();
router.use(requireAuth, requireFamily);
const parseObjectId = value => mongoose.isValidObjectId(value) ? String(value) : null;
const errorStatus = (res, error) => res.status(error.status || 500).json({ ok: false, message: error.status ? error.message : 'Credit card payment operation failed.' });

async function requireOpenMonth(familyId, month) {
  const closed = await MonthlyBalance.exists({ familyId, month, closingBalance: { $ne: null } });
  if (closed) {
    const err = new Error('This month has been closed. Do not change financial records in a closed month.');
    err.status = 409;
    throw err;
  }
}

// Read-only payment history: independent of manually entered statement balances.
router.get('/', async (req, res) => {
  try {
    const month = String(req.query.month || '');
    if (!validMonth(month)) return res.status(400).json({ ok: false, message: 'Month must be YYYY-MM.' });
    const cardId = req.query.cardAccountId ? parseObjectId(req.query.cardAccountId) : null;
    if (req.query.cardAccountId && !cardId) return res.status(400).json({ ok: false, message: 'Invalid card account.' });
    const [accounts, payments] = await Promise.all([
      Account.find({ familyId: req.familyId }).select('_id name type owner isActive').lean(),
      CreditCardPayment.find({ familyId: req.familyId, month, ...(cardId ? { cardAccountId: cardId } : {}) })
        .sort({ date: -1, createdAt: -1 }).lean(),
    ]);
    const byId = new Map(accounts.map(a => [String(a._id), a]));
    const listed = payments.map(p => ({
      id: String(p._id), month: p.month, date: new Date(p.date).toISOString().slice(0, 10),
      cardAccountId: String(p.cardAccountId), fromAccountId: String(p.fromAccountId),
      cardName: byId.get(String(p.cardAccountId))?.name || '(deleted card)',
      fromName: byId.get(String(p.fromAccountId))?.name || '(deleted account)',
      amount: p.amount, note: p.note, status: p.status,
    }));
    const cards = accounts.filter(isCardCandidate).map(a => ({ id: String(a._id), name: a.name, owner: a.owner }));
    const fundingAccounts = accounts.filter(a => a.isActive !== false && ['bank', 'cash', 'wallet'].includes(a.type) && !isCardCandidate(a))
      .map(a => ({ id: String(a._id), name: a.name, owner: a.owner, type: a.type }));
    res.json({ ok: true, data: { month, cards, fundingAccounts, payments: listed, summary: activePaymentSummary(payments) } });
  } catch (err) { console.error('Card repayments read failed', err); res.status(500).json({ ok: false, message: 'Unable to load card repayment history.' }); }
});

// One bank-account debit, NOT another Ledger expense or new EMI payment.
// An Idempotency-Key protects against double-submit, retries, and lost replies.
router.post('/', async (req, res) => {
  try {
    const cardAccountId = parseObjectId(req.body?.cardAccountId);
    const fromAccountId = parseObjectId(req.body?.fromAccountId);
    if (!cardAccountId || !fromAccountId) return res.status(400).json({ ok: false, message: 'Card and funding accounts are required.' });
    const parsed = validateCardRepayment(req.body);
    if (parsed.error) return res.status(400).json({ ok: false, message: parsed.error });
    const { month, date, amount, note } = parsed.data;
    await requireOpenMonth(req.familyId, month);
    const accounts = await Account.find({ familyId: req.familyId, _id: { $in: [cardAccountId, fromAccountId] } })
      .select('_id name type owner isActive').lean();
    const card = accounts.find(a => String(a._id) === cardAccountId);
    const funding = accounts.find(a => String(a._id) === fromAccountId);
    const issue = validateCardFunding(card, funding);
    if (issue) return res.status(400).json({ ok: false, message: issue });

    const posting = await createIdempotentFinancialPosting(req, 'creditCard.payment', async () => {
      // Recheck inside MongoDB transaction: no partially posted cash records.
      await requireOpenMonth(req.familyId, month);
      const paymentId = new mongoose.Types.ObjectId();
      const transactionId = new mongoose.Types.ObjectId();
      await Transaction.create([{
        _id: transactionId, familyId: req.familyId, txType: 'expense',
        date, month, amount,
        note: `Credit card repayment: ${card.name}${note ? ` — ${note}` : ''}`,
        fromAccountId: funding._id, paidByUserId: req.user.userId,
        budgetImpact: false, ledgerEligible: false, settlementImpact: false,
        sourceType: REPAYMENT_SOURCE, sourceId: paymentId,
        paymentMode: 'single',
        createdByUserId: req.user.userId,
      }]);
      await CreditCardPayment.create([{
        _id: paymentId, familyId: req.familyId, cardAccountId: card._id,
        fromAccountId: funding._id, transactionId, date, month, amount,
        note, createdByUserId: req.user.userId,
      }]);
      return paymentId;
    });
    const item = await CreditCardPayment.findOne({ _id: posting.resultId, familyId: req.familyId }).lean();
    if (!item || item.status !== 'posted') return res.status(409).json({ ok: false, message: 'This request already recorded a payment that was subsequently voided. Refresh the page.' });
    return res.status(posting.replayed ? 200 : 201).json({ ok: true, replayed: posting.replayed, id: String(item._id) });
  } catch (err) { console.error('Card repayment save failed:', err); return errorStatus(res, err); }
});

// Explicit reversal for mistaken new-month entries. Keep an audit row and
// discard only the managed cash debit; never rewrite bank snapshots or Ledger.
router.post('/:id/void', async (req, res) => {
  try {
    if (!parseObjectId(req.params.id)) return res.status(400).json({ ok: false, message: 'Invalid payment.' });
    const item = await CreditCardPayment.findOne({ _id: req.params.id, familyId: req.familyId }).lean();
    if (!item) return res.status(404).json({ ok: false, message: 'Payment not found.' });
    if (item.status !== 'posted') return res.status(409).json({ ok: false, message: 'Payment was already voided.' });
    await requireOpenMonth(req.familyId, item.month);
    await runAtomicPosting(async () => {
      await requireOpenMonth(req.familyId, item.month);
      const debit = await Transaction.findOne({ _id: item.transactionId, familyId: req.familyId, sourceType: REPAYMENT_SOURCE, sourceId: item._id });
      if (!debit) {
        const err = new Error('Linked bank debit is missing. Review this payment; no records changed.');
        err.status = 409;
        throw err;
      }
      const changed = await CreditCardPayment.updateOne({ _id: item._id, familyId: req.familyId, status: 'posted' }, { $set: { status: 'voided', voidedAt: new Date(), voidedByUserId: req.user.userId } });
      if (changed.modifiedCount !== 1) {
        const err = new Error('Payment was already changed. Refresh and retry.');
        err.status = 409;
        throw err;
      }
      await Transaction.deleteOne({ _id: debit._id, familyId: req.familyId });
    });
    return res.json({ ok: true, message: 'Repayment voided; the corresponding bank debit was reversed. Statement snapshots were not changed.' });
  } catch (err) { console.error('Card repayment void failed:', err); return errorStatus(res, atomicPostingError(err)); }
});

export default router;
