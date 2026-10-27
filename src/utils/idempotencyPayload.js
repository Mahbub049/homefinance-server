import { createHash } from 'node:crypto';

// Hash the normalized *request*, not a guessed business signature (same
// date/amount might represent two genuinely different grocery purchases).
export function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map((part) => stableJSON(part ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function financialPayloadHash(value) {
  return createHash('sha256').update(stableJSON(value ?? {})).digest('hex');
}

export function requireIdempotencyKey(headers) {
  const raw = headers?.['idempotency-key'];
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(raw)) {
    const error = new Error('An Idempotency-Key header (16–128 letters, digits, . _ : -) is required to safely save financial entries. Update the client.');
    error.status = 400;
    throw error;
  }
  return raw;
}
