// TRENDYOL SİPARİŞ UCU — TEK OTORİTE (saf karar; ağ/DB YOK).
//
// ═══ NEDEN TEK YER ═══════════════════════════════════════════════════════
//
// Denetim, sipariş yolunu ÜÇ dosyada ayrı ayrı kurulmuş buldu:
//   · server/index.mjs                      (canlı senkron)
//   · server/trendyol/historicalOrderFetch.ts (geçmiş geri-dolum)
//   · server/orders/trendyolPackageIdentityTrace.ts (tanı CLI'ı)
// Üçü de aynı dizgiyi elle yazıyordu. Emekliye ayrılan bir yolu üç yerde
// aramak, BİRİNİ ATLAMAK demektir — ve atlanan yer 15 Ekim 2026'dan sonra
// sessizce 426 alırdı. Yol artık BURADA kurulur; çağıranlar dizgi yazmaz.
//
// ═══ RESMÎ SÖZLEŞME ══════════════════════════════════════════════════════
//
// KAYNAK: developers.trendyol.com — "Sipariş Paketlerini Çekme
// (getShipmentPackages)", sayfa güncellemesi 2026-09-09; Changelog
// "Yeni Sipariş Entegrasyon Servis Endpointi" 30.07.2026; "1. Servis
// Limitleri" 2026-08-25. Doğrulama: 2026-09-14.
//
//   · v2 ZORUNLU  : 15 Ekim 2026
//   · eski uç     : 15 Ekim 2026'a kadar günde 3 kez 10'ar dakika 426 döner
//   · sayfalama   : page 0 tabanlı, size ≤ 200
//   · erişim penceresi: maxQueryWindowResult = 10.000 shipmentPackageId
//   · tarih       : startDate/endDate epoch ms, GMT+3; en geniş aralık 2 hafta
//   · geçmiş      : en çok 1 ay geriye
//   · sıralama    : orderByField=PackageLastModifiedDate, ASC | DESC
//   · limit       : bu servise dakikada 1000 istek
//
// Yanıt ZARFI v1 ile AYNIDIR: { totalElements, totalPages, page, size,
// content[] }. Bu yüzden normalleştirme katmanı DEĞİŞMEZ (bkz. adapter
// sınırı: ham yanıt → kanonik paket → mevcut CargoFlow normalizasyonu).

/** Emekliye ayrılan yol — YALNIZ tespit/regresyon için; istek KURULMAZ. */
export const TRENDYOL_ORDERS_DEPRECATED_PATH_TEMPLATE =
  '/integration/order/sellers/{sellerId}/orders'

/** Zorunlu v2 yolu. */
export const TRENDYOL_ORDERS_V2_PATH_TEMPLATE =
  '/integration/order/sellers/{sellerId}/v2/orders'

/** Eski ucun kapanma tarihi (resmî duyuru). */
export const TRENDYOL_ORDERS_V2_MANDATORY_DATE = '2026-10-15'

/** Geçiş döneminde eski uçtan dönen kod. */
export const TRENDYOL_DEPRECATED_ENDPOINT_STATUS = 426

/** `maxQueryWindowResult` — sayfalama ile erişilebilen AZAMİ kayıt. */
export const TRENDYOL_V2_MAX_QUERY_WINDOW_RESULT = 10_000

/** Sözleşme üst sınırı. */
export const TRENDYOL_V2_MAX_PAGE_SIZE = 200

/** Tek istekte verilebilecek en geniş tarih aralığı (2 hafta). */
export const TRENDYOL_V2_MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000

/** Servisin eriştiği azami geçmiş (1 ay). */
export const TRENDYOL_V2_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Dilim sınırları KAPSAYICIDIR ve bir sonraki dilim +1 ms'den başlar.
 * Mevcut pencereleme kodu (`cursor = windowEnd + 1`) bu uzlaşımı kullanır;
 * dilimleyici de AYNISINI kullanır ki iki yerde iki farklı sınır semantiği
 * olmasın.
 */
export const TRENDYOL_SLICE_GAP_MS = 1

