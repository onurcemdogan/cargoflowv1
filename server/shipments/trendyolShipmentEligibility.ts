// TRENDYOL PAKET UYGUNLUĞU — TEK KURAL, TEK YER.
//
// ═══ ÖLÇÜLEN KUSUR (paket 4110109345) ════════════════════════════════════
// İş `UNKNOWN_AFTER_NETWORK`, `last_error_code =
// TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS`, `attempt_count = 26` idi. Oysa
// `shipment_operations` ve `shipments` satırı SIFIRDI: taşıyıcıya HİÇ
// ÇIKILMAMIŞTI.
//
// Sebep: bu uygunluk kapısı create handler'ında AĞDAN ÖNCE karar verir
// (`index.mjs` → `if (!trendyolPreflight.canCallSurat)`), finansal kapıdan
// ve kimlik çözümünden bile önce. Ama ürettiği yanıt `carrierCreateCalled`
// KANIT ALANINI TAŞIMIYORDU. Worker bu alanı OKUR ve yoksa ihtiyatlı
// davranıp "ağ geçildi" varsayar → deterministik yerel bir ret,
// belirsiz bir ağ sonucu gibi sınıflandı.
//
// ═══ AYRICA: ÖN KONTROL BU KURALI HİÇ BİLMİYORDU ═════════════════════════
// `labelJobPreflight` desi/faturalama/kimlik kapılarını çalıştırıyor ama
// uygunluğu SORMUYORDU. Sonuç: `PREFLIGHT_VALID=true` ve
// `WOULD_CALL_CARRIER=YES` derken, gerçek create handler aynı paketi
// taşıyıcıya çıkmadan reddediyordu. İki gerçek.
//
// ═══ İKİNCİ KURAL YAZILMAZ ═══════════════════════════════════════════════
// Karar BURADA verilir. `server/index.mjs` içindeki
// `buildTrendyolShipmentPreflight` bu fonksiyona DELEGE eder; ön kontrol de
// AYNI fonksiyonu çağırır. Uygunluk için ikinci bir eşleme tablosu YOKTUR.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TrendyolShipmentEligibility {
  readonly ok: boolean
  readonly canCallSurat: boolean
  readonly reason: string
  readonly orderNumber: string
  readonly packageId: string
  readonly shipmentPackageId: string
  readonly cargoTrackingNumber: string
  readonly cargoProviderName: string
  readonly normalizedCargoProviderName: string
  readonly cargoProviderId: string
  readonly cargoCompanyId: string
  readonly marketplaceStatus: string
  readonly packageStatus: string
  readonly orderLineItemStatusName: string
  readonly cargoTrackingLink: string
  readonly existingCargoTrackingNumber: string
  readonly shipmentStatus: string
  readonly isCancelled: boolean
  readonly isDelivered: boolean
  readonly isShipped: boolean
  readonly isReadyToShip: boolean | null
  readonly suratAssigned: boolean | null
  readonly hasCargoTrackingNumber: boolean
  readonly existingShipmentDetected: boolean
  readonly canCallGonderiyiKargoyaGonder: boolean
  readonly requiresPickingUpdate: boolean
  /**
   * PICKING GECISINDEN SONRA create acilabilir mi?
   *
   * `canCallSurat` ile AYNI yuklem listesidir; YALNIZ
   * `requiresPickingUpdate` disarida birakilir. Yani: "paketin TEK eksigi
   * Created statusu mu?" sorusunun yanitidir.
   *
   * Bu alan bir GEVSETME DEGILDIR: elle create yolu (`index.mjs` ->
   * `ensureTrendyolPickingBeforeSurat`) paketi Picking'e aldiktan SONRA
   * uygunlugu YENIDEN turetir ve tam olarak bu sonuca varir. Alan, o
   * sonucu ONCEDEN gorunur kilar; ikinci bir kural yazmaz.
   */
  readonly canCallSuratAfterPickingUpdate: boolean
  readonly pickingUpdatePerformed: boolean
  readonly pickingUpdate: unknown
  readonly diagnostics: readonly string[]
}

