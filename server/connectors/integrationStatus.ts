// ENTEGRASYON DURUM PANOSU — BACKEND KAYNAĞI (PHASE2-E).
//
// Üç kavram AYRIDIR ve birbirine dönüştürülmez:
//
//   implementationStage  Bağlayıcı kodu ne kadar olgun?
//                        production      üretimde uçtan uca kanıtlandı
//                        implemented     uygulandı, üretim doğrulaması yok
//                        in_development  bağlayıcı tamamlanmadı
//   rolloutStage         Ürün politikası: kime açık? (`providerCatalog`
//                        ROLLOUT_STAGE_POLICY + taşıyıcı yayın sabitleri —
//                        TEK kaynak; burada kopyalanmaz)
//   connectionHealth     BU çalışma alanındaki bağlantının gerçek durumu
//                        (Entegrasyon Sağlığı + kalıcı doğrulama kayıtları)
//
// Paneldeki grup ("Canlı / İç test / Geliştiriliyor") yalnız ilk ikisinden,
// rozet yalnız sonuncusundan türer. "Canlı" ancak üretimde kanıtlanmış VE
// yayın aşaması canlı davranışa izin veren bağlayıcıya verilir.
import { stageAffectsLiveBehavior, type CapabilityStage } from './connectorKernel.ts'
import type { IntegrationHealth } from './integrationHealth.ts'
import { loadIntegrationHealthForOrganization } from './integrationHealthService.ts'
import { resolveRolloutStage } from './providerCatalog.ts'
import { ARAS_ROLLOUT_STAGE } from '../carriers/aras/arasRollout.ts'
import { listCarrierAccounts } from '../carriers/carrierAccounts.ts'
import type { CarrierAccountRecord } from '../carriers/carrierResolution.ts'
import { listOrganizationMarketplaceAccounts } from '../onboarding/onboardingRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type ImplementationStage = 'production' | 'implemented' | 'in_development'
export type Availability = 'live' | 'internal_test' | 'in_development' | 'hidden'
export type ProviderKind = 'marketplace' | 'commerce_platform' | 'shipping'

export type ConnectionHealthState =
  | 'not_configured'
  | 'configured'
  | 'verified'
  | 'auth_error'
  | 'permission_error'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'disabled'
  | 'not_available'

export interface ConnectionHealthView {
  state: ConnectionHealthState
  configured: boolean
  verified: boolean
  lastVerifiedAt: string | null
  lastSuccessfulSyncAt: string | null
  accountCount: number
}

/** Sürat Kargo üretimde uçtan uca kanıtlı taşıyıcıdır. */
export const SURAT_ROLLOUT_STAGE: CapabilityStage = 'ga'

interface ProviderStatusDefinition {
  providerKey: string
  displayName: string
  kind: ProviderKind
  implementationStage: ImplementationStage
  rolloutStage: () => CapabilityStage
}

/**
 * Uygulama aşaması KOD gerçeğidir (sözleşme paketi, bağlayıcı, test kapsamı);
 * yayın aşaması POLİTİKADIR. Hepsiburada bağlayıcısı uygulandı
 * (HEPSIBURADA-LIVE-001: hesap kapsamlı yalnız-okuma) ama canlı doğrulama
 * YOK → yayın aşaması `internal_test` ("İç test", asla "Canlı"). n11 sipariş
 * sözleşmesi doğrulandı ama bağlantı akışı yok → geliştiriliyor; Ticimax
 * iskelet bağlayıcıdır.
 */
