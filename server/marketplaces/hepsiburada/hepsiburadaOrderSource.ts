// HEPSIBURADA — SİPARİŞ KAYNAĞI (saf karar; ağ/DB YOK).
//
// KAYNAK: Hepsiburada Developer Portal, doğrulama 2026-08-19.
// Kanıtlı kurallar: ödemesi alınmış sipariş listesi `offset`/`limit` ile
// sayfalanır ve `begindate`/`enddate` ile sınırlanır; paket listelemesinde
// pencere uç noktaya göre 24 saatle KISITLI olabilir.
//
// TRENDYOL SEMANTİĞİ BURAYA TAŞINMAZ. Özellikle paket kimliği: Trendyol'da
// `packageId` sipariş paketidir; Hepsiburada'da paket kavramı `packageNumber`
// ile AYRI bir kayıttır ve `orderNumber` ile AYNI ŞEY DEĞİLDİR.

import type { HepsiburadaApiFamily } from './hepsiburadaContract.ts'

/** Resmî: paket listelemesinde pencere 24 saatle kısıtlanabilir. */
export const HEPSIBURADA_PACKAGE_WINDOW_MAX_MS = 24 * 60 * 60 * 1000

/** Sipariş listelemesi için uygulanan üst sınır — yapılandırılabilir. */
export const HEPSIBURADA_DEFAULT_ORDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Sayfa boyutu üst sınırı yapılandırmadan gelir; burada makul bir tavan. */
export const HEPSIBURADA_MAX_LIMIT = 100

export interface HepsiburadaPageRequest {
  offset: number
  limit: number
  begindate: string
  enddate: string
}

export interface HepsiburadaWindowResolution {
  ok: boolean
  startMs: number
  endMs: number
  clamped: boolean
  errorCode: 'HB_WINDOW_INVALID' | null
  reason: string | null
}

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * Pencereyi SINIRLAR.
 *
 * Sunucunun büyük aralığı kabul edeceği VARSAYILMAZ: istenen aralık üst
 * sınırı aşarsa SON pencereye kırpılır ve `clamped` ile bildirilir. Paket
 * ailesinde üst sınır 24 saattir (resmî uyarı).
 */
export function resolveHepsiburadaWindow(params: {
  startMs?: number | null
  endMs?: number | null
  nowMs: number
  family?: HepsiburadaApiFamily
  maxWindowMs?: number
}): HepsiburadaWindowResolution {
  const nowMs = params.nowMs
  const maxWindowMs =
    params.maxWindowMs ??
    (params.family === 'PACKAGES'
      ? HEPSIBURADA_PACKAGE_WINDOW_MAX_MS
      : HEPSIBURADA_DEFAULT_ORDER_WINDOW_MS)

  const endMs = Number.isFinite(Number(params.endMs)) ? Number(params.endMs) : nowMs
  const requestedStart = Number.isFinite(Number(params.startMs))
    ? Number(params.startMs)
    : endMs - maxWindowMs

  if (endMs < requestedStart) {
    return {
      ok: false, startMs: requestedStart, endMs, clamped: false,
      errorCode: 'HB_WINDOW_INVALID',
      reason: 'enddate, begindate değerinden küçük olamaz.',
    }
  }
  const span = endMs - requestedStart
  if (span > maxWindowMs) {
    return {
      ok: true,
      startMs: endMs - maxWindowMs,
      endMs,
      clamped: true,
      errorCode: null,
      reason: null,
    }
  }
  return { ok: true, startMs: requestedStart, endMs, clamped: false, errorCode: null, reason: null }
}

/**
 * Sayfa isteği kurar. `offset`/`limit` resmî sözleşmedir; `page` DEĞİLDİR
 * (n11 sayfa tabanlıdır — iki sağlayıcı KARIŞTIRILMAZ).
 */
export function buildHepsiburadaPageRequest(params: {
  offset?: number
  limit?: number
  startMs: number
  endMs: number
}): HepsiburadaPageRequest {
  const offset = Math.max(0, Math.trunc(Number(params.offset ?? 0)) || 0)
  const rawLimit = Math.trunc(Number(params.limit ?? HEPSIBURADA_MAX_LIMIT)) || 0
  const limit = Math.min(Math.max(1, rawLimit), HEPSIBURADA_MAX_LIMIT)
  return {
    offset,
    limit,
    begindate: iso(params.startMs),
    enddate: iso(params.endMs),
  }
}

/**
 * Sonraki sayfa var mı?
 *
 * SINIRLI ÇEKİM: dönen kayıt sayısı `limit`ten AZSA son sayfadır. Ayrıca
 * `maxPages` tavanı çağıran tarafından uygulanır — sonsuz sayfalama YOK.
 */
export function hasNextHepsiburadaPage(params: {
  returnedCount: number
  limit: number
}): boolean {
  return Number(params.returnedCount) >= Number(params.limit) && Number(params.limit) > 0
}

// ═══ TAŞIYICI EŞLEME ══════════════════════════════════════════════════════

/**
 * `cargoCompany` metnini kanonik taşıyıcı anahtarına eşler.
 *
 * Eşlenemeyen değer `null` döner — UYDURMA anahtar üretilmez. Çağıran ham
 * metni korur; kanonik anahtar yalnız eşleşme kanıtlıysa doldurulur.
 */