/** Uygunsuz statü için KESİN kod — yenisi uydurulmaz. */
export const TRENDYOL_NOT_ELIGIBLE_CODE = 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'

/**
 * PAZARYERİ YAŞAM DÖNGÜSÜ SINIFI — TEK LİSTE.
 *
 * ═══ ÖLÇÜLEN KUSUR ═══════════════════════════════════════════════════════
 * Üretici (`autoLabelProducer`) uygunluğu `resolveSuratCreateEligibility`
 * ile ölçüyordu; o fonksiyon KİMLİK ve DENEME kapısıdır ve
 * `marketplaceStatus` alanını HİÇ OKUMAZ (repoda 0 geçiş). Yani üreticinin
 * pazaryeri yaşam döngüsü kapısı YOKTU:
 *   • `Shipped` paketler (4110043440 · attempt 37) BLOKE'den QUEUED'e
 *     canlandırıldı,
 *   • `Created` paketler (4111338022, 4111412351, 4111508763) sıraya alındı,
 * ve worker onları hemen yeniden BLOKE etti → durum çalkantısı.
 *
 * ═══ İKİNCİ LİSTE YOK ════════════════════════════════════════════════════
 * Sınıflandırma, create kapısının kullandığı AYNI yüklemlerden türer
 * (`buildTrendyolShipmentEligibility`). Statü dizeleri burada BİR KEZ
 * yorumlanır; üretici, yakalama ve canlandırma buraya sorar.
 */
export type MarketplaceLifecycle =
  /** Sürat create'i için uygun. */
  | 'ELIGIBLE'
  /** Henüz değil — durum değişirse uygun olabilir (ör. Created). */
  | 'NOT_YET'
  /** Kapanmış/ilerlemiş — yeni create ASLA açılmaz. */
  | 'TERMINAL'
  /** Statü okunamadı; ihtiyatlı davranılır. */
  | 'UNKNOWN'

export interface MarketplaceLifecycleVerdict {
  readonly lifecycle: MarketplaceLifecycle
  readonly reason: string
  /** Paket Created/Yeni: Surat oncesi Picking gecisi GEREKIYOR. */
  readonly requiresPickingUpdate: boolean
  /**
   * `NOT_YET` sinifini `ELIGIBLE`e tasiyacak KANONIK gecis mevcut mu?
   *
   * "Mevcut" demek: paketin Created disinda BASKA hicbir engeli yok
   * demektir. Gecisi KIMIN yapabilecegi (elle buton mu, arka plan mi) bir
   * POLITIKA sorusudur ve burada yanitlanmaz —
   * `resolveBackgroundPreparationGate` yanitlar.
   */
  readonly pickingTransitionAvailable: boolean
}

/**
 * Kalıcı sipariş kaydından yaşam döngüsü sınıfı.
 *
 * `TERMINAL` olan hiçbir paket için yeni create AÇILMAZ: gönderi zaten
 * yola çıkmış, teslim edilmiş, iade edilmiş veya iptal olmuştur. İkinci
 * bir Sürat gönderisi GERİ ALINAMAZ bir hatadır.
 */
export function classifyMarketplaceLifecycle(
  order: Record<string, any> = {},
): MarketplaceLifecycleVerdict {
  const eligibility = buildTrendyolShipmentEligibility(order)
  const verdict = (
    lifecycle: MarketplaceLifecycle,
    reason: string,
    pickingTransitionAvailable = false,
  ): MarketplaceLifecycleVerdict => ({
    lifecycle,
    reason,
    requiresPickingUpdate: eligibility.requiresPickingUpdate,
    pickingTransitionAvailable,
  })
  if (eligibility.isCancelled) {
    return verdict('TERMINAL', 'Paket iptal/iade statüsünde.')
  }
  if (eligibility.isDelivered) {
    return verdict('TERMINAL', 'Paket teslim edilmiş.')
  }
  if (eligibility.isShipped) {
    return verdict('TERMINAL', 'Paket kargoya verilmiş/taşımada.')
  }
  if (eligibility.existingShipmentDetected) {
    return verdict('TERMINAL', 'Mevcut gönderi izi var.')
  }
  if (eligibility.requiresPickingUpdate) {
    // SINIF DEGISMEDI: Created hala `NOT_YET`tir ve KENDILIGINDEN create
    // acmaz. Yalnizca "bu bekleyisi cozecek kanonik gecis var mi?" sorusu
    // AYRICA yanitlanir. Kapiyi kimin acabilecegini politika belirler.
    return verdict(
      'NOT_YET',
      'Paket Yeni/Created; Picking statüsüne geçmeden create açılmaz.',
      eligibility.canCallSuratAfterPickingUpdate,
    )
  }
  if (eligibility.canCallSurat) {
    return verdict('ELIGIBLE', 'Trendyol engeli bulunmadı.')
  }
  return verdict('UNKNOWN', eligibility.reason)
}