const DEFINITIONS: readonly ProviderStatusDefinition[] = [
  { providerKey: 'trendyol', displayName: 'Trendyol', kind: 'marketplace', implementationStage: 'production', rolloutStage: () => resolveRolloutStage('trendyol') },
  { providerKey: 'surat', displayName: 'Sürat Kargo', kind: 'shipping', implementationStage: 'production', rolloutStage: () => SURAT_ROLLOUT_STAGE },
  { providerKey: 'woocommerce', displayName: 'WooCommerce', kind: 'commerce_platform', implementationStage: 'implemented', rolloutStage: () => resolveRolloutStage('woocommerce') },
  { providerKey: 'ikas', displayName: 'ikas', kind: 'commerce_platform', implementationStage: 'implemented', rolloutStage: () => resolveRolloutStage('ikas') },
  { providerKey: 'aras', displayName: 'Aras Kargo', kind: 'shipping', implementationStage: 'implemented', rolloutStage: () => ARAS_ROLLOUT_STAGE },
  { providerKey: 'hepsiburada', displayName: 'Hepsiburada', kind: 'marketplace', implementationStage: 'implemented', rolloutStage: () => resolveRolloutStage('hepsiburada') },
  { providerKey: 'n11', displayName: 'n11', kind: 'marketplace', implementationStage: 'in_development', rolloutStage: () => 'off' },
  { providerKey: 'ticimax', displayName: 'Ticimax', kind: 'commerce_platform', implementationStage: 'in_development', rolloutStage: () => resolveRolloutStage('ticimax') },
]

export function resolveAvailability(implementation: ImplementationStage, rollout: CapabilityStage): Availability {
  if (implementation === 'in_development') return 'in_development'
  if (implementation === 'production' && stageAffectsLiveBehavior(rollout)) return 'live'
  if (rollout === 'off') return 'hidden'
  // Uygulanmış ama üretim doğrulaması olmayan: canlı politika olsa bile
  // "Canlı" SÖYLENMEZ.
  return 'internal_test'
}

