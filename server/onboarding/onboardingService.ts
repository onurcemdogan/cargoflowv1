// Onboarding durum yükleyicisi + tamamlama. Karar `onboardingModel.ts`
// içindeki TEK değerlendiricidedir; bu dosya yalnız kabul edilmiş kaynaklardan
// anlık görüntüyü toplar:
//
//   · pazaryeri uygunluğu   → sağlayıcı kataloğu + yayın aşaması politikası
//   · bağlantı/senkron      → Entegrasyon Sağlığı (`loadIntegrationHealthForOrganization`)
//                             — kimlik varlığı, hesap kimliği ve senkron
//                             geçmişi BURADA YENİDEN KURULMAZ
//   · hesaplar              → `marketplace_accounts` (kiracı kapsamlı)
//   · taşıyıcı              → maskelenmiş kimlik durumu (sır DÖNMEZ)
//
// YAN ETKİ YOK: durum okuması sağlayıcıya/taşıyıcıya HİÇBİR çağrı yapmaz;
// senkron başlatmaz, gönderi oluşturmaz. Yalnız yerel DB okunur.
// Kiracı YALNIZ çağırandan (req.auth) gelir; istek gövdesi OKUNMAZ.
import { getMaskedIntegrationStatus } from '../integrations/credentialService.ts'
import { countOrdersByOrganization } from '../orders/orderRepository.ts'
import { countProducts } from '../products/productRepository.ts'
import {
  ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS,
  loadIntegrationHealthForOrganization,
} from '../connectors/integrationHealthService.ts'
import { buildProviderCatalog, resolveRolloutStage } from '../connectors/providerCatalog.ts'
import {
  evaluateOnboarding,
  resolveOnboardingProviders,
  type BootstrapResource,
  type OnboardingSnapshot,
  type OnboardingStatus,
} from './onboardingModel.ts'
import {
  ensureSettings,
  listOrganizationMarketplaceAccounts,
  setOnboardingCompleted,
} from './onboardingRepository.ts'
import { getShipmentDefaults } from './shipmentDefaultsRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type { OnboardingStatus } from './onboardingModel.ts'

function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (value == null || value === '') return null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

export async function loadOnboardingSnapshot(
  db: Db,
  organizationId: string,
  options: { nowMs?: number } = {},
): Promise<OnboardingSnapshot> {
  const scopedOrganizationId = String(organizationId ?? '').trim()
  if (scopedOrganizationId === '') {
    // FAIL-CLOSED: kiracı kapsamı olmadan onboarding OKUNMAZ.
    throw new Error('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  }
  const nowMs = options.nowMs ?? Date.now()
  const providers = resolveOnboardingProviders(buildProviderCatalog(), resolveRolloutStage)
  // Yalnız UYGUN sağlayıcıların canlı bootstrap kaynakları okunur.
  const resources = [
    ...new Set(
      providers
        .filter((provider) => provider.eligibleForOnboarding)
        .flatMap((provider) => provider.bootstrapResources),
    ),
  ] as BootstrapResource[]

  const settings = await ensureSettings(db, scopedOrganizationId)
  const [masked, accounts, defaults, productCount, orderCount, ...healthLists] =
    await Promise.all([
      getMaskedIntegrationStatus(db, scopedOrganizationId),
      listOrganizationMarketplaceAccounts(db, scopedOrganizationId),
      getShipmentDefaults(db, scopedOrganizationId),
      countProducts(db, scopedOrganizationId),
      countOrdersByOrganization(db, scopedOrganizationId),
      ...resources.map((resource) =>
        loadIntegrationHealthForOrganization(db, {
          organizationId: scopedOrganizationId,
          nowMs,
          resource,
        }),
      ),
    ])

  const healthByResource: OnboardingSnapshot['healthByResource'] = {}
  resources.forEach((resource, index) => {
    healthByResource[resource] = healthLists[index]
  })

  return {
    completed: Boolean(settings.onboardingCompleted),
    completedAt: toIso(settings.onboardingCompletedAt),
    providers,
    healthByResource,
    accounts: accounts.map((account: Record<string, unknown>) => ({
      id: String(account.id),
      marketplace: String(account.marketplace ?? ''),
      displayName: account.displayName ? String(account.displayName) : null,
      isActive: account.isActive === true,
    })),
    accountScopedCredentialProviders: ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS,
    carrierConfigured: Boolean(masked?.surat?.configured),
    defaultUnitDesiConfigured: defaults?.defaultUnitDesi != null,
    counts: { products: Number(productCount) || 0, orders: Number(orderCount) || 0 },
  }
}

export async function deriveOnboardingStatus(
  db: Db,
  organizationId: string,
  options: { nowMs?: number } = {},
): Promise<OnboardingStatus> {
  return evaluateOnboarding(await loadOnboardingSnapshot(db, organizationId, options))
}

/**
 * Tamamlama — sunucu TÜM durumu YENİDEN hesaplar.
 *
 * İstemci `completed=true` veya adım bayrağı GÖNDEREMEZ: bu fonksiyon istek
 * gövdesi ALMAZ. Tamamlanmış organizasyon için çağrı idempotenttir ve güncel
 * sağlıkla GERİ ALINMAZ (tarihsel tamamlanma otoriterdir).
 */
export async function completeOnboarding(
  db: Db,
  organizationId: string,
): Promise<{ ok: boolean; blockers: string[]; status: OnboardingStatus }> {
  const status = await deriveOnboardingStatus(db, organizationId)
  if (status.completed) {
    return { ok: true, blockers: [], status }
  }
  if (!status.eligibleToComplete) {
    return { ok: false, blockers: status.blockers, status }
  }
  await setOnboardingCompleted(db, organizationId)
  const updated = await deriveOnboardingStatus(db, organizationId)
  return { ok: true, blockers: [], status: updated }
}

/** `GET /api/onboarding/status` — ucun TAM davranışı (index.mjs yalnız devreder). */
export async function handleOnboardingStatusRequest(params: {
  db: Db
  organizationId: string
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const status = await deriveOnboardingStatus(params.db, params.organizationId)
  return { httpStatus: 200, body: { ok: true, ...status } }
}

/**
 * `POST /api/onboarding/complete` — ucun TAM davranışı.
 *
 * İmza BİLİNÇLİ olarak istek gövdesi İÇERMEZ: tamamlanma gerçeği yalnız
 * sunucu durumundan türetilir.
 */
export async function handleOnboardingCompleteRequest(params: {
  db: Db
  organizationId: string
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const result = await completeOnboarding(params.db, params.organizationId)
  if (!result.ok) {
    return {
      httpStatus: 409,
      body: {
        ok: false,
        message: 'Onboarding tamamlanamadı; eksik adımlar var.',
        ...result.status,
      },
    }
  }
  return { httpStatus: 200, body: { ok: true, ...result.status } }
}
