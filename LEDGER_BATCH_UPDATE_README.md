# হিসাব নিকাশ — Ledger multi-entry update (6 November 2026)

## What's new

Open **আয়-খরচ** and select **একসঙ্গে হিসাব যোগ**. Choose a date, add 2–30 rows, edit each row independently, and use **সব হিসাব যাচাই করুন** to review the complete day's entries. Click **সব ...টি হিসাব সংরক্ষণ করুন** to post them together.

The original **নতুন হিসাব** single-entry form and individual edit/delete actions are unchanged. No existing transactions are rewritten or migrated.

Each submitted row becomes its **own** normal `Transaction`, with its own `LedgerEntry` and member `Split` where applicable. Transfers remain account movements and don't create expense ledger rows. Supported transaction types: income, expense, transfer. Expenses may have a single payer or joint payment, and personal/equal/ratio/fixed expense allocation. Choose the payer, account, category and allocation independently for each row.

The whole batch is **all-or-nothing** using the app's existing MongoDB transaction and permanent idempotency scheme: a validation error in row N cancels the batch; repeating a successful request with the same key does not double-post. Historical protection and month locking apply exactly as for single entries. Transaction records are not grouped into a single lump sum for dashboards or reports.

## Files changed

Client:
- `src/pages/Ledger.jsx` (adds batch action and hooks it to the ledger refresh)
- `src/components/ledger/LedgerBatchModal.jsx` (new batch form, row actions, validation, review and save)
- `scripts/verify-ledger-batch.mjs` (source-level integration assertions)

Server:
- `src/routes/transaction.route.js` (adds `POST /api/transactions/batch` before existing single-item POST)
- `src/models/ManualTransactionBatch.js` (small receipt containing separate transaction IDs)
- `src/models/FinancialPostingRequest.js` (recognizes new idempotent operation)
- `tests/manual-batch-entry.test.mjs` (regression assertions)

## Installation / release

1. **Back up both of your current projects and any `.env` files first.** Environment files are deliberately omitted from these ZIPs so live keys are not redistributed. Do not remove your existing `.env` values.
2. Copy the updated **server** project files into the corresponding backend repository, keeping your own environment variables, then deploy the backend on Vercel.
3. Copy the updated **client** files into the corresponding frontend repository, keeping your own environment variables. Install dependencies with `npm ci`, then run `npm run build` and deploy the client on Vercel.
4. If your Android version bundles web assets, rebuild/sync its native project from the updated client (`npm run build`, `npx cap sync android`) and publish an updated APK/AAB. If the Android app instead loads the deployed website, the deployed client may be sufficient.
5. Test by entering two small sample expense rows using the new action; confirm two separate records in Ledger and expected account/Wallet totals. Verify joint payment and a transfer separately before general use.

The server uses the app's existing MongoDB Atlas/replica-set requirement for atomic financial posts; no manual database migration is needed. Existing data is not modified by installation.

## API contract

`POST /api/transactions/batch`

Headers: normal Authorization and `Idempotency-Key` (unique UUID per changed batch).

Request: `{ "date": "2026-11-06", "entries": [<same transaction fields as POST /api/transactions>, ...] }`

Response: `{ "ok": true, "savedCount": 2, "transactionIds": ["...", "..."], "replayed": false }`

Each entry's date is forced to the selected date. At least 2 and at most 30 entries; all are validated with existing transaction rules, including member account ownership, split sums, category type and month lock. On an invalid row, the response identifies that row and saves none.

## Checks performed

- Server test suite: **240 passed**, including 4 new batch-focused checks.
- Frontend JSX parsed successfully using TypeScript compiler's React JSX transpilation; batch integration source assertions passed.
- Local transaction-field logic checked for expense, income, transfer, joint payments, incorrect total and wrong-member account selection.
- A full Vite production build and live MongoDB end-to-end run were **not** possible in this offline tool environment (dependency installation stalled). Please run `npm ci && npm run build` and a staging test before production deployment.
