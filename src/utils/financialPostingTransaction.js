import mongoose from "mongoose";

// Mongoose >= 8.4 propagates the transaction session to all Mongoose operations
// created in this async context. The project pins mongoose ^9.2.3.
// DO NOT send HTTP success responses until the transaction has committed.
mongoose.set("transactionAsyncLocalStorage", true);

export function isAtomicUnsupported(error) {
  const message = String(error?.message || "");
  return /Transaction numbers are only allowed on a replica set|replica set|transactions? (?:are |is )?not supported|does not support retryable writes|not allowed on standalone/i.test(message);
}

export function isWriteConflict(error) {
  const message = String(error?.message || "");
  return error?.code === 112 || error?.code === 251 || /WriteConflict|TransientTransactionError/i.test(message);
}

export function atomicPostingError(error) {
  if (isAtomicUnsupported(error)) {
    const failure = new Error("Atomic financial posting requires MongoDB Atlas or a replica-set deployment. No partial entry was saved.");
    failure.status = 503;
    return failure;
  }
  if (error?.code === 11000 || isWriteConflict(error)) {
    const failure = new Error("This entry may already have been saved or edited. Refresh the page before trying again.");
    failure.status = 409;
    return failure;
  }
  return error;
}

export async function runAtomicPosting(work) {
  try {
    // No non-transactional fallback: partial balances are worse than a rejected save.
    return await mongoose.connection.transaction(async () => work());
  } catch (error) {
    throw atomicPostingError(error);
  }
}
