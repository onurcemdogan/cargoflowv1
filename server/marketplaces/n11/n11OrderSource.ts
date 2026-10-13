// N11 — SİPARİŞ KAYNAĞI (saf karar; ağ/DB YOK).
//
// KAYNAK: n11 Mağaza Destek Merkezi, doğrulama 2026-08-19.
//
// ═══ EN KRİTİK KURAL ══════════════════════════════════════════════════════
//
// `cargoSenderNumber` ve `cargoTrackingNumber` FARKLI ŞEYLERDİR:
//
//   cargoSenderNumber   → kargo TAKİP numarası
//   cargoTrackingNumber → barkod / kargo kampanya kodu
//
// İsimler sezgiye TERS düşer ve tam da bu yüzden karıştırılmaya açıktır.
// Yer değiştirirlerse takip linki yanlış numarayı sorgular ve etiket yanlış
// barkodla basılır. İKİSİ DE korunur, hiçbiri diğerine düşmez.

import { N11_PACKAGE_STATUSES, type N11PackageStatus } from './n11Contract.ts'

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/**
 * Tarih → ISO. Resmî yanıt (developer.n11.com, Sipariş Listeleme Servisi)
 * tarihleri EPOCH MİLİSANİYE SAYI olarak döndürür (`lastModifiedDate`,
 * `packageHistories[].createdDate`); `Date.parse(String(sayı))` bunları
 * NaN'a çevirirdi. Sayı / rakam dizesi epoch ms kabul edilir; ISO dizesi
 * de okunur. Okunamayan değer BOŞ döner — tarih UYDURULMAZ.
 */
const toIso = (value: unknown): string => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : ''
  }
  const raw = str(value)
  if (!raw) return ''
  if (/^\d{12,16}$/.test(raw)) return new Date(Number(raw)).toISOString()
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

/**
 * Sipariş tarihi: `packageHistories` içindeki `Created` statüsünün
 * `createdDate`'i (n11 statü sözlüğünde Created = "Ödendi").
 *
 * Resmî yanıtta paket düzeyinde sipariş tarihi alanı YOKTUR. `lastModifiedDate`
 * ("son hareket tarihi") ve `agreedDeliveryDate` ("maksimum kargolama tarihi")
 * sipariş tarihi DEĞİLDİR ve KULLANILMAZ. Created kaydı yoksa BOŞ döner;
 * kayıt kanonik depoya yazılamaz sayılır (tarih uydurulmaz).
 */
function resolveN11OrderDate(histories: Array<Record<string, unknown>>): string {
  let earliest: string | null = null
  for (const entry of histories) {
    if (str(entry.status) !== 'Created') continue
    const iso = toIso(entry.createdDate)
    if (iso !== '' && (earliest === null || iso < earliest)) earliest = iso
  }
  return earliest ?? ''
}

/**
 * `cargoProviderName` / `shipmentCompanyId` → kanonik taşıyıcı anahtarı.
 *
 * Eşleşme kanıtlı değilse `null` döner; UYDURMA anahtar üretilmez.
 * `shipmentCompanyId` sayısal eşlemesi resmî tabloyla DOĞRULANMADIĞI için
 * burada sayıdan taşıyıcı TÜRETİLMEZ — yalnız ad kullanılır.
 */
export function mapN11Carrier(params: {
  cargoProviderName?: unknown
  shipmentCompanyId?: unknown
}): string | null {
  const token = str(params.cargoProviderName)
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, '')
  if (!token) return null
  if (token.includes('aras')) return 'aras'
  if (token.includes('yurtici') || token.includes('yurtiçi')) return 'yurtici'
  if (token.includes('mng')) return 'mng'
  if (token.includes('surat') || token.includes('sürat')) return 'surat'
  if (token.includes('ptt')) return 'ptt'
  if (token.includes('hepsijet')) return 'hepsijet'
  return null
}

