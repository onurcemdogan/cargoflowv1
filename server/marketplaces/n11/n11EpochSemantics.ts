/**
 * Official shipmentPackages docs checked 2026-10-14:
 * https://developer.n11.com/documentation/n11-siparis-entegrasyonu/siparis-listeleme-servisi/
 * Milliseconds + GMT+3 are stated, but no numeric request is paired with a
 * local datetime and no conversion algorithm is specified. See the ticket's
 * evidence record. Existing wire values remain unchanged; no guessed shift.
 * This is provider contract evidence, separate from account authentication.
 * No request-body, credential, environment or rollout flag can verify it.
 */
export const N11_EPOCH_VERIFICATION = Object.freeze({
  status: 'BLOCKED_EXTERNAL',
  semantics: 'UNKNOWN',
  reasonCode: 'N11_EPOCH_SEMANTICS_UNVERIFIED',
} as const)
