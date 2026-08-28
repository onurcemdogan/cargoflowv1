// ETİKET İŞİ ÖN KONTROLÜ — TEK PAYLAŞILAN, SALT-OKUNUR HAZIRLIK.
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
// `auto-label:job:inspect` siparişi ve desiyi KENDİ yolundan yüklüyordu;
// worker ise create orkestrasyonundan. İki hazırlık = iki gerçek. Üretimde
// bunun bedeli görüldü: kiracı ayarı 2 iken inspector `RESOLVER_DESI=null`
// dedi ve gerçek worker'ın ne yapacağı BİLİNMEZ kaldı.
//
// Bu modül hazırlığı TEK yere indirir. Hem inspector hem preflight hem de
// gelecekteki her salt-okunur denetim BURAYI çağırır.
//
// ═══ HATA YUTULMAZ ═══════════════════════════════════════════════════════
// Önceki inspector, herhangi bir istisnayı `DESI_COZUMU_OKUNAMADI` gibi
// GENEL bir engele çeviriyordu; üretimde gerçek sebep KAYBOLDU. Burada
// yakalanan istisnanın mesajı `failureDetail` olarak AYNEN taşınır.
// "Bilinmiyor" ile "çözülemedi" ASLA aynı şey değildir.
//
// ═══ AĞ VE YAZIM YOK ═════════════════════════════════════════════════════
// Taşıyıcıya ÇIKILMAZ, SOAP zarfı KURULMAZ, hiçbir satır YAZILMAZ.
// Hazırlık taşıyıcı ağının HEMEN ÖNCESİNDE durur.

import { and, eq } from 'drizzle-orm'
import { labelJobs, shipments } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface LabelJobPreflight {
  readonly packageId: string
  readonly orderNumber: string | null
  readonly marketplace: string
  readonly jobId: string | null
  readonly jobStatus: string | null
  readonly attemptCount: number

  readonly tenantDesi: number | null
  readonly multiplyByItemQuantity: boolean | null
  readonly orderLinesCount: number
  readonly resolvedDesi: number | null
  readonly desiSource: string | null
  /** Sürat alan adı — `BirimDesi` çözülen desiyle AYNIDIR. */
  readonly suratBirimDesi: number | null

  readonly billingParty: string | null
  readonly expectedSuratWhoPays: number | null
  readonly credentialRole: string | null
  readonly credentialResolved: boolean

  readonly preflightValid: boolean
  readonly wouldCallCarrier: boolean
  readonly blockers: readonly string[]
  /** Yakalanan istisnanın GERÇEK mesajı — yutulmaz. */
  readonly failureDetail: string | null

  readonly networkCalls: 0
  readonly dbWrites: 0
  readonly carrierCalls: 0
}

/**
 * İstisnanın GERÇEK sebebini okunur tek satıra indirir.
 *
 * Sürücü hataları asıl sebebi `cause` içinde taşır; üst mesaj yalnız
 * "Failed query: ..." der. Sebep BAŞA alınır, sorgu özeti arkaya konur.
 * `params:` bloğu ATILIR — teşhis çıktısına veri sızmaz.
 */
function describeError(error: unknown): string {
  const parts: string[] = []
  const cause = (error as { cause?: unknown } | null)?.cause
  if (cause instanceof Error && cause.message) parts.push(cause.message)
  parts.push(error instanceof Error ? error.message : String(error))
  // Yeni satir kacisi YAZILMAZ; sorgu parametreleri KESILIR.
  const parameterMarker = String.fromCharCode(10) + 'params:'
  return parts
    .map((part) => part.split(parameterMarker)[0].trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, 600)
}

/**
 * GERÇEK istisna mesajını AKSİYON ALINABİLİR bir koda EŞLER.
 *
 * Bu bir TAHMİN değildir: yalnız mesajın kendisi sınıflandırılır ve
 * `failureDetail` her hâlükârda AYNEN taşınır. Eşleşme yoksa genel
 * `HAZIRLIK_ISTISNASI` kalır — uydurma bir sebep YAZILMAZ.
 */
