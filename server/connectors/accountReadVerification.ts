import { recordMarketplaceVerification, type VerificationStatus } from '../carriers/carrierAccounts.ts'
import { credentialFingerprint } from '../integrations/credentialService.ts'
import { accountOrdersReadPayload } from './accountOrdersReadGate.ts'

/** Common safe-read classification; stable provider reasons stay with the caller. */
export function classifyAccountReadProbe(result: { ok: boolean; errorClass?: string }): VerificationStatus {
  if (result.ok) return 'verified'
  switch (result.errorClass) {
    case 'AUTH_ERROR': return 'auth_failed'
    case 'RATE_LIMITED': return 'rate_limited'
    case 'PROVIDER_UNAVAILABLE': return 'provider_unavailable'
    default: return 'unverified'
  }
}

export async function recordAccountReadProbe(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  scope: { organizationId: string; marketplaceAccountId: string; providerKey: string },
  payload: Record<string, unknown>,
  result: { ok: boolean; errorClass?: string },
  now: Date,
): Promise<{ verificationStatus: VerificationStatus; recorded: boolean }> {
  const fingerprint = credentialFingerprint(accountOrdersReadPayload(scope.providerKey, payload))
  if (!fingerprint) return { verificationStatus: 'unverified', recorded: false }
  const verificationStatus = classifyAccountReadProbe(result)
  const recorded = await recordMarketplaceVerification(db, {
    ...scope, status: verificationStatus, expectedFingerprint: fingerprint, now,
  })
  return { verificationStatus: recorded ? verificationStatus : 'unverified', recorded }
}
