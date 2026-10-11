// TAŞIYICI HESABI ÇÖZÜMLEMESİ — SAF (DB/ağ YOK).
//
// Onboarding'in OPERATIONS adımı ve gönderi ön kontrolü AYNI kuralı kullanır;
// ikinci bir çözümleyici YOKTUR. Kural ve gerekçe: carrierAccounts.ts başı.
export const VERIFICATION_STATUSES = [
  'unverified',
  'verified',
  'auth_failed',
  'permission_denied',
  'provider_unavailable',
  'rate_limited',
] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export interface CarrierAccountRecord {
  id: string
  provider: string
  displayName: string
  externalAccountRef: string | null
  credentialRef: string
  verificationStatus: VerificationStatus
  lastVerifiedAt: string | null
  lastVerificationAttemptAt: string | null
  enabled: boolean
}

export interface CarrierMappingRecord {
  marketplaceAccountId: string
  carrierAccountId: string
}

/* ─── Çözümleme ──────────────────────────────────────────────────────── */

export type CarrierResolutionSource = 'EXPLICIT_MAPPING' | 'ONLY_ACCOUNT_FOR_PROVIDER'
export type CarrierResolutionError =
  | 'CARRIER_ACCOUNT_NOT_CONFIGURED'
  | 'CARRIER_ACCOUNT_DISABLED'
  | 'CARRIER_MAPPING_PROVIDER_MISMATCH'
  | 'CARRIER_ACCOUNT_AMBIGUOUS'

export type CarrierResolution =
  | { ok: true; account: CarrierAccountRecord; source: CarrierResolutionSource }
  | { ok: false; code: CarrierResolutionError }

/** SAF çözümleyici — DB'siz; onboarding ve gönderi ön kontrolü AYNI kuralı kullanır. */
export function resolveCarrierAccountFromRecords(
  accounts: readonly CarrierAccountRecord[],
  mappings: readonly CarrierMappingRecord[],
  params: { provider: string; marketplaceAccountId: string | null },
): CarrierResolution {
  const provider = params.provider.toLowerCase()
  if (params.marketplaceAccountId) {
    const mapping = mappings.find((entry) => entry.marketplaceAccountId === params.marketplaceAccountId)
    if (mapping) {
      const account = accounts.find((entry) => entry.id === mapping.carrierAccountId)
      if (!account) return { ok: false, code: 'CARRIER_ACCOUNT_NOT_CONFIGURED' }
      if (account.provider.toLowerCase() !== provider) return { ok: false, code: 'CARRIER_MAPPING_PROVIDER_MISMATCH' }
      if (!account.enabled) return { ok: false, code: 'CARRIER_ACCOUNT_DISABLED' }
      return { ok: true, account, source: 'EXPLICIT_MAPPING' }
    }
  }
  const candidates = accounts.filter((entry) => entry.enabled && entry.provider.toLowerCase() === provider)
  if (candidates.length === 1) return { ok: true, account: candidates[0], source: 'ONLY_ACCOUNT_FOR_PROVIDER' }
  if (candidates.length === 0) return { ok: false, code: 'CARRIER_ACCOUNT_NOT_CONFIGURED' }
  return { ok: false, code: 'CARRIER_ACCOUNT_AMBIGUOUS' }
}

/** Sürat test sonucu → kalıcı doğrulama sınıfı (ham sağlayıcı metni TAŞINMAZ). */
export function classifySuratConnectionTest(result: { ok: boolean; authError: boolean; transportOk: boolean }): VerificationStatus {
  if (result.ok) return 'verified'
  if (result.authError) return 'auth_failed'
  if (!result.transportOk) return 'provider_unavailable'
  return 'auth_failed'
}
