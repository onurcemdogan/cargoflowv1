// ETİKET İŞİ HAZIRLIĞI — DÖRT ÇAĞIRAN İÇİN TEK BOru HATTI.
//
// ═══ ÜRETİM OLAYI (worker açıldıktan sonra) ══════════════════════════════
// Aday seçici üç paketi `SAFE_CANARY=YES` ilan etti (desi 2, uygun statü,
// kimlik çözülü). `run-once` kanaryası 4110346669'u READY yaptı. Sonra
// GENEL worker açıldı ve AYNI koşullardaki üç paket:
//     BLOCKED · attempt_count=1 · SURAT_PREFLIGHT_DESI_MISSING
// oldu; izler `carrierCallStarted=false` dedi — taşıyıcıya ÇIKILMADI.
//
// ═══ KÖK NEDEN ═══════════════════════════════════════════════════════════
// Worker, siparişi create handler'a HAM olarak veriyordu ve desinin
// çözülmesini handler'ın İÇİNDEKİ `ensureTenantResolvedDesi` kancasına
// bırakıyordu. O kanca:
//   • `request.auth.organizationId` + `isTenantAuthMode()` koşuluna bağlıdır,
//   • başarısızlığı SESSİZ bir `catch {}` ile yutar,
//   • ve çalışmazsa `order.desi` BOŞ kalır.
// Boş desi ile create, SOAP gövdesini kurarken "Desi bilgisi eksik" ile
// AĞDAN ÖNCE düşer. Yani hazırlık worker için GÖRÜNMEZ bir yan etkiydi:
// ön kontrol desiyi KENDİ çözüyordu (2 buluyordu), worker ise ÇÖZMÜYORDU.
// Aynı paket için iki farklı gerçek.
//
// İkinci sonuç: `Created` statüsündeki paketler de `SURAT_PREFLIGHT_DESI_
// MISSING` yazdı. Çünkü desi kapısı, create handler'ın uygunluk kapısından
// ÖNCE patlıyordu; uygunluk reddi hiç oluşamıyordu.
//
// ═══ ÇÖZÜM: HAZIRLIK ÇAĞIRANIN İÇİNDE DEĞİL, ÖNÜNDE ══════════════════════
// Bu modül hazırlığı DETERMİNİSTİK bir sırayla ve TEK yerde yapar:
//
//     ayarlar → desi → uygunluk → faturalama → kimlik
//
// Sonuç DEĞİŞMEZ bir yapıdır ve dört çağıranın HEPSİ onu tüketir:
//   1. salt-okunur ön kontrol (`labelJobPreflight`)
//   2. kanarya aday seçici (`canaryCandidateSelector`)
//   3. tek iş çalıştırıcı (`singleLabelJobRunner`)
//   4. GENEL worker (`runLabelJobViaCreateHandler`)
//
// Worker artık desiyi hazırlıktan ALIR ve create gövdesine AÇIKÇA yazar —
// tarayıcının yaptığının aynısı. Gizli kancaya güvenilmez.
//
// ═══ SIRANIN GEREKÇESİ ═══════════════════════════════════════════════════
// Desi uygunluktan ÖNCE çözülür ki "desi ayarı eksik" ile "paket statüsü
// uygun değil" birbirine KARIŞMASIN; ama BLOKLAYICI seçimi sırayla değil
// AÇIK ÖNCELİKLE yapılır (aşağıdaki `BLOCKER_PRIORITY`). Böylece desi
// GEÇERLİYKEN uygunsuz bir paket ASLA desi hatası yazmaz.

