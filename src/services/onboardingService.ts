// Frontend onboarding servisi. Kaynak-of-truth backend'tir; tamamlanma ve adım
// durumu tarayıcıda SAKLANMAZ. Legacy modda (backend 404) onboarding kavramı
// yoktur → null döner ve uygulama normal açılır.
//
// ONBOARDING-001: durum artık sağlayıcı farkında bir projeksiyondur. Hangi
// pazaryerinin kurulabileceği, hangi adımın eksik olduğu ve kurulumun nereden
// sürdürüleceği SUNUCUDA hesaplanır; istemci yalnız gösterir.

export type OnboardingStepKey =
  | 'WELCOME'
  | 'BUSINESS'
  | 'MARKETPLACE'
  | 'CARRIER'
  | 'OPERATIONS'
  | 'FIRST_SYNC'
  | 'READY'

export const ONBOARDING_STEP_ORDER: readonly OnboardingStepKey[] = [
  'WELCOME',
  'BUSINESS',
  'MARKETPLACE',
  'CARRIER',
  'OPERATIONS',
  'FIRST_SYNC',
  'READY',
]

export type OnboardingBootstrapResource = 'orders' | 'products'

export interface OnboardingResourceSync {
  resource: OnboardingBootstrapResource
  state: string
  lastSuccessfulSyncAt: string | null
}

export interface OnboardingAccountView {
  marketplaceAccountId: string
  displayName: string
  isActive: boolean
  credentials: 'PRESENT' | 'ABSENT' | 'NOT_BOUND'
  connection: string
  credentialsRejected: boolean
  sync: OnboardingResourceSync[]
  bootstrapReady: boolean
  /** Kalıcı doğrulama kaydı veya başarılı senkron. */
  verified?: boolean
}

export interface OnboardingMarketplaceView {
  providerKey: string
  displayName: string
  rolloutStage: string
  bootstrapResources: OnboardingBootstrapResource[]
  configured: boolean
  credentialsRejected: boolean
  bootstrapReady: boolean
  /** Kimlik bilgisi gerçek bir kontrolle doğrulandı mı (sunucu). */
  verified: boolean
  accounts: OnboardingAccountView[]
}

export type OnboardingCarrierVerification = 'NOT_CONFIGURED' | 'UNVERIFIED' | 'VERIFIED' | 'FAILED'

export interface OnboardingOperationsAccount {
  marketplaceAccountId: string | null
  providerKey: string
  displayName: string
  carrier:
    | { ok: true; carrierAccountId: string; carrierName: string; source: string }
    | { ok: false; code: string }
  payer: { ok: boolean; source: 'ORDER_CONTRACT' | 'ACCOUNT_CONFIG' | null }
}

export interface OnboardingStepView {
  key: OnboardingStepKey
  required: boolean
  done: boolean
}

export interface OnboardingStatus {
  completed: boolean
  completedAt: string | null
  eligibleToComplete: boolean
  blockers: string[]
  resumeStep: OnboardingStepKey
  steps: OnboardingStepView[]
  marketplaces: OnboardingMarketplaceView[]
  carrier: {
    providerKey: string
    displayName: string
    configured: boolean
    /** Taşıyıcı hesabındaki KALICI doğrulama kaydından (sunucu). */
    verification: OnboardingCarrierVerification
    lastVerifiedAt: string | null
  }
  operations: { resolved: boolean; accounts: OnboardingOperationsAccount[] }
  counts: { products: number; orders: number }
}

const CARRIER_VERIFICATIONS: readonly OnboardingCarrierVerification[] = [
  'NOT_CONFIGURED',
  'UNVERIFIED',
  'VERIFIED',
  'FAILED',
]

export interface OnboardingCompleteResult {
  ok: boolean
  blockers: string[]
  status: OnboardingStatus | null
}

// 401: organization oturumu geçersiz (expired/revoked/disabled/suspended).
// Çağıran taraf auth state'i temizleyip /login'e yönlendirmek için yakalar.
export class UnauthorizedError extends Error {
  status = 401
  constructor() {
    super('Organization oturumu geçersiz.')
    this.name = 'UnauthorizedError'
  }
}