/**
 * ARKA PLAN HAZIRLIK KAPISI — "bu paket icin create ORKESTRASYONU
 * baslatilabilir mi?" sorusunun TEK yaniti.
 *
 * ═══ OLCULEN KUSUR ═══════════════════════════════════════════════════════
 * Uretimde `LABEL_WORKER_ENABLED=true`, `TRENDYOL_STREAM_SYNC_ENABLED=true`
 * ve kiraci otomatik etiketi ACIK oldugu halde `QUEUED_TOTAL=0` idi; alti
 * yeni `Created` siparis hicbir zaman siraya girmedi.
 *
 * Sebep TEK bir eksik degil, UC katmanin AYRI yanit vermesiydi:
 *
 *   uretici        `classifyMarketplaceLifecycle`      -> NOT_YET  (siraya almaz)
 *   worker hazirlik `canCallSurat`                     -> false    (NOT_ELIGIBLE)
 *   create handler  `ensureTrendyolPickingBeforeSurat` -> Picking'e ALIR
 *
 * Yani ELLE BUTON ayni paket icin Created -> Picking gecisini ZATEN
 * yapiyordu; arka plan yol ise o yetenege ULASMADAN iki kapi once
 * reddediliyordu. Ayni sipariş icin uc farkli gercek.
 *
 * ═══ IKINCI UYGULAMA YAZILMAZ ════════════════════════════════════════════
 * Bu fonksiyon Picking gecisini YAPMAZ ve nasil yapilacagini BILMEZ.
 * Gecisi yapan tek yer, elle butonun da kullandigi kanonik create
 * orkestrasyonudur (`ensureTrendyolPickingBeforeSurat` ->
 * `callTrendyolUpdatePackageStatus`). Burada YALNIZ "orkestrasyon
 * baslatilsin mi?" sorusu yanitlanir.
 *
 * ═══ CREATED KAPISI SILINMEDI ════════════════════════════════════════════
 * `NOT_YET` sinifi AYNEN durur. Fark su: cagiran, gecisi yapmaya YETKILI
 * oldugunu ACIKCA beyan etmedikce `NOT_YET` yine reddedilir. Yetki
 * varsayilan olarak YOKTUR (`allowPickingTransition` verilmezse `false`).
 */
export interface BackgroundPreparationVerdict {
  /** Create orkestrasyonu baslatilabilir mi? */
  readonly allowed: boolean
  /** Orkestrasyon once KANONIK Picking gecisini yapmak zorunda mi? */
  readonly requiresPickingUpdate: boolean
  readonly lifecycle: MarketplaceLifecycle
  readonly reason: string
  /** Reddedildiyse sayaç/gunluk kodu; kabul edildiyse null. */
  readonly blockCode: string | null
}

