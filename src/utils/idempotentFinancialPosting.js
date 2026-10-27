import FinancialPostingRequest from '../models/FinancialPostingRequest.js';
import { financialPayloadHash, requireIdempotencyKey } from './idempotencyPayload.js';
import { runAtomicPosting } from './financialPostingTransaction.js';

// Explicit index initialization is required even with autoIndex=false in
// production. Fail closed if index creation is unavailable: otherwise concurrent
// POSTs could double-charge an account.
let uniqueIndexReady;
async function guaranteeUniqueIndex() {
  if (!uniqueIndexReady) {
    uniqueIndexReady = FinancialPostingRequest.collection.createIndex(
      { familyId: 1, operation: 1, key: 1 },
      { unique: true, name: 'financial_posting_request_key' }
    ).catch((error) => {
      uniqueIndexReady = null; // allow recovery after a transient DB outage
      const failure = new Error(`Financial duplicate-prevention index unavailable: ${error.message}`);
      failure.status = 503;
      throw failure;
    });
  }
  await uniqueIndexReady;
}

function postingIdentity(req, operation) {
  return {
    familyId: req.familyId,
    operation,
    key: requireIdempotencyKey(req.headers),
    payloadHash: financialPayloadHash(req.body),
  };
}

function checkReplay(record, payloadHash) {
  if (!record) return null;
  if (record.payloadHash !== payloadHash) {
    const error = new Error('This request key was already used with different details. Review your entry before saving a new one.');
    error.status = 409;
    throw error;
  }
  if (!record.resultId) {
    const error = new Error('The first request is still being processed; retry with the same details.');
    error.status = 409;
    throw error;
  }
  return { resultId: record.resultId, replayed: true };
}

export async function existingFinancialPosting(req, operation) {
  const identity = postingIdentity(req, operation);
  await guaranteeUniqueIndex();
  const prior = await FinancialPostingRequest.findOne({
    familyId: identity.familyId, operation: identity.operation, key: identity.key,
  }).lean();
  return checkReplay(prior, identity.payloadHash);
}

export async function createIdempotentFinancialPosting(req, operation, write) {
  const identity = postingIdentity(req, operation);
  await guaranteeUniqueIndex();
  const prior = await existingFinancialPosting(req, operation);
  if (prior) return prior;

  try {
    return await runAtomicPosting(async () => {
      // The unique index serializes requests with the same key; the new
      // financial record and this receipt commit or roll back together.
      const [request] = await FinancialPostingRequest.create([{
        ...identity, resultId: null, createdByUserId: req.user.userId,
      }]);
      const resultId = await write();
      if (!resultId) throw new Error('Financial posting did not produce a record ID');
      await FinancialPostingRequest.updateOne(
        { _id: request._id }, { $set: { resultId } }
      );
      return { resultId, replayed: false };
    });
  } catch (error) {
    // If a concurrent request committed first (or the HTTP response was lost),
    // return its original record rather than creating a second cash movement.
    const replay = await existingFinancialPosting(req, operation);
    if (replay) return replay;
    if (error.status === 409 || error.code === 11000) {
      const inFlight = new Error('The same save may already be in progress. Retry with the same form and key; no new entry is needed.');
      inFlight.status = 409;
      throw inFlight;
    }
    throw error;
  }
}