export function buildTrendyolOrdersV2Path(sellerId: string | number): string {
  return TRENDYOL_ORDERS_V2_PATH_TEMPLATE.replace(
    '{sellerId}',
    encodeURIComponent(String(sellerId ?? '')),
  )
}

export function buildTrendyolOrdersV2Url(params: {
  baseUrl: string
  sellerId: string | number
  search?: URLSearchParams | string
}): string {
  const base = String(params.baseUrl ?? '').replace(/\/+$/, '')
  const search = String(params.search ?? '')
  const path = buildTrendyolOrdersV2Path(params.sellerId)
  return search ? `${base}${path}?${search}` : `${base}${path}`
}

/**
 * Bir URL emekli uca mı gidiyor?
 *
 * `/v2/orders` ve `/orders/stream` HARİÇ tutulur: ikincisi ayrı ve GÜNCEL
 * bir servistir (getShipmentPackagesStream), emekliye ayrılan o değildir.
 */
export function isDeprecatedTrendyolOrdersUrl(url: unknown): boolean {
  const text = String(url ?? '')
  return /\/integration\/order\/sellers\/[^/]+\/orders(?!\/stream)(?:$|[?#])/.test(
    text,
  )
}

// ═══ ERİŞİM PENCERESİ (10.000 KAYIT) ══════════════════════════════════════
//
// Resmî örnek size=200 üzerinden anlatılır (page 0..49). Gerçek değişmez
// KAYIT OFSETİDİR: bir sayfanın SON kaydı 10.000'i aşamaz. Kuralı yalnız
// "page ≤ 49" diye yazmak size=50 kullanan çağıranda YANLIŞ olurdu.

/** Bu sayfa boyutuyla erişilebilen sayfa adedi. */
export function maxReachablePageCount(size: number): number {
  const pageSize = Math.max(1, Math.floor(Number(size) || 1))
  return Math.floor(TRENDYOL_V2_MAX_QUERY_WINDOW_RESULT / pageSize)
}

/** Bu sayfa erişim penceresinin İÇİNDE mi? */
export function isPageReachable(params: {
  page: number
  size: number
}): boolean {
  const page = Math.max(0, Math.floor(Number(params.page) || 0))
  const pageSize = Math.max(1, Math.floor(Number(params.size) || 1))
  return (page + 1) * pageSize <= TRENDYOL_V2_MAX_QUERY_WINDOW_RESULT
}

export interface TrendyolQueryWindowCap {
  /** Filtre sonucu erişim penceresini AŞIYOR mu? */
  capped: boolean
  totalElements: number
  reachableRecords: number
  unreachableRecords: number
  /**
   * Bu filtrenin cap altına inmesi için gereken ASGARİ dilim sayısı.
   * Sağlayıcının KENDİ `totalElements` değerinden türetilir — sabit
   * "1 gün" gibi bir sayı UYDURULMAZ.
   */
  requiredSliceCount: number
  reason: 'WITHIN_WINDOW' | 'TOTAL_EXCEEDS_QUERY_WINDOW' | 'UNKNOWN_TOTAL'
}

/**
 * Cap tespiti.
 *
 * SESSİZ BAŞARI YASAK: `totalElements` erişilebilir kayıttan büyükse çağrı
 * "tamamlandı" SAYILAMAZ. `totalPages` 50'den büyük görünebilir; bu,
 * sayfaların erişilebilir olduğu anlamına GELMEZ (resmî uyarı).
 *
 * `totalElements` okunamıyorsa sonuç `UNKNOWN_TOTAL`'dır ve cap'li SAYILMAZ:
 * bilinmeyeni "aşıldı" saymak her turda gereksiz bölme üretirdi. Bilinmeyen
 * durum çağırana AÇIKÇA bildirilir.
 */
export function detectQueryWindowCap(params: {
  totalElements: unknown
  size: number
}): TrendyolQueryWindowCap {
  const pageSize = Math.max(1, Math.floor(Number(params.size) || 1))
  const reachableRecords = Math.min(
    TRENDYOL_V2_MAX_QUERY_WINDOW_RESULT,
    maxReachablePageCount(pageSize) * pageSize,
  )
  const rawTotal = Number(params.totalElements)
  if (!Number.isFinite(rawTotal) || rawTotal < 0) {
    return {
      capped: false,
      totalElements: 0,
      reachableRecords,
      unreachableRecords: 0,
      requiredSliceCount: 1,
      reason: 'UNKNOWN_TOTAL',
    }
  }
  const totalElements = Math.floor(rawTotal)
  if (totalElements <= reachableRecords) {
    return {
      capped: false,
      totalElements,
      reachableRecords,
      unreachableRecords: 0,
      requiredSliceCount: 1,
      reason: 'WITHIN_WINDOW',
    }
  }
  return {
    capped: true,
    totalElements,
    reachableRecords,
    unreachableRecords: totalElements - reachableRecords,
    requiredSliceCount: Math.ceil(totalElements / reachableRecords),
    reason: 'TOTAL_EXCEEDS_QUERY_WINDOW',
  }
}

// ═══ TARİH DİLİMLEME ══════════════════════════════════════════════════════

export interface TrendyolDateSlice {
  startMs: number
  endMs: number
}

/**
 * Aralığı KAPSAYICI, BİTİŞİK ve DETERMİNİST dilimlere böler.
 *
 * İki sürücü vardır ve ikisi de UYDURMA DEĞİLDİR:
 *   · `maxRangeMs` — resmî 2 haftalık tek-istek sınırı.
 *   · `sliceCount` — cap tespitinden gelen, sağlayıcının `totalElements`
 *     değerinden TÜRETİLMİŞ asgari bölme sayısı.
 * İkisi birlikte verildiğinde DAHA DAR olan kazanır.
 *
 * Dilim genişliği 1 ms'in altına inemez: API zaman damgası milisaniyedir,
 * daha ince bölme FİZİKSEL OLARAK yoktur. O noktada bölme DURUR ve çağıran
 * durumu bildirir — sessizce eksik veriyle "başarılı" dönmez.
 */
export function planTrendyolDateSlices(params: {
  startMs: number
  endMs: number
  maxRangeMs?: number
  sliceCount?: number
}): TrendyolDateSlice[] {
  const startMs = Math.floor(Number(params.startMs))
  const endMs = Math.floor(Number(params.endMs))
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return []
  }
  const span = endMs - startMs + 1
  const maxRangeMs = Math.max(
    1,
    Math.floor(Number(params.maxRangeMs ?? TRENDYOL_V2_MAX_RANGE_MS)),
  )
  const requested = Math.max(1, Math.floor(Number(params.sliceCount ?? 1)))
  const widthFromCount = Math.max(1, Math.ceil(span / requested))
  const width = Math.min(maxRangeMs, widthFromCount)

  const slices: TrendyolDateSlice[] = []
  let cursor = startMs
  while (cursor <= endMs) {
    const sliceEnd = Math.min(endMs, cursor + width - 1)
    slices.push({ startMs: cursor, endMs: sliceEnd })
    if (sliceEnd >= endMs) break
    cursor = sliceEnd + TRENDYOL_SLICE_GAP_MS
  }
  return slices
}

/** Aralık daha ince bölünebilir mi? (1 ms tabanı) */
export function canSplitFurther(slice: TrendyolDateSlice): boolean {
  return Math.floor(slice.endMs) - Math.floor(slice.startMs) >= 1
}

/**
 * Bir aralık resmî geçmiş sınırının DIŞINDA mı?
 *
 * Bu bir HATA DEĞİL, bir UYARIDIR: sınır dışı aralık için servis boş döner.
 * Boş yanıtı "sipariş yok" sanmak, geri-dolumun sessizce hiçbir şey
 * yapmaması demektir; çağıran bunu ayırt edebilsin diye AÇIKÇA raporlanır.
 */
export function isBeyondLookback(params: {
  startMs: number
  nowMs: number
}): boolean {
  const startMs = Number(params.startMs)
  const nowMs = Number(params.nowMs)
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return false
  return nowMs - startMs > TRENDYOL_V2_MAX_LOOKBACK_MS
}