/**
 * N11 statüsü → CargoFlow operasyon statüsü.
 *
 * HAM statü ASLA silinmez; bu eşleme yalnız TÜRETİLMİŞ bir görünümdür.
 * Bilinmeyen statü `null` döner ve ham değer korunur — sessizce "Yeni"ye
 * düşürmek, gerçekte iptal olmuş bir siparişi işleme sokabilirdi.
 */
export function mapN11StatusToOperation(status: unknown): string | null {
  const raw = str(status)
  if (!(N11_PACKAGE_STATUSES as readonly string[]).includes(raw)) return null
  const map: Record<N11PackageStatus, string> = {
    Created: 'NEW',
    Picking: 'PICKING',
    Shipped: 'SHIPPED',
    Delivered: 'DELIVERED',
    Cancelled: 'CANCELLED',
    Unpacked: 'CANCELLED',
    UnSupplied: 'CANCELLED',
  }
  return map[raw as N11PackageStatus] ?? null
}

export interface NormalizedN11Order {
  id: string
  marketplace: 'N11'
  externalOrderId: string
  orderNumber: string
  packageId: string
  marketplacePackageId: string
  /** Resmî: `cargoSenderNumber` = kargo TAKİP numarası. */
  marketplaceTrackingNumber: string
  /** Resmî: `cargoTrackingNumber` = BARKOD / kampanya kodu. */
  marketplaceBarcode: string
  marketplaceTrackingUrl: string
  marketplaceCarrier: string | null
  rawCarrierName: string
  shipmentCompanyId: string
  marketplaceStatus: string
  rawMarketplaceStatus: string
  operationStatus: string | null
  sellerId: string
  lastModifiedDate: string
  /** `packageHistories` Created kaydından; yoksa BOŞ (bkz. resolveN11OrderDate). */
  orderDate: string
  /** Resmî alan `customerfullName` (kurumsal faturada firma ünvanı). */
  customerName: string
  shipmentAddress: Record<string, unknown>
  billingAddress: Record<string, unknown>
  city: string
  district: string
  items: Array<Record<string, unknown>>
  packageHistories: Array<Record<string, unknown>>
  rawOrder: Record<string, unknown>
}

export function normalizeN11Order(
  raw: Record<string, unknown> = {},
): NormalizedN11Order {
  const packageId = str(raw.id)
  const orderNumber = str(raw.orderNumber)
  const shipmentAddress = (raw.shippingAddress ?? {}) as Record<string, unknown>
  const billingAddress = (raw.billingAddress ?? {}) as Record<string, unknown>
  // Resmî yanıt alanı `shipmentPackageStatus`tır (paket düzeyinde `status`
  // alanı yanıt sözlüğünde YOK; `status` yalnız İSTEK filtresidir).
  const rawStatus = str(raw.shipmentPackageStatus)
  const lines = Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]) : []
  const histories = Array.isArray(raw.packageHistories)
    ? (raw.packageHistories as Record<string, unknown>[])
    : []

  return {
    id: `n11_order_${packageId || orderNumber}`,
    marketplace: 'N11',
    externalOrderId: orderNumber || packageId,
    orderNumber,
    // Resmî: `id` PAKET kimliğidir.
    packageId,
    marketplacePackageId: packageId,
    // DİKKAT: bu iki satır BİLEREK "ters" görünür — resmî anlamlar böyledir.
    marketplaceTrackingNumber: str(raw.cargoSenderNumber),
    marketplaceBarcode: str(raw.cargoTrackingNumber),
    marketplaceTrackingUrl: str(raw.cargoTrackingLink),
    marketplaceCarrier: mapN11Carrier({
      cargoProviderName: raw.cargoProviderName,
      shipmentCompanyId: raw.shipmentCompanyId,
    }),
    rawCarrierName: str(raw.cargoProviderName),
    shipmentCompanyId: str(raw.shipmentCompanyId),
    marketplaceStatus: rawStatus,
    rawMarketplaceStatus: rawStatus,
    operationStatus: mapN11StatusToOperation(rawStatus),
    sellerId: str(raw.sellerId),
    lastModifiedDate: toIso(raw.lastModifiedDate),
    orderDate: resolveN11OrderDate(histories),
    customerName: str(raw.customerfullName),
    shipmentAddress,
    billingAddress,
    city: str(shipmentAddress.city),
    district: str(shipmentAddress.district ?? shipmentAddress.town),
    items: lines.map((line, index) => ({
      externalLineId:
        str(line.orderLineId) || `n11-line-${packageId || orderNumber}-${index}`,
      productName: str(line.productName ?? line.name) || 'Ürün',
      quantity: Math.max(0, Math.trunc(Number(line.quantity ?? 1)) || 0),
      // Resmî: `stockCode` = satıcı ürün kodu, satır `barcode` = ÜRÜN barkodu
      // (kargo barkodu DEĞİL — o paket düzeyinde `cargoTrackingNumber`dır).
      merchantSku: str(line.stockCode),
      productBarcode: str(line.barcode),
      variantAttributes: Array.isArray(line.variantAttributes) ? line.variantAttributes : null,
      lineStatus: str(line.orderItemLineItemStatusName),
      rawLine: line,
    })),
    packageHistories: histories.map((entry) => ({
      createdDate: toIso(entry.createdDate),
      status: str(entry.status),
      rawEntry: entry,
    })),
    rawOrder: raw,
  }
}