function isStepKey(value: unknown): value is OnboardingStepKey {
  return ONBOARDING_STEP_ORDER.includes(value as OnboardingStepKey)
}

/**
 * Yanıtı güvenli şekle getirir. Eksik alan "tamamlandı" ya da "hazır"
 * ÜRETMEZ: bilinmeyen durum her zaman EKSİK sayılır.
 */
export function normalizeOnboardingStatus(payload: unknown): OnboardingStatus {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const carrier = (raw.carrier && typeof raw.carrier === 'object' ? raw.carrier : {}) as Record<
    string,
    unknown
  >
  const counts = (raw.counts && typeof raw.counts === 'object' ? raw.counts : {}) as Record<
    string,
    unknown
  >
  return {
    completed: raw.completed === true,
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
    eligibleToComplete: raw.eligibleToComplete === true,
    blockers: Array.isArray(raw.blockers) ? raw.blockers.map(String) : [],
    resumeStep: isStepKey(raw.resumeStep) ? raw.resumeStep : 'WELCOME',
    steps: Array.isArray(raw.steps)
      ? (raw.steps as OnboardingStepView[]).filter((step) => isStepKey(step?.key))
      : [],
    marketplaces: Array.isArray(raw.marketplaces)
      ? (raw.marketplaces as OnboardingMarketplaceView[]).map((marketplace) => ({
          ...marketplace,
          // Bilinmeyen durum "doğrulandı" ÜRETMEZ.
          verified: marketplace?.verified === true,
        }))
      : [],
    carrier: {
      providerKey: String(carrier.providerKey ?? 'surat'),
      displayName: String(carrier.displayName ?? 'Sürat Kargo'),
      configured: carrier.configured === true,
      verification: CARRIER_VERIFICATIONS.includes(carrier.verification as OnboardingCarrierVerification)
        ? (carrier.verification as OnboardingCarrierVerification)
        : carrier.configured === true
          ? 'UNVERIFIED'
          : 'NOT_CONFIGURED',
      lastVerifiedAt: typeof carrier.lastVerifiedAt === 'string' ? carrier.lastVerifiedAt : null,
    },
    operations: (() => {
      const operations = (raw.operations && typeof raw.operations === 'object' ? raw.operations : {}) as Record<string, unknown>
      return {
        resolved: operations.resolved === true,
        accounts: Array.isArray(operations.accounts)
          ? (operations.accounts as OnboardingOperationsAccount[])
          : [],
      }
    })(),
    counts: {
      products: Number(counts.products) || 0,
      orders: Number(counts.orders) || 0,
    },
  }
}

// Backend durumu. 404 → legacy mod (onboarding yok) → null. 401 →
// UnauthorizedError. Diğer hatalar genel Error fırlatır.
export async function fetchOnboardingStatus(): Promise<OnboardingStatus | null> {
  const response = await fetch('/api/onboarding/status', {
    credentials: 'include',
  })
  if (response.status === 404) return null
  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) {
    throw new Error(`Onboarding durumu alınamadı (${response.status}).`)
  }
  return normalizeOnboardingStatus(await response.json())
}

// Tamamlama isteği GÖVDESİZDİR: sunucu tüm durumu kendisi yeniden hesaplar;
// istemcinin gönderebileceği bir "tamamlandı" bayrağı YOKTUR.
export async function completeOnboarding(): Promise<OnboardingCompleteResult> {
  const response = await fetch('/api/onboarding/complete', {
    method: 'POST',
    credentials: 'include',
  })
  if (response.status === 401) throw new UnauthorizedError()
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const status = payload ? normalizeOnboardingStatus(payload) : null
  if (response.ok && payload?.ok === true && status?.completed) {
    return { ok: true, blockers: [], status }
  }
  return { ok: false, blockers: status?.blockers ?? [], status }
}