export function resolveBackgroundPreparationGate(
  order: Record<string, any> = {},
  options: { allowPickingTransition?: boolean } = {},
): BackgroundPreparationVerdict {
  const verdict = classifyMarketplaceLifecycle(order)
  const deny = (reason: string): BackgroundPreparationVerdict => ({
    allowed: false,
    requiresPickingUpdate: verdict.requiresPickingUpdate,
    lifecycle: verdict.lifecycle,
    reason,
    // Mevcut sayac adlari KORUNUR: `MARKETPLACE_LIFECYCLE_<SINIF>`.
    blockCode: `MARKETPLACE_LIFECYCLE_${verdict.lifecycle}`,
  })

  if (verdict.lifecycle === 'ELIGIBLE') {
    return {
      allowed: true,
      requiresPickingUpdate: false,
      lifecycle: 'ELIGIBLE',
      reason: verdict.reason,
      blockCode: null,
    }
  }
  // TERMINAL icin YETKI KAVRAMI YOKTUR: kargoya verilmis, teslim edilmis,
  // iptal/iade olmus veya zaten gonderi izi olan paket ASLA gecmez.
  if (verdict.lifecycle !== 'NOT_YET') return deny(verdict.reason)
  if (!verdict.pickingTransitionAvailable) {
    return deny(
      `${verdict.reason} Ayrica Created disinda da engel var: ` +
        buildTrendyolShipmentEligibility(order).reason,
    )
  }
  if (options.allowPickingTransition !== true) {
    return deny(
      `${verdict.reason} Cagiran arka plan Picking gecisine YETKILI degil.`,
    )
  }
  return {
    allowed: true,
    requiresPickingUpdate: true,
    lifecycle: 'NOT_YET',
    reason:
      'Paket Created; kanonik Picking gecisi disinda engel yok — create '
      + 'orkestrasyonu gecisi yapip devam edebilir.',
    blockCode: null,
  }
}

/** Yeni create ASLA açılmayacak sınıflar. */
export function isTerminalMarketplaceLifecycle(
  order: Record<string, any> = {},
): boolean {
  return classifyMarketplaceLifecycle(order).lifecycle === 'TERMINAL'
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeXml(value: unknown = ''): string {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractTag(text: unknown = '', tagName: string): string {
  const escapedTagName = escapeRegExp(tagName)
  const match = String(text).match(
    new RegExp(
      `<(?:[\\w.-]+:)?${escapedTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escapedTagName}>`,
      'i',
    ),
  )
  return match ? decodeXml(match[1]).trim() : ''
}

function extractFirst(text: unknown = '', tagNames: string[]): string {
  for (const tagName of tagNames) {
    const value = extractTag(text, tagName)
    if (value) return value
  }
  return ''
}

export function readSuratField(value: unknown, keys: string[]): string {
  if (!value) return ''
  if (typeof value === 'string') return extractFirst(value, keys)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readSuratField(item, keys)
      if (found) return found
    }
    return ''
  }
  if (typeof value !== 'object') return ''

  const normalizedKeys = keys.map((key) => String(key).toLocaleLowerCase('tr-TR'))

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      normalizedKeys.includes(String(key).toLocaleLowerCase('tr-TR')) &&
      item != null
    ) {
      if (typeof item === 'object') return JSON.stringify(item)
      return String(item).trim()
    }
  }

  for (const item of Object.values(value as Record<string, unknown>)) {
    const nested = readSuratField(item, keys)
    if (nested) return nested
  }

  return ''
}

function firstNonEmpty(...values: unknown[]): string {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) ?? ''
}

function firstObjectCandidate(...values: unknown[]): Record<string, unknown> {
  return (
    (values.find(
      (value) => value && typeof value === 'object' && !Array.isArray(value),
    ) as Record<string, unknown>) ?? {}
  )
}

function readOptionalBoolean(value: unknown): boolean | null {
  if (value === '' || value == null) return null
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLocaleLowerCase('tr-TR')
  if (['true', '1', 'evet', 'yes'].includes(normalized)) return true
  if (['false', '0', 'hayır', 'hayir', 'no'].includes(normalized)) return false
  return null
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('tr-TR')
}

export function isSuratCargoProviderName(value: unknown = ''): boolean {
  const normalized = normalizeSearchText(value)
  const compact = normalized.replace(/[^a-z0-9]/g, '')
  return Boolean(
    compact.includes('surat') ||
      compact.includes('srat') ||
      compact.includes('ratkargo') ||
      /s.?rat/.test(normalized),
  )
}

