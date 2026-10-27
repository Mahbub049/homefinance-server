import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { requireFamily } from '../middlewares/familyGuard.js';
import EMIPlan from '../models/EMIPlan.js';
import EMIInstallment from '../models/EMIInstallment.js';
import CreditCardStatement from '../models/CreditCardStatement.js';
import { isCardCandidate } from '../utils/creditCardStatements.js';
import { loadReconciledMonth } from '../utils/reconciledAccounts.js';
import { assemblePosition, summarizeRegisteredEmiBalance } from '../utils/financialPosition.js';

const router = Router();

// READ ONLY: financial position at end of selected month. No Ledger investment
// is added separately: it can duplicate cash transferred to investment accounts.
// Credit-card debt is deliberately UNKNOWN until card payment/billing semantics
// and historical classification can be safely introduced.
router.get('/', requireAuth, requireFamily, async (req, res) => {
  try {
    const month = String(req.query.asOfMonth || req.query.month || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ ok: false, message: 'asOfMonth must be YYYY-MM' });
    }
    const [statement, plans] = await Promise.all([
      loadReconciledMonth(req.familyId, month),
      EMIPlan.find({ familyId: req.familyId, startMonth: { $lte: month } })
        .select('_id status startMonth totalPayable').lean(),
    ]);
    const installments = plans.length ? await EMIInstallment.find({
      familyId: req.familyId, planId: { $in: plans.map((plan) => plan._id) }, status: 'paid',
    }).select('planId status month amount paidAt').lean() : [];
    const obligation = summarizeRegisteredEmiBalance(plans, installments, month);
    const cardAccounts = statement.closing.accounts.filter(isCardCandidate);
    const cardStatements = cardAccounts.length ? await CreditCardStatement.find({
      familyId: req.familyId, month, accountId: { $in: cardAccounts.map(a => a.accountId) },
    }).select('accountId month outstanding note').lean() : [];
    const result = assemblePosition(statement.closing.accounts, obligation, { ...statement, month }, cardStatements);
    return res.json({ ok: true, data: { asOfMonth: month, ...result } });
  } catch (error) {
    console.error('Financial position report failed:', error);
    res.status(500).json({ ok: false, message: 'Could not calculate recorded position' });
  }
});
export default router;
