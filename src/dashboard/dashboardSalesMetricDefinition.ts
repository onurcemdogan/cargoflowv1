// CANONICAL Dashboard satış metriği tanımı — TEK KAYNAK (single source of truth).
//
// CargoFlow local-only Dashboard ile referans (Trendyol/Durusoft) satış
// Dashboard'u arasındaki tutarsızlık KÖK NEDENİ bir FORMÜL farkı değil, bir
// TANIM (semantik) farkıdır. Bu modül o tanımı açıkça sabitler; backend
// mutabakatı, frontend viewModel ve diagnostic CLI AYNI tanımı kullanır ki
// aynı kavram üç yerde farklı uygulanmasın.
//
// Bu dosya SAF'tır: hiçbir import'u yoktur, DOM/Node API'sine dokunmaz. Böylece
// hem Vite (frontend), hem Node type-strip (server/CLI) tarafından yüklenebilir.
//
// KURAL: Rakamları referans Dashboard'a ZORLA eşitlemek için buradaki tanımlar
// keyfî değiştirilmez. Fark tanım/veri farkıysa raporlanır, formül eğilip
// bükülmez.

// ── TARİH EKSENİ (date basis) ────────────────────────────────────────────────
// Dashboard satış dönemi bir sipariş KOHORTUDUR: sipariş, orderDate (sipariş
// oluşturma tarihi) ayına yazılır. Bu, provider historical-fetch penceresinden
// (marketplaceLastModifiedAt AKTİVİTESİ) FARKLI bir eksendir; ikisi
// karıştırılmamalıdır (bkz. HISTORICAL_ACTIVITY_BASIS).
export const SALES_DATE_BASIS = 'order_date' as const
export type SalesDateBasis =
  | 'order_date'
  | 'marketplace_last_modified_at'

// Provider historical fetch / backfill penceresinin GERÇEK ekseni. Trendyol'a
// verilen startDate/endDate pratikte orderDate değil packageLastModifiedDate
// aktivite penceresi gibi davranır. Aynı ay için orderDate kohortu ≠
// modifiedDate aktivitesi (ör. bir önceki ayın siparişi bu ay güncellenebilir).
export const HISTORICAL_ACTIVITY_BASIS = 'marketplace_last_modified_at' as const

// KULLANICIYA gösterilecek eksen etiketleri: iki farklı metrik ASLA aynı isimle
// sunulmaz. Dashboard satış kartları orderDate kohortudur → "Sipariş Tarihine
// Göre". Provider aktivite penceresi → "Son Güncellenme Tarihine Göre".
export const SALES_DATE_BASIS_LABEL = 'Sipariş Tarihine Göre Satış'
export const ACTIVITY_DATE_BASIS_LABEL = 'Son Güncellenme Tarihine Göre Aktivite'

// ── SAAT DİLİMİ ──────────────────────────────────────────────────────────────
// Satış rapor GÜNÜ Durusoft mutabakatı gereği UTC bucket sınırıyla hesaplanır;
// "bugün hangi tarih?" seçimi (anchor) Europe/Istanbul takvimine göre yapılır
// (bkz. reportingRange.ts). Kullanıcıya gösterim İstanbul'dur.
export const SALES_REPORTING_TIME_ZONE = 'UTC' as const
export const REPORT_DAY_ANCHOR_TIME_ZONE = 'Europe/Istanbul' as const

// ── PAKET / KALEM / ADET KİMLİĞİ ─────────────────────────────────────────────
// PAKET: benzersiz sevkiyat/operasyon birimi = distinct packageId (yoksa
// shipmentPackageId, yoksa marketplace::orderNumber). Bir Trendyol siparişi
// birden çok pakete bölünebilir; her paket bir satış/operasyon birimidir.
export const METRIC_PACKAGE = 'distinct_package_id'
// KALEM: order_lines SATIR SAYISI (distinct order line), quantity toplamı DEĞİL.
export const METRIC_LINE = 'order_line_count'
// ÜRÜN ADEDİ: order_lines quantity TOPLAMI (kaç adet ürün).
export const METRIC_UNIT_QUANTITY = 'order_line_quantity_sum'

// ── TUTAR KAYNAĞI (amount source) ────────────────────────────────────────────
// Satış tutarı SİPARİŞ SEVİYESİ order.totalAmount'tan gelir (Trendyol
// grossAmount/totalPrice; indirim provider tarafında zaten yansıtılmıştır).
// order_lines.lineTotal (unitPrice × quantity) toplamı KULLANILMAZ — Trendyol
// satır fiyatı liste fiyatıdır ve toplamı sipariş tutarını AŞAR (fark indirim/
// kupon kaynaklıdır). resolveOrderAmount önceliği: totalAmount → totalPrice →
// (son çare) satırların price×quantity toplamı.
export const AMOUNT_SOURCE = 'order.totalAmount' as const