import { and, eq } from 'drizzle-orm'
import { labelJobs, shipments } from '../db/schema.ts'
import {
  buildTrendyolShipmentEligibility,
  TRENDYOL_NOT_ELIGIBLE_CODE,
  type TrendyolShipmentEligibility,
} from './trendyolShipmentEligibility.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** AĞDAN ÖNCEKİ kesin kodlar — yenisi uydurulmaz. */
export const PREPARATION_BLOCKER_CODES = {
  DESI_MISSING: 'SURAT_PREFLIGHT_DESI_MISSING',
  NOT_ELIGIBLE: TRENDYOL_NOT_ELIGIBLE_CODE,
  CREDENTIAL: 'SURAT_CREDENTIAL_CONFIG_INVALID',
  ORDER_MISSING: 'SURAT_PREFLIGHT_ORDER_NOT_FOUND',
  WHOPAYS: 'SURAT_PREFLIGHT_WHOPAYS_UNRESOLVED',
  ARTIFACT: 'SURAT_PREFLIGHT_CARRIER_ARTIFACT_EXISTS',
  EXCEPTION: 'SURAT_PREFLIGHT_FAILED',
  /** Kod semasi ile veritabani semasi AYRISMIS (migration uygulanmamis). */
  SCHEMA_DRIFT: 'SURAT_PREFLIGHT_SCHEMA_DRIFT',
  /** Siparis PII'si sifreli saklanir; anahtar yoksa siparis OKUNAMAZ. */
  ENCRYPTION_KEY: 'SURAT_PREFLIGHT_ENCRYPTION_KEY_MISSING',
} as const

/**
 * GERCEK istisna mesajini AKSIYON ALINABILIR bir koda ESLER.
 *
 * Tahmin DEGILDIR: yalniz mesajin kendisi siniflandirilir ve
 * `failureDetail` her halukarda AYNEN tasinir. Eslesme yoksa genel
 * `SURAT_PREFLIGHT_FAILED` kalir — uydurma sebep YAZILMAZ.
 */
function classifyPreparationFailure(message: string): string {
  const text = message.toLocaleLowerCase('en-US')
  if (
    text.includes('order_data_encryption_key') ||
    text.includes('credential_encryption_key') ||
    text.includes('32 byte')
  ) {
    return 'SURAT_PREFLIGHT_ENCRYPTION_KEY_MISSING'
  }
  if (
    /column .* does not exist/.test(text) ||
    /relation .* does not exist/.test(text)
  ) {
    return 'SURAT_PREFLIGHT_SCHEMA_DRIFT'
  }
  return 'SURAT_PREFLIGHT_FAILED'
}

/**
 * BLOKLAYICI ÖNCELİĞİ — AÇIK ve TEK.
 *
 * Sipariş yoksa başka hiçbir şey ölçülemez; o yüzden en üstte. Ardından
 * paket statüsü gelir: desi geçerliyken uygunsuz bir paketin desi hatası
 * yazması ÜRETİMDE yaşandı ve teşhisi yanlış yöne çevirdi.
 */
const BLOCKER_PRIORITY: readonly string[] = [
  PREPARATION_BLOCKER_CODES.SCHEMA_DRIFT,
  PREPARATION_BLOCKER_CODES.ENCRYPTION_KEY,
  PREPARATION_BLOCKER_CODES.EXCEPTION,
  PREPARATION_BLOCKER_CODES.ORDER_MISSING,
  PREPARATION_BLOCKER_CODES.ARTIFACT,
  PREPARATION_BLOCKER_CODES.NOT_ELIGIBLE,
  PREPARATION_BLOCKER_CODES.DESI_MISSING,
  PREPARATION_BLOCKER_CODES.WHOPAYS,
  PREPARATION_BLOCKER_CODES.CREDENTIAL,
]

/**
 * KESİN HATA ÖZETLERİ.
 *
 * ÜRETİMDE ÖLÇÜLDÜ: kod `SURAT_PREFLIGHT_DESI_MISSING` iken özet
 * "Sürat kimlik doğrulaması tamamlanamadı..." diyordu. Kimlik ve desi
 * hataları KARIŞTIRILMAZ; her kodun kendi cümlesi vardır.
 */
