/**
 * Monthly spendable-cash movement from actual Transaction rows, not Ledger
 * allocations. All arithmetic is in cents. Previous-month cash is excluded.
 * Transfers between liquid accounts cancel at household level; transfers to
 * savings/investment reduce spendable cash but are not household expenses.
 * This is a pure function and does not access any database.
 */
import { accountIdOf, LIQUID_TYPES, toCents, fromCents } from "./reconciledAccountMath.js";

const LIQUID = new Set(LIQUID_TYPES);
const NONLIQUID = new Set(["savings", "investment"]);

function empty() {
  return {
    income: 0,
    expenses: 0,
    emiPaid: 0,
    cardRepayments: 0,
    sharedPurchasePaidUpfront: 0,
    otherExpenses: 0,
    savedOrInvested: 0,
    savingsWithdrawn: 0,
    transfersIn: 0,
    transfersOut: 0,
    remainingFromMonth: 0,
  };
}

function add(row, field, cents) { row[field] += cents; }
const missingId = (id) => !accountIdOf(id);

/**
 * Returns money movements grouped by actual account owner, and at household
 * level. The owner may be Mahbub, Mirza, Joint or another saved owner.
 */
export function calculateMonthlyLiquidFlow(accounts = [], transactions = []) {
  const byId = new Map(accounts.map((account) => [accountIdOf(account._id ?? account.accountId), account]));
  const issues = [];
  const rawByOwner = {};
  const household = empty();
  const ownerOf = (account) => account.owner || "Unassigned";
  const ownerRow = (account) => {
    const owner = ownerOf(account);
    if (!rawByOwner[owner]) rawByOwner[owner] = empty();
    return rawByOwner[owner];
  };
  const getAccount = (id, txId, role) => {
    const acc = byId.get(accountIdOf(id));
    if (!acc) issues.push({ code: "UNKNOWN_ACCOUNT", transactionId: txId, role, accountId: accountIdOf(id) });
    return acc;
  };
  const isLiquid = (account) => account && LIQUID.has(account.type);
  const isNonLiquid = (account) => account && NONLIQUID.has(account.type);

  for (const tx of transactions) {
    const id = accountIdOf(tx._id) || "unknown";
    const cents = toCents(tx.amount);
    if (!Number.isFinite(cents) || cents <= 0) {
      issues.push({ code: "INVALID_TRANSACTION_AMOUNT", transactionId: id });
      continue;
    }
    if (tx.txType === "income") {
      const to = getAccount(tx.toAccountId, id, "income_to");
      if (isLiquid(to)) {
        add(household, "income", cents);
        add(ownerRow(to), "income", cents);
      }
    } else if (tx.txType === "expense") {
      let payments;
      if (tx.paymentMode === "split") {
        payments = tx.paymentParts || [];
        if (!payments.length || payments.reduce((sum, part) => sum + toCents(part.amount), 0) !== cents || payments.some((part) => toCents(part.amount) <= 0)) {
          issues.push({ code: "INVALID_SPLIT_FUNDING", transactionId: id });
          continue;
        }
      } else payments = [{ accountId: tx.fromAccountId, amount: tx.amount }];
      for (const payment of payments) {
        const from = getAccount(payment.accountId, id, "expense_from");
        if (!isLiquid(from)) continue;
        const amount = toCents(payment.amount);
        const category = tx.sourceType === "credit_card_repayment" ? "cardRepayments"
          : tx.sourceType === "emi_installment" ? "emiPaid"
          : tx.sourceType === "shared_purchase" ? "sharedPurchasePaidUpfront"
            : "otherExpenses";
        for (const row of [household, ownerRow(from)]) {
          add(row, "expenses", amount);
          add(row, category, amount);
        }
      }
    } else if (tx.txType === "transfer") {
      const from = getAccount(tx.fromAccountId, id, "transfer_from");
      const to = getAccount(tx.toAccountId, id, "transfer_to");
      // Never guess a missing account's type. A valid transfer with a missing
      // endpoint must be reviewed rather than fabricating remaining income.
      if (!from || !to) continue;
      if (isLiquid(from) && isLiquid(to)) {
        // Household has neither earned nor spent money. Person-to-person
        // repayments change the owner's personal cash net movement only.
        if (ownerOf(from) !== ownerOf(to)) {
          add(ownerRow(from), "transfersOut", cents);
          add(ownerRow(to), "transfersIn", cents);
        }
      } else if (isLiquid(from) && isNonLiquid(to)) {
        add(household, "savedOrInvested", cents);
        add(ownerRow(from), "savedOrInvested", cents);
      } else if (isNonLiquid(from) && isLiquid(to)) {
        add(household, "savingsWithdrawn", cents);
        add(ownerRow(to), "savingsWithdrawn", cents);
      }
    } else issues.push({ code: "UNKNOWN_TRANSACTION_TYPE", transactionId: id });
  }

  function finalized(row) {
    const net = row.income - row.expenses - row.savedOrInvested + row.savingsWithdrawn + row.transfersIn - row.transfersOut;
    return Object.fromEntries(Object.entries({ ...row, remainingFromMonth: net }).map(([key, val]) => [key, fromCents(val)]));
  }

  return {
    household: finalized(household),
    byOwner: Object.fromEntries(Object.entries(rawByOwner).map(([key, row]) => [key, finalized(row)])),
    issues,
    basis: "posted_liquid_account_transactions",
    excludesPriorCash: true,
    notes: "Actual cash movements, not allocated expenses. Unpaid bills or installments are not deducted until recorded as payments.",
  };
}