// ── DISPOSITION (satış / iade / iptal sınıflandırması) ───────────────────────
// Local-only Dashboard bir siparişi statüsüne göre TEK bir dispozisyona düşürür.
// Öncelik: RETURN > CANCEL > SALE. Bu token kümeleri frontend salesDisposition
// ile AYNI kaynaktır (viewModel bu sabitleri import eder → tek uygulama).
//
// Kanıtlanan eşleme (Faz 4): Returned + UnDelivered → return; Cancelled +
// UnSupplied → cancel; Delivered/Created/Picking/Invoiced/Shipped/
// AtCollectionPoint → sale.
export const RETURN_DISPOSITION_TOKENS = [
  'returned',
  'returning',
  'return',
  'iade',
  'undelivered',
] as const
export const CANCEL_DISPOSITION_TOKENS = [
  'cancelled',
  'canceled',
  'cancel',
  'iptal',
  'unsupplied',
] as const

export type SalesDisposition = 'sale' | 'return' | 'cancel'

// frontend normalizeIdentity ile AYNI kural (tek kaynak). Türkçe-katlama +
// aksan temizliği + alfasayısal dışı → '-'.
/**
 * DESENLER MODÜL DÜZEYİNDE.
 *
 * Bunlar her çağrıda `new RegExp(...)` ile YENİDEN kuruluyordu. CPU profili
 * (gerçek Postgres, 2.000 sipariş): bu tek fonksiyon örneklerin ~%28'iydi.
 * Desenler sabittir; kurulum maliyeti gereksizdi.
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g
const DOTLESS_I = /\u0131/g
const NON_ALNUM = /[^a-z0-9]+/g
const EDGE_DASH = /^-|-$/g

/**
 * DİZE HAFIZASI — aynı statü metni bir istek içinde binlerce kez normalize
 * ediliyordu (her sipariş için birden çok statü sinyali). Dönüşüm saf ve
 * deterministiktir; hafıza yalnız tekrarı ortadan kaldırır, kuralı DEĞİL.
 * Sınır aşılırsa tamamen boşaltılır (sınırsız bellek YOK).
 */
const DISPOSITION_MEMO_LIMIT = 20_000
const dispositionMemo = new Map<string, string>()

export function normalizeDispositionToken(value: unknown): string {
  const raw = String(value ?? '')
  if (raw === '') return ''
  const cached = dispositionMemo.get(raw)
  if (cached !== undefined) return cached
  const normalized = raw
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(DOTLESS_I, 'i')
    .replace(NON_ALNUM, '-')
    .replace(EDGE_DASH, '')
  if (dispositionMemo.size >= DISPOSITION_MEMO_LIMIT) dispositionMemo.clear()
  dispositionMemo.set(raw, normalized)
  return normalized
}

function matchesAny(token: string, candidates: readonly string[]): boolean {
  return candidates.some(
    (candidate) => token === candidate || token.includes(candidate),
  )
}

// Bir veya daha çok statü sinyalinden (marketplaceStatus, packageStatus,
// shipmentStatusName, raw statüler) canonical dispozisyonu üretir. RETURN
// önce kontrol edilir (öncelik). Hiçbir sinyal eşleşmezse 'sale'.
export function classifyCanonicalDisposition(
  ...statusSignals: unknown[]
): SalesDisposition {
  const tokens = statusSignals.map(normalizeDispositionToken)
  if (tokens.some((token) => matchesAny(token, RETURN_DISPOSITION_TOKENS))) {
    return 'return'
  }
  if (tokens.some((token) => matchesAny(token, CANCEL_DISPOSITION_TOKENS))) {
    return 'cancel'
  }
  return 'sale'
}

// Bir SİPARİŞ nesnesinden canonical dispozisyon (Dashboard, reconciliation,
// backend metrics ve diagnostic AYNI fonksiyonu kullanır). marketplaceStatus,
// packageStatus, shipmentStatusName ve ham (rawOrder) statü alanları birlikte
// değerlendirilir.
export function orderDispositionOf(order: {
  marketplaceStatus?: unknown
  packageStatus?: unknown
  shipmentStatusName?: unknown
  rawOrder?: unknown
}): SalesDisposition {
  const raw =
    order.rawOrder && typeof order.rawOrder === 'object'
      ? (order.rawOrder as Record<string, unknown>)
      : undefined
  return classifyCanonicalDisposition(
    order.marketplaceStatus,
    order.packageStatus,
    order.shipmentStatusName,
    raw?.status,
    raw?.packageStatus,
    raw?.shipmentStatus,
  )
}