export function summarizeBlocker(
  code: string,
  eligibility?: TrendyolShipmentEligibility | null,
): string {
  switch (code) {
    case PREPARATION_BLOCKER_CODES.DESI_MISSING:
      return 'Sürat gönderisi oluşturmadan önce Desi bilgisi çözülemedi.'
    case PREPARATION_BLOCKER_CODES.NOT_ELIGIBLE:
      // Mevcut Trendyol uygunluk mesajı AYNEN kullanılır.
      return (
        eligibility?.reason ??
        'Bu sipariş Trendyol tarafında kargo oluşturma için uygun statüde değil.'
      )
    case PREPARATION_BLOCKER_CODES.CREDENTIAL:
      return 'Sürat kimlik yapılandırması çözülemedi; taşıyıcıya çıkılmadı.'
    case PREPARATION_BLOCKER_CODES.ORDER_MISSING:
      return 'Paket için kalıcı sipariş kaydı bulunamadı.'
    case PREPARATION_BLOCKER_CODES.WHOPAYS:
      return 'Gönderiyi kimin ödeyeceği çözülemedi; yanlış cariye yazma riski var.'
    case PREPARATION_BLOCKER_CODES.ARTIFACT:
      return 'Bu paket için taşıyıcı artefaktı zaten var; ikinci create yapılmaz.'
    case PREPARATION_BLOCKER_CODES.SCHEMA_DRIFT:
      return 'Kod şeması ile veritabanı şeması ayrışmış; sipariş okunamadı.'
    case PREPARATION_BLOCKER_CODES.ENCRYPTION_KEY:
      return 'Sipariş şifreleme anahtarı bu süreçte tanımlı değil; sipariş okunamadı.'
    default:
      return 'Sürat gönderisi hazırlanamadı.'
  }
}

export interface PreparedLabelJob {
  readonly ok: boolean
  readonly packageId: string
  readonly marketplace: string
  readonly organizationId: string

  /** Desi ENJEKTE EDİLMİŞ sipariş — create gövdesine bu gider. */
  readonly order: Record<string, unknown> | null
  readonly orderNumber: string | null
  readonly orderLinesCount: number

  readonly tenantSettingsLoaded: boolean
  readonly tenantDesi: number | null
  readonly multiplyByItemQuantity: boolean | null

  readonly inputOrderDesiBeforeResolver: number | null
  readonly resolverCalled: boolean
  readonly resolvedDesi: number | null
  readonly desiSource: string | null
  /** Sürat sözleşmesi: `BirimDesi` çözülen desiyle AYNIDIR. */
  readonly suratBirimDesi: number | null

  readonly marketplaceStatus: string | null
  readonly eligibility: TrendyolShipmentEligibility | null
  readonly eligibleForCreate: boolean | null

  readonly billingParty: string | null
  readonly expectedWhoPays: number | null
  readonly credentialRole: string | null
  readonly credentialSnapshot: {
    readonly role: string | null
    readonly source: string | null
    readonly resolved: boolean
    readonly accountFingerprint: string | null
  }

  readonly carrierArtifactExists: boolean
  readonly blockers: readonly string[]
  /** İlk ve OTORİTER bloklayıcı kod (öncelik sırasına göre). */
  readonly blockerCode: string | null
  readonly errorSummary: string | null
  readonly failureDetail: string | null

  readonly networkCalls: 0
  readonly dbWrites: 0
  readonly carrierCalls: 0
}

function describeError(error: unknown): string {
  const parts: string[] = []
  const cause = (error as { cause?: unknown } | null)?.cause
  if (cause instanceof Error && cause.message) parts.push(cause.message)
  parts.push(error instanceof Error ? error.message : String(error))
  const parameterMarker = String.fromCharCode(10) + 'params:'
  return parts
    .map((part) => part.split(parameterMarker)[0].trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, 600)
}

/**
 * WORKER'IN GÖRDÜĞÜ sipariş nesnesi — create yolunun kullandığı İKİ çağrı.
 */
async function loadOrder(
  db: Db, organizationId: string, marketplace: string, packageId: string,
): Promise<Record<string, unknown> | null> {
  const repository = await import('../orders/orderRepository.ts')
  const row = await repository.findOrderByPackageId(
    db, organizationId, marketplace, packageId,
  )
  if (!row) return null
  const persistence = await import('../orders/orderPersistenceService.ts')
  const order = await persistence.getOrder(
    db, organizationId, String((row as { id: string }).id),
  )
  return (order ?? null) as Record<string, unknown> | null
}