export function mapHepsiburadaCarrier(cargoCompany: unknown): string | null {
  const token = String(cargoCompany ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, '')
  if (!token) return null
  if (token.includes('hepsijet')) return 'hepsijet'
  if (token.includes('aras')) return 'aras'
  if (token.includes('yurtici') || token.includes('yurtiçi')) return 'yurtici'
  if (token.includes('mng')) return 'mng'
  if (token.includes('surat') || token.includes('sürat')) return 'surat'
  if (token.includes('ptt')) return 'ptt'
  return null
}

// ═══ NORMALİZASYON ════════════════════════════════════════════════════════

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

const toIso = (value: unknown): string => {
  const raw = str(value)
  if (!raw) return ''
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

export interface NormalizedHepsiburadaOrder {
  id: string
  marketplace: 'Hepsiburada'
  externalOrderId: string
  orderNumber: string
  /** Paket VARSA `packageNumber`; yoksa BOŞ — orderNumber'a düşülmez. */
  packageId: string
  marketplacePackageId: string
  marketplaceBarcode: string
  marketplaceTrackingNumber: string
  marketplaceTrackingUrl: string
  marketplaceCarrier: string | null
  rawCarrierName: string
  marketplaceStatus: string
  rawMarketplaceStatus: string
  merchantId: string
  orderDate: string
  customerName: string
  shipmentAddress: Record<string, unknown>
  city: string
  district: string
  items: Array<Record<string, unknown>>
  rawOrder: Record<string, unknown>
}

/**
 * Hepsiburada sipariş/paket kaydını CargoFlow normalleştirilmiş şekline
 * çevirir.
 *
 * KİMLİK KURALLARI (resmî ayrımlar korunur):
 *  · `orderNumber` ≠ `packageNumber` — paket yoksa `packageId` BOŞ kalır,
 *  · `barcode` ≠ `trackingInfoCode` — ikisi AYRI alanlara yazılır,
 *  · tüm kimlikler DİZE olarak taşınır; sabit hane sayısı VARSAYILMAZ.
 */
export function normalizeHepsiburadaOrder(
  raw: Record<string, unknown> = {},
): NormalizedHepsiburadaOrder {
  const orderNumber = str(raw.orderNumber)
  const orderId = str(raw.orderId)
  const packageNumber = str(raw.packageNumber)
  const address = (raw.shippingAddress ?? {}) as Record<string, unknown>
  const rawStatus = str(raw.status)
  const cargoCompany = str(raw.cargoCompany)

  const lines = Array.isArray(raw.items)
    ? (raw.items as Record<string, unknown>[])
    : Array.isArray(raw.lines)
      ? (raw.lines as Record<string, unknown>[])
      : []

  return {
    // Kimlik önceliği: paket VARSA paket, yoksa sipariş kimliği. Trendyol'un
    // `ty_order_` deseni KOPYALANMAZ; sağlayıcı öneki AYRI tutulur.
    id: `hb_order_${packageNumber || orderId || orderNumber}`,
    marketplace: 'Hepsiburada',
    externalOrderId: orderId || orderNumber,
    orderNumber,
    packageId: packageNumber,
    marketplacePackageId: packageNumber,
    marketplaceBarcode: str(raw.barcode),
    marketplaceTrackingNumber: str(raw.trackingInfoCode),
    marketplaceTrackingUrl: str(raw.trackingInfoUrl),
    marketplaceCarrier: mapHepsiburadaCarrier(cargoCompany),
    rawCarrierName: cargoCompany,
    marketplaceStatus: rawStatus,
    // HAM statü KORUNUR: sağlayıcı sözlüğü CargoFlow sözlüğüne indirgenirken
    // kaybolmamalıdır (denetim ve sonraki eşleme düzeltmeleri için).
    rawMarketplaceStatus: rawStatus,
    merchantId: str(raw.merchantId),
    orderDate: toIso(raw.orderDate),
    customerName: str(address.name ?? raw.customerName),
    shipmentAddress: address,
    city: str(address.city),
    district: str(address.district ?? address.town),
    items: lines.map((line, index) => ({
      // Satır kimliği resmî olarak benzersizdir; yoksa indeks TÜRETİLİR ve
      // bunun türetilmiş olduğu belli olur.
      externalLineId:
        str(line.lineItemId ?? line.id ?? line.orderLineId) ||
        `hb-line-${packageNumber || orderNumber}-${index}`,
      merchantSku: str(line.merchantSku),
      sku: str(line.sku ?? line.hbSku),
      productName: str(line.productName ?? line.name) || 'Ürün',
      quantity: Math.max(0, Math.trunc(Number(line.quantity ?? 1)) || 0),
      rawLine: line,
    })),
    rawOrder: raw,
  }
}

export function normalizeHepsiburadaOrders(
  rawOrders: unknown,
): { orders: NormalizedHepsiburadaOrder[]; duplicateRemovedCount: number } {
  const list = Array.isArray(rawOrders) ? (rawOrders as Record<string, unknown>[]) : []
  const seen = new Map<string, NormalizedHepsiburadaOrder>()
  let duplicateRemovedCount = 0
  for (const raw of list) {
    const normalized = normalizeHepsiburadaOrder(raw)
    const key = normalized.marketplacePackageId || normalized.externalOrderId
    if (!key) continue
    if (seen.has(key)) {
      duplicateRemovedCount += 1
      continue
    }
    seen.set(key, normalized)
  }
  return { orders: [...seen.values()], duplicateRemovedCount }
}