// ── TUTAR ÇÖZÜMLEME (single source) ──────────────────────────────────────────
// Satış tutarı SİPARİŞ SEVİYESİNDEN gelir: totalAmount → totalPrice → (son çare)
// satırların price×quantity toplamı. lineTotal KULLANILMAZ. Hesaplanamıyorsa
// null (tutar bilinmiyor; "kesin 0" DEĞİL).
// viewModel isNumber ile AYNI: null/'' değil ve sonlu (negatif de kabul; mevcut
// davranışla birebir).
function isNumberLike(value: unknown): boolean {
  return value !== null && value !== '' && Number.isFinite(Number(value))
}
function toFinite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
export function resolveCanonicalOrderAmount(order: {
  totalAmount?: unknown
  totalPrice?: unknown
  items?: Array<{ price?: unknown; quantity?: unknown }>
}): number | null {
  for (const candidate of [order.totalAmount, order.totalPrice]) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  const items = Array.isArray(order.items) ? order.items : []
  if (items.length > 0 && items.every((item) => isNumberLike(item.price))) {
    return items.reduce(
      (sum, item) => sum + toFinite(item.price) * Math.max(0, toFinite(item.quantity)),
      0,
    )
  }
  return null
}

// ── PAKET KİMLİĞİ / DEDUPE (single source) ───────────────────────────────────
// Dashboard paket tekilleştirme anahtarı: packageId → shipmentPackageId →
// marketplace::orderNumber → id → (son çare) order-<orderDate ms>.
function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}
function orderTimestampMs(order: { orderDate?: unknown; createdAt?: unknown }): number {
  const time = new Date(String(order.orderDate ?? order.createdAt ?? '')).getTime()
  return Number.isFinite(time) ? time : 0
}
export function orderDedupeKey(order: {
  packageId?: unknown
  shipmentPackageId?: unknown
  marketplace?: unknown
  orderNumber?: unknown
  id?: unknown
  orderDate?: unknown
  createdAt?: unknown
}): string {
  return (
    firstNonEmpty(
      String(order.packageId ?? ''),
      String(order.shipmentPackageId ?? ''),
      `${String(order.marketplace ?? '')}::${String(order.orderNumber ?? '')}`,
      String(order.id ?? ''),
    ) || `order-${orderTimestampMs(order)}`
  )
}

// ── GROSS / NET anlamı ───────────────────────────────────────────────────────
// GROSS satış = sale dispozisyonlu siparişlerin tutar toplamı (iptal/iade hariç
// tutulur, ayrı gösterilir). NET satış = gross − kabul edilen kısmi/tam iade
// etkisi (claim varsa). Claim verisi yoksa (auth/local-only) iade YALNIZ
// Returned/UnDelivered statüsünden türetilir; kısmi iade tutarı YEREL'de yoktur.
export const GROSS_SALES_DEFINITION =
  'sum(order.totalAmount) over sale-disposition orders'
export const NET_SALES_FORMULA = 'gross - accepted_claim_deductions'

// ── İADE VERİ KAYNAĞI (refund source) ────────────────────────────────────────
// persisted_claims: gerçek claim muhasebesi (effectiveDate + kısmi tutar).
// order_status: claim yok; iade YALNIZ Returned/UnDelivered statüsünden (tam
//   paket tutarı; kısmi iade YOK).
// unavailable: hesaplanacak yerel veri yok → "kesin ₺0 iade" izlenimi VERİLMEZ.
export const REFUND_SOURCES = [
  'persisted_claims',
  'order_status',
  'unavailable',
] as const
export type RefundSource = (typeof REFUND_SOURCES)[number]

// Canonical tanımın makine-okunur özeti (diagnostic raporunda ve UI'da
// "date basis" etiketini göstermek için tek yerden okunur).
export interface SalesMetricDefinition {
  dateBasis: SalesDateBasis
  dateBasisLabel: string
  activityBasisLabel: string
  reportingTimeZone: string
  packageMetric: string
  lineMetric: string
  unitQuantityMetric: string
  amountSource: string
  grossDefinition: string
  netFormula: string
  refundSources: readonly RefundSource[]
}

export function describeSalesMetric(): SalesMetricDefinition {
  return {
    dateBasis: SALES_DATE_BASIS,
    dateBasisLabel: SALES_DATE_BASIS_LABEL,
    activityBasisLabel: ACTIVITY_DATE_BASIS_LABEL,
    reportingTimeZone: SALES_REPORTING_TIME_ZONE,
    packageMetric: METRIC_PACKAGE,
    lineMetric: METRIC_LINE,
    unitQuantityMetric: METRIC_UNIT_QUANTITY,
    amountSource: AMOUNT_SOURCE,
    grossDefinition: GROSS_SALES_DEFINITION,
    netFormula: NET_SALES_FORMULA,
    refundSources: REFUND_SOURCES,
  }
}