/**
 * Toplu normalizasyon — hiçbir ham kayıt SESSİZCE düşmez:
 *  · `duplicateRemovedCount` — aynı PAKET kimliğinin tekrarı; veri kaybı DEĞİL,
 *  · `invalidIdentityCount` — nesne olmayan girdi ya da ne paket (`id`) ne
 *    sipariş (`orderNumber`) kimliği taşıyan kayıt; veri EKSİKTİR.
 *
 * Tekilleştirme YALNIZ paket kimliğiyle yapılır. `id`si null kayıt (resmî:
 * "Konuma Özel Teslimat" siparişleri) sipariş numarasıyla tekilleştirilmez —
 * aynı siparişin iki ayrı paketi "tekrar" sanılıp gizlenmez; bu kayıtlar
 * paketsiz oldukları için kanonik yazımda AYRICA görünür.
 *
 * `seenPackageIds` verilirse sayfalar/statüler arası tekrarlar da sayılır.
 */
export function normalizeN11Orders(
  rawOrders: unknown,
  seenPackageIds: Set<string> = new Set(),
): { orders: NormalizedN11Order[]; duplicateRemovedCount: number; invalidIdentityCount: number } {
  const list = Array.isArray(rawOrders) ? (rawOrders as unknown[]) : []
  const orders: NormalizedN11Order[] = []
  let duplicateRemovedCount = 0
  let invalidIdentityCount = 0
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      invalidIdentityCount += 1
      continue
    }
    const normalized = normalizeN11Order(raw as Record<string, unknown>)
    if (!normalized.marketplacePackageId && !normalized.orderNumber) {
      invalidIdentityCount += 1
      continue
    }
    if (normalized.marketplacePackageId) {
      if (seenPackageIds.has(normalized.marketplacePackageId)) {
        duplicateRemovedCount += 1
        continue
      }
      seenPackageIds.add(normalized.marketplacePackageId)
    }
    orders.push(normalized)
  }
  return { orders, duplicateRemovedCount, invalidIdentityCount }
}

/**
 * Artımlı imleç için en güncel `lastModifiedDate`.
 *
 * P2 dersi: imleç YALNIZ tam başarılı koşuda ve pencerenin üst sınırına
 * ilerler. Burada üretilen değer bir ADAYDIR; ilerletme kararı P2'nin
 * `advanceCheckpoint` politikasına aittir.
 */
export function resolveN11CandidateCheckpointMs(
  orders: readonly NormalizedN11Order[],
): number | null {
  let latest: number | null = null
  for (const order of orders) {
    const parsed = Date.parse(order.lastModifiedDate)
    if (!Number.isFinite(parsed)) continue
    if (latest === null || parsed > latest) latest = parsed
  }
  return latest
}