function classifyPreparationFailure(message: string): string {
  const text = message.toLocaleLowerCase('en-US')
  if (
    text.includes('order_data_encryption_key') ||
    text.includes('credential_encryption_key') ||
    text.includes('32 byte')
  ) {
    // Sipariş PII'si şifreli saklanır; anahtar yoksa sipariş OKUNAMAZ.
    return 'ORTAM_SIFRELEME_ANAHTARI_YOK'
  }
  if (
    /column .* does not exist/.test(text) ||
    /relation .* does not exist/.test(text)
  ) {
    // Kod şeması ile veritabanı şeması AYRIŞMIŞ (migration uygulanmamış).
    return 'SEMA_SURUMU_ESKI'
  }
  return 'HAZIRLIK_ISTISNASI'
}

/**
 * WORKER'IN GÖRDÜĞÜ sipariş nesnesini kurar.
 *
 * Worker `runLabelJobViaCreateHandler` içinde tam olarak bunu yapar:
 * paketten sipariş satırını bulur, sonra `getOrder` ile view-model'i alır.
 * Burada AYNI iki çağrı kullanılır; kopya bir yükleme yazılmaz.
 */
async function loadWorkerOrder(
  db: Db,
  organizationId: string,
  marketplace: string,
  packageId: string,
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
 * Worker'ın taşıyıcıdan HEMEN ÖNCEKİ durumunu SALT-OKUNUR üretir.
 */
export async function preflightLabelJob(
  db: Db,
  params: { organizationId: string; packageId: string; marketplace?: string },
): Promise<LabelJobPreflight> {
  const blockers: string[] = []
  let failureDetail: string | null = null

  const jobRows = await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.packageId, params.packageId),
      ),
    )
  const job = (jobRows as Record<string, unknown>[])[0] ?? null
  const marketplace =
    params.marketplace ?? String(job?.marketplace ?? 'Trendyol')

  let tenantDesi: number | null = null
  let multiplyByItemQuantity: boolean | null = null
  let orderLinesCount = 0
  let resolvedDesi: number | null = null
  let desiSource: string | null = null
  let orderNumber: string | null = null
  let billingParty: string | null = null
  let expectedSuratWhoPays: number | null = null
  let credentialRole: string | null = null
  let credentialResolved = false

  try {
    const [{ getShipmentDefaults }, { resolveShipmentDesi }, routing] =
      await Promise.all([
        import('../onboarding/shipmentDefaultsRepository.ts'),
        import('./resolveShipmentDesi.ts'),
        import('./suratRoutingModel.ts'),
      ])

    const defaults = await getShipmentDefaults(db, params.organizationId)
    tenantDesi = Number(defaults?.defaultUnitDesi ?? 0) || null
    multiplyByItemQuantity = defaults?.multiplyByItemQuantity ?? null
    if (tenantDesi == null) blockers.push('TENANT_DESI_AYARLI_DEGIL')

    const order = await loadWorkerOrder(
      db, params.organizationId, marketplace, params.packageId,
    )
    if (!order) {
      blockers.push('SIPARIS_BULUNAMADI')
    } else {
      orderNumber = String(order.orderNumber ?? '') || null
      orderLinesCount = Array.isArray(order.items) ? order.items.length : 0

      // ── DESİ: PAYLAŞILAN TEK ÇÖZÜCÜ ────────────────────────────────
      const resolution = await resolveShipmentDesi({
        db, organizationId: params.organizationId, order,
      })
      resolvedDesi = resolution.desi
      desiSource = resolution.source
      if (resolvedDesi == null) {
        blockers.push('DESI_COZULEMIYOR')
        if (resolution.reason) failureDetail = resolution.reason
      }

      // -- FATURALAMA / WhoPays -- mevcut kanonik cozucu ---------------
      const billing = routing.resolveBillingPartyV2(order.rawOrder ?? {})
      billingParty = billing.billingParty
      // TRENDYOL_PAYS -> 3 (EntegrasyonFirmasiOder) - SELLER_PAYS -> 1.
      expectedSuratWhoPays =
        billing.billingParty === 'TRENDYOL_PAYS'
          ? 3
          : billing.billingParty === 'SELLER_PAYS'
            ? 1
            : null
      if (billing.billingParty === 'UNKNOWN') blockers.push('WHOPAYS_COZULEMIYOR')

      // -- KIMLIK ROLU VE COZUMU -- KANONIK MODULLERDEN -----------------
      //
      // IKINCI UYGULAMA YOK: rol `resolveSuratCredentialContext`,
      // kimlik ise `normalizeAuthoritativeSuratStore` +
      // `buildSuratCredentialSnapshot` ile cozulur -- create yolunun
      // kullandigi AYNI fonksiyonlar. Taban `kullaniciAdi`/`sifre`
      // alanlari BILEREK okunmaz; kanonik tureme `canonicalPrimary*`
      // alanlarini uretir ve elle okunan bir kopya bunu KACIRIRDI.
      //
      // KREDENSIYEL DEGERI TASINMAZ: yalniz `resolved` bayragi ve rol.
      const [{ loadOrganizationIntegrationConfig }, snapshotModule] =
        await Promise.all([
          import('../integrations/credentialService.ts'),
          import('./suratCredentialSnapshot.ts'),
        ])
      const integration = await loadOrganizationIntegrationConfig(
        db, params.organizationId,
      )
      const suratConfig = (integration?.surat ?? {}) as Record<string, unknown>

      // COD, uretimde finansal kapinin `codEnabled` ciktisiyla belirlenir;
      // o kapi istek baglamina bagli oldugu icin SALT-OKUNUR on kontrolde
      // YENIDEN URETILEMEZ. Siparis kapida odemeye BENZIYORSA rol
      // BILDIRILMEZ -- yanlis rol yazmaktansa "belirlenemedi" denir.
      const codLikely = Number(order.cashOnDeliveryAmount ?? 0) > 0
      if (codLikely) {
        blockers.push('COD_ROLU_ON_KONTROLDE_BELIRLENEMEZ')
      } else {
        const context = routing.resolveSuratCredentialContext({
          config: suratConfig,
          billingParty: billing.billingParty,
          cod: routing.resolveCodContext({ enabled: false }),
          codPolicy: routing.resolveCodCredentialPolicy(
            suratConfig.codCredentialPolicy,
          ),
          serviceMode: suratConfig.serviceMode,
        })
        credentialRole = context.role
        const snapshot = snapshotModule.buildSuratCredentialSnapshot({
          storedSuratConfig:
            snapshotModule.normalizeAuthoritativeSuratStore(suratConfig),
          role: context.role,
        })
        credentialResolved = snapshot.resolved
      }
      if (!credentialResolved) blockers.push('KIMLIK_COZULEMIYOR')
    }
  } catch (error) {
    // GERÇEK sebep TAŞINIR; genel bir engele indirgenmez.
    failureDetail = describeError(error)
    blockers.push(classifyPreparationFailure(failureDetail))
  }

  // Taşıyıcı artefaktı zaten varsa create AÇILMAZ.
  const shipmentRows = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, params.organizationId),
        eq(shipments.packageId, params.packageId),
      ),
    )
  if (shipmentRows.length > 0) blockers.push('TASIYICI_ARTEFAKTI_VAR')

  const preflightValid = blockers.length === 0
  return {
    packageId: params.packageId,
    orderNumber,
    marketplace,
    jobId: job ? String(job.id) : null,
    jobStatus: job ? String(job.status) : null,
    attemptCount: Number(job?.attemptCount ?? 0),
    tenantDesi,
    multiplyByItemQuantity,
    orderLinesCount,
    resolvedDesi,
    desiSource,
    // Sürat sözleşmesi: `BirimDesi: desi`.
    suratBirimDesi: resolvedDesi,
    billingParty,
    expectedSuratWhoPays,
    credentialRole,
    credentialResolved,
    preflightValid,
    wouldCallCarrier: preflightValid,
    blockers,
    failureDetail,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}