/**
 * TEK HAZIRLIK BORU HATTI.
 *
 * Ağa ÇIKMAZ, satır YAZMAZ. Taşıyıcı ağının HEMEN ÖNCESİNDE durur.
 */
export async function prepareLabelJob(
  db: Db,
  params: { organizationId: string; packageId: string; marketplace?: string },
): Promise<PreparedLabelJob> {
  const blockers: string[] = []
  let failureDetail: string | null = null

  const jobRows = await db
    .select({ marketplace: labelJobs.marketplace })
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.packageId, params.packageId),
      ),
    )
  const marketplace =
    params.marketplace
    ?? String((jobRows as Record<string, unknown>[])[0]?.marketplace ?? 'Trendyol')

  let order: Record<string, unknown> | null = null
  let orderNumber: string | null = null
  let orderLinesCount = 0
  let tenantSettingsLoaded = false
  let tenantDesi: number | null = null
  let multiplyByItemQuantity: boolean | null = null
  let inputOrderDesiBeforeResolver: number | null = null
  let resolverCalled = false
  let resolvedDesi: number | null = null
  let desiSource: string | null = null
  let marketplaceStatus: string | null = null
  let eligibility: TrendyolShipmentEligibility | null = null
  let eligibleForCreate: boolean | null = null
  let billingParty: string | null = null
  let expectedWhoPays: number | null = null
  let credentialRole: string | null = null
  let credentialSnapshot = {
    role: null as string | null,
    source: null as string | null,
    resolved: false,
    accountFingerprint: null as string | null,
  }

  try {
    // ── 1. SİPARİŞ ────────────────────────────────────────────────────
    order = await loadOrder(
      db, params.organizationId, marketplace, params.packageId,
    )
    if (!order) {
      blockers.push(PREPARATION_BLOCKER_CODES.ORDER_MISSING)
    } else {
      orderNumber = String(order.orderNumber ?? '') || null
      orderLinesCount = Array.isArray(order.items) ? order.items.length : 0
      const rawDesi = Number(order.desi ?? 0)
      inputOrderDesiBeforeResolver =
        Number.isFinite(rawDesi) && rawDesi > 0 ? rawDesi : null

      // ── 2. KİRACI GÖNDERİ VARSAYILANLARI ──────────────────────────
      const { getShipmentDefaults } = await import(
        '../onboarding/shipmentDefaultsRepository.ts'
      )
      const defaults = await getShipmentDefaults(db, params.organizationId)
      tenantSettingsLoaded = Boolean(defaults)
      tenantDesi = Number(defaults?.defaultUnitDesi ?? 0) || null
      multiplyByItemQuantity = defaults?.multiplyByItemQuantity ?? null

      // ── 3. DESİ — PAYLAŞILAN TEK ÇÖZÜCÜ ───────────────────────────
      const { resolveShipmentDesi } = await import('./resolveShipmentDesi.ts')
      resolverCalled = true
      const resolution = await resolveShipmentDesi({
        db, organizationId: params.organizationId, order,
      })
      resolvedDesi = resolution.desi
      desiSource = resolution.source
      if (resolvedDesi == null) {
        blockers.push(PREPARATION_BLOCKER_CODES.DESI_MISSING)
        failureDetail = failureDetail ?? resolution.reason
      } else {
        // ═══ DESİ SİPARİŞE ENJEKTE EDİLİR ═══════════════════════════
        //
        // Worker'ın kaybettiği adım BUYDU. Create yolu desiyi gövdeden
        // okur; tarayıcı onu hesaplayıp gönderir. Arka plan çağıranının
        // tarayıcısı yoktur, bu yüzden hazırlık AÇIKÇA yazar.
        order = { ...order, desi: resolvedDesi, desiSource: resolution.source }
      }

      // ── 4. TRENDYOL UYGUNLUĞU — AYNI KURAL ────────────────────────
      eligibility = buildTrendyolShipmentEligibility(order)
      marketplaceStatus = eligibility.marketplaceStatus || null
      eligibleForCreate = eligibility.canCallSurat
      if (!eligibility.canCallSurat) {
        blockers.push(PREPARATION_BLOCKER_CODES.NOT_ELIGIBLE)
      }

      // ── 5. FATURALAMA / WhoPays ───────────────────────────────────
      const routing = await import('./suratRoutingModel.ts')
      const billing = routing.resolveBillingPartyV2(order.rawOrder ?? {})
      billingParty = billing.billingParty
      expectedWhoPays =
        billing.billingParty === 'TRENDYOL_PAYS'
          ? 3
          : billing.billingParty === 'SELLER_PAYS'
            ? 1
            : null
      if (billing.billingParty === 'UNKNOWN') {
        blockers.push(PREPARATION_BLOCKER_CODES.WHOPAYS)
      }

      // ── 6. KİMLİK — KANONİK ANLIK GÖRÜNTÜ ─────────────────────────
      const [{ loadOrganizationIntegrationConfig }, snapshotModule] =
        await Promise.all([
          import('../integrations/credentialService.ts'),
          import('./suratCredentialSnapshot.ts'),
        ])
      const integration = await loadOrganizationIntegrationConfig(
        db, params.organizationId,
      )
      const suratConfig = (integration?.surat ?? {}) as Record<string, unknown>
      const codLikely = Number(order.cashOnDeliveryAmount ?? 0) > 0
      const role = codLikely
        ? null
        : routing.resolveSuratCredentialContext({
            config: suratConfig,
            billingParty: billing.billingParty,
            cod: routing.resolveCodContext({ enabled: false }),
            codPolicy: routing.resolveCodCredentialPolicy(
              suratConfig.codCredentialPolicy,
            ),
            serviceMode: suratConfig.serviceMode,
          }).role
      credentialRole = role
      if (role) {
        const snapshot = snapshotModule.buildSuratCredentialSnapshot({
          storedSuratConfig:
            snapshotModule.normalizeAuthoritativeSuratStore(suratConfig),
          role,
        })
        // SIR TAŞINMAZ: yalnız rol, kaynak etiketi ve çözüm bayrağı.
        credentialSnapshot = {
          role: snapshot.role,
          source: snapshot.source,
          resolved: snapshot.resolved,
          accountFingerprint: snapshot.accountFingerprint,
        }
      }
      if (!credentialSnapshot.resolved) {
        blockers.push(PREPARATION_BLOCKER_CODES.CREDENTIAL)
      }
    }
  } catch (error) {
    failureDetail = describeError(error)
    blockers.push(classifyPreparationFailure(failureDetail))
  }

  // ── TAŞIYICI ARTEFAKTI ───────────────────────────────────────────────
  const shipmentRows = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, params.organizationId),
        eq(shipments.packageId, params.packageId),
      ),
    )
  const carrierArtifactExists = (shipmentRows as unknown[]).length > 0
  if (carrierArtifactExists) blockers.push(PREPARATION_BLOCKER_CODES.ARTIFACT)

  const blockerCode =
    BLOCKER_PRIORITY.find((code) => blockers.includes(code)) ?? null

  return Object.freeze({
    ok: blockers.length === 0,
    packageId: params.packageId,
    marketplace,
    organizationId: params.organizationId,
    order,
    orderNumber,
    orderLinesCount,
    tenantSettingsLoaded,
    tenantDesi,
    multiplyByItemQuantity,
    inputOrderDesiBeforeResolver,
    resolverCalled,
    resolvedDesi,
    desiSource,
    suratBirimDesi: resolvedDesi,
    marketplaceStatus,
    eligibility,
    eligibleForCreate,
    billingParty,
    expectedWhoPays,
    credentialRole,
    credentialSnapshot: Object.freeze(credentialSnapshot),
    carrierArtifactExists,
    blockers: Object.freeze([...new Set(blockers)]),
    blockerCode,
    errorSummary: blockerCode ? summarizeBlocker(blockerCode, eligibility) : null,
    failureDetail,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  })
}