export function isTrendyolCreatedPackageStatus({
  marketplaceStatus = '',
  packageStatus = '',
  orderLineItemStatusName = '',
  shipmentStatus = '',
}: {
  marketplaceStatus?: unknown
  packageStatus?: unknown
  orderLineItemStatusName?: unknown
  shipmentStatus?: unknown
} = {}): boolean {
  const values = [
    marketplaceStatus,
    packageStatus,
    orderLineItemStatusName,
    shipmentStatus,
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  if (values.some((value) => value === 'Picking' || value === 'Invoiced')) {
    return false
  }
  const text = values.join(' ').toLocaleLowerCase('tr-TR')
  return Boolean(
    values.includes('Created') ||
      /\bcreated\b/i.test(text) ||
      /\byeni\b/i.test(text),
  )
}

/**
 * TRENDYOL UYGUNLUK KARARI — create handler'ın kullandığı KURALIN KENDİSİ.
 *
 * Saf fonksiyondur: ağ çağrısı YOK, veritabanı okuması YOK. Yalnız
 * siparişin kalıcı hâli üzerinden karar verir.
 */
export function buildTrendyolShipmentEligibility(
  order: Record<string, any> = {},
): TrendyolShipmentEligibility {
  const rawOrder = firstObjectCandidate(
    order.rawOrder,
    order.rawPackage,
    order.rawResponse,
  )
  const rawLineSource = Array.isArray(order.items)
    ? order.items.map((item: any) => item?.rawLine).filter(Boolean)
    : []
  const sources = [order, rawOrder, ...rawLineSource]
  const orderNumber = firstNonEmpty(
    order.orderNumber,
    readSuratField(sources, ['orderNumber']),
  )
  const packageId = firstNonEmpty(
    order.packageId,
    readSuratField(sources, ['packageId', 'id']),
  )
  const shipmentPackageId = firstNonEmpty(
    order.shipmentPackageId,
    readSuratField(sources, ['shipmentPackageId']),
    packageId,
  )
  const cargoTrackingNumber = firstNonEmpty(
    order.cargoTrackingNumber,
    readSuratField(sources, ['cargoTrackingNumber', 'existingCargoTrackingNumber']),
  )
  const cargoProviderName = firstNonEmpty(
    order.cargoProviderName,
    readSuratField(sources, [
      'cargoProviderName',
      'cargoProvider',
      'cargoCompanyName',
      'cargoSenderNumber',
    ]),
  )
  const cargoProviderId = firstNonEmpty(
    order.cargoProviderId,
    readSuratField(sources, ['cargoProviderId']),
  )
  const cargoCompanyId = firstNonEmpty(
    order.cargoCompanyId,
    readSuratField(sources, ['cargoCompanyId', 'cargoProviderId']),
  )
  const marketplaceStatus = firstNonEmpty(
    order.marketplaceStatus,
    readSuratField(sources, ['marketplaceStatus', 'status']),
  )
  const packageStatus = firstNonEmpty(
    order.packageStatus,
    readSuratField(sources, ['packageStatus', 'status']),
  )
  const orderLineItemStatusName = firstNonEmpty(
    readSuratField(sources, ['orderLineItemStatusName', 'lineStatusName']),
    packageStatus,
  )
  const cargoTrackingLink = firstNonEmpty(
    order.cargoTrackingLink,
    readSuratField(sources, ['cargoTrackingLink', 'trackingUrl']),
  )
  const existingCargoTrackingNumber = firstNonEmpty(
    readSuratField(sources, ['existingCargoTrackingNumber']),
    cargoTrackingNumber,
  )
  const shipmentStatus = firstNonEmpty(
    order.shipmentStatusName,
    readSuratField(sources, ['shipmentStatus', 'shipmentStatusName']),
  )
  const isReadyToShip = readOptionalBoolean(
    firstNonEmpty(order.isReadyToShip, readSuratField(sources, ['isReadyToShip'])),
  )
  const statusText = [
    marketplaceStatus,
    packageStatus,
    orderLineItemStatusName,
    shipmentStatus,
  ]
    .join(' ')
    .toLocaleLowerCase('tr-TR')
  const isCancelled =
    ['Cancelled', 'Returned', 'UnDelivered', 'UnSupplied'].includes(
      marketplaceStatus,
    ) || /cancel|iptal|return|iade|refund|un.?supplied/i.test(statusText)
  const isDelivered =
    marketplaceStatus === 'Delivered' || /delivered|teslim/i.test(statusText)
  const isShipped =
    ['Shipped', 'AtCollectionPoint'].includes(marketplaceStatus) ||
    /shipped|kargoda|ta[sş][iı]mada|at.?collection/i.test(statusText)
  const hasCargoTrackingNumber = Boolean(cargoTrackingNumber)
  const normalizedCargoProviderName = normalizeSearchText(cargoProviderName)
  const suratAssigned = cargoProviderName
    ? isSuratCargoProviderName(cargoProviderName)
    : null
  const existingShipmentDetected = Boolean(
    cargoTrackingLink &&
      (isShipped || isDelivered || /kargo.?takip|tracking/i.test(cargoTrackingLink)),
  )
  const requiresPickingUpdate = isTrendyolCreatedPackageStatus({
    marketplaceStatus,
    packageStatus,
    orderLineItemStatusName,
    shipmentStatus,
  })
  const diagnostics: string[] = []
  if (requiresPickingUpdate) diagnostics.push('Trendyol paketi Yeni/Created statüsünde; Sürat öncesi Picking/İşleme Al yapılmalı.')
  if (!hasCargoTrackingNumber) diagnostics.push('Trendyol cargoTrackingNumber bulunamadı.')
  if (isCancelled) diagnostics.push('Trendyol paketi iptal/iade statüsünde.')
  if (isDelivered) diagnostics.push('Trendyol paketi teslim edilmiş görünüyor.')
  if (isShipped) diagnostics.push('Trendyol paketi kargoda/teslim sürecinde görünüyor.')
  if (isReadyToShip === false) diagnostics.push('Trendyol isReadyToShip=false döndü.')
  if (suratAssigned === false) diagnostics.push('Sipariş Sürat Kargo’ya atanmış görünmüyor.')
  if (existingShipmentDetected) diagnostics.push('Mevcut cargoTrackingLink/gönderi izi var.')
  // ═══ TEK YUKLEM LISTESI, IKI OKUMA ═══════════════════════════════════
  //
  // Liste BIR KEZ yazilir. `canCallSuratAfterPickingUpdate` Created
  // kosulunu DISARIDA birakir; gercek karar (`canCall...`) ondan TUREtilir.
  // Boylece iki cevap ASLA ayrisamaz: ikinci bir kopya YOKTUR.
  const canCallSuratAfterPickingUpdate = Boolean(
    hasCargoTrackingNumber &&
      !isCancelled &&
      !isDelivered &&
      !isShipped &&
      isReadyToShip !== false &&
      suratAssigned !== false,
  )
  const canCallGonderiyiKargoyaGonder = Boolean(
    canCallSuratAfterPickingUpdate && !requiresPickingUpdate,
  )

  return {
    ok: canCallGonderiyiKargoyaGonder,
    canCallSurat: canCallGonderiyiKargoyaGonder,
    reason: canCallGonderiyiKargoyaGonder
      ? 'Trendyol preflight engeli bulunmadı.'
      : diagnostics[0] ||
        'Bu sipariş Trendyol tarafında kargo oluşturma için uygun statüde değil.',
    orderNumber,
    packageId,
    shipmentPackageId,
    cargoTrackingNumber,
    cargoProviderName,
    normalizedCargoProviderName,
    cargoProviderId,
    cargoCompanyId,
    marketplaceStatus,
    packageStatus,
    orderLineItemStatusName,
    cargoTrackingLink,
    existingCargoTrackingNumber,
    shipmentStatus,
    isCancelled,
    isDelivered,
    isShipped,
    isReadyToShip,
    suratAssigned,
    hasCargoTrackingNumber,
    existingShipmentDetected,
    canCallGonderiyiKargoyaGonder,
    requiresPickingUpdate,
    canCallSuratAfterPickingUpdate,
    pickingUpdatePerformed: Boolean(order.trendyolPickingUpdate?.ok),
    pickingUpdate: order.trendyolPickingUpdate,
    diagnostics,
  }
}