function iso(value: unknown): string | null {
  if (value == null || value === '') return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function latest(values: Array<string | null>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
}

/**
 * Pazaryeri / e-ticaret bağlantısı: Entegrasyon Sağlığı + kalıcı doğrulama.
 *
 * Hata durumları yalnız GÜNCEL kanıttan türer: senkron sınıfı yalnız son
 * senkron BAŞARISIZ ise, doğrulama durumu yalnız hesabın son testi ise
 * sayılır. Eski bir hatanın sonradan başarılı olmuş bağlantıyı
 * "hatalı" göstermesine izin verilmez.
 */
export function connectionHealthFromIntegrationHealth(
  entries: readonly IntegrationHealth[],
  accounts: ReadonlyArray<{ isActive: boolean; verificationStatus?: string | null; lastVerifiedAt?: unknown }>,
): ConnectionHealthView {
  const configuredEntries = entries.filter((entry) => entry.connection !== 'NOT_CONFIGURED')
  const lastSuccessfulSyncAt = latest(configuredEntries.map((entry) => entry.lastSuccessfulSyncAt))
  const lastVerifiedAt = latest(accounts.map((account) => iso(account.lastVerifiedAt)))
  const view = (state: ConnectionHealthState): ConnectionHealthView => ({
    state,
    configured: configuredEntries.length > 0,
    verified: state === 'verified',
    lastVerifiedAt,
    lastSuccessfulSyncAt,
    accountCount: accounts.length,
  })
  if (configuredEntries.length === 0) return view('not_configured')
  if (accounts.length > 0 && accounts.every((account) => !account.isActive)) return view('disabled')
  const failedClasses = configuredEntries
    .filter((entry) => entry.sync === 'FAILED')
    .map((entry) => entry.lastErrorClass)
  const statuses = accounts.filter((account) => account.isActive).map((account) => account.verificationStatus ?? 'unverified')
  if (configuredEntries.some((entry) => entry.connection === 'DISCONNECTED') || failedClasses.includes('AUTH') || statuses.includes('auth_failed')) {
    return view('auth_error')
  }
  if (statuses.includes('permission_denied')) return view('permission_error')
  if (failedClasses.includes('RATE_LIMIT') || statuses.includes('rate_limited')) return view('rate_limited')
  if (failedClasses.includes('PROVIDER_5XX') || failedClasses.includes('NETWORK') || statuses.includes('provider_unavailable')) {
    return view('provider_unavailable')
  }
  return view(statuses.includes('verified') || lastSuccessfulSyncAt !== null ? 'verified' : 'configured')
}

/** Taşıyıcı bağlantısı: kargo hesabının kalıcı doğrulama kaydı. */
export function connectionHealthFromCarrierAccounts(accounts: readonly CarrierAccountRecord[]): ConnectionHealthView {
  const enabled = accounts.filter((account) => account.enabled)
  const base = {
    lastVerifiedAt: latest(enabled.map((account) => account.lastVerifiedAt)),
    lastSuccessfulSyncAt: null,
    accountCount: enabled.length,
  }
  if (enabled.length === 0) {
    return { state: accounts.length > 0 ? 'disabled' : 'not_configured', configured: false, verified: false, ...base }
  }
  const statuses = enabled.map((account) => account.verificationStatus)
  const state: ConnectionHealthState = statuses.includes('verified')
    ? 'verified'
    : statuses.includes('auth_failed')
      ? 'auth_error'
      : statuses.includes('permission_denied')
        ? 'permission_error'
        : statuses.includes('rate_limited')
          ? 'rate_limited'
          : statuses.includes('provider_unavailable')
            ? 'provider_unavailable'
            : 'configured'
  return { state, configured: true, verified: state === 'verified', ...base }
}

export interface IntegrationStatusEntry {
  providerKey: string
  displayName: string
  kind: ProviderKind
  implementationStage: ImplementationStage
  rolloutStage: CapabilityStage
  availability: Availability
  health: ConnectionHealthView
}

const NOT_AVAILABLE: ConnectionHealthView = {
  state: 'not_available',
  configured: false,
  verified: false,
  lastVerifiedAt: null,
  lastSuccessfulSyncAt: null,
  accountCount: 0,
}

/** Panonun tamamı — kiracı kapsamlı, yalnız yerel DB okunur (sağlayıcıya çağrı YOK). */
export async function loadIntegrationStatusBoard(
  db: Db,
  params: { organizationId: string; nowMs?: number },
): Promise<IntegrationStatusEntry[]> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (!organizationId) throw new Error('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  const [health, marketplaceRows, carrierAccounts] = await Promise.all([
    loadIntegrationHealthForOrganization(db, { organizationId, nowMs: params.nowMs ?? Date.now(), resource: 'orders' }),
    listOrganizationMarketplaceAccounts(db, organizationId),
    listCarrierAccounts(db, organizationId),
  ])
  return DEFINITIONS.map((definition) => {
    const rolloutStage = definition.rolloutStage()
    const availability = resolveAvailability(definition.implementationStage, rolloutStage)
    let healthView: ConnectionHealthView = NOT_AVAILABLE
    if (availability !== 'in_development' && availability !== 'hidden') {
      if (definition.kind === 'shipping') {
        healthView = connectionHealthFromCarrierAccounts(
          carrierAccounts.filter((account) => account.provider.toLowerCase() === definition.providerKey),
        )
      } else {
        healthView = connectionHealthFromIntegrationHealth(
          health.filter((entry) => entry.providerKey.toLowerCase() === definition.providerKey),
          marketplaceRows
            .filter((row: Record<string, unknown>) => String(row.marketplace ?? '').toLowerCase() === definition.providerKey)
            .map((row: Record<string, unknown>) => ({
              isActive: row.isActive === true,
              verificationStatus: row.verificationStatus == null ? null : String(row.verificationStatus),
              lastVerifiedAt: row.lastVerifiedAt ?? null,
            })),
        )
      }
    }
    return {
      providerKey: definition.providerKey,
      displayName: definition.displayName,
      kind: definition.kind,
      implementationStage: definition.implementationStage,
      rolloutStage,
      availability,
      health: healthView,
    }
  })
}
