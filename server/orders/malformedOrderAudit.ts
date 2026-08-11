// ═══ BOZUK SİPARİŞ KİMLİĞİ TANI ÇEKİRDEĞİ — SALT OKUNUR ═══════════════════
//
// ÜRETİM BULGUSU: "Yeni Siparişler" ekranında sipariş numarası `0`, pazaryeri
// statüsü boş ("Bilinmeyen Durum") kayıtlar görüldü. Bu kayıtlar için etiket
// üretilmemeli.
//
// BU MODÜL YALNIZ TESPİT VE SINIFLANDIRMA YAPAR. Hiçbir yazma, temizlik veya
// engelleme kuralı YOKTUR — kök neden kanıtlanmadan üretim davranışı
// DEĞİŞMEZ. Kalıcı ham yükten (raw payload) YALNIZ alanların VARLIĞI ve TİPİ
// raporlanır; DEĞERLER (müşteri/adres/ürün) ASLA dışarı verilmez.

/** Sipariş kimliği olarak KABUL EDİLMEYEN yer tutucu değerler. */
const PLACEHOLDER_IDENTITIES = new Set(['', '0', 'null', 'undefined', 'NaN'])

/**
 * Bir kimlik alanı GERÇEK mi? `0`, boş metin ve `null`/`undefined` metinleri
 * kimlik SAYILMAZ.
 *
 * DİKKAT (kanıtlanmış kırılganlık): `normalizeTrendyolOrders` kimliği
 *   `String(item.orderNumber ?? item.id ?? …)`
 * ile üretir. `??` operatörü YALNIZ null/undefined'a düşer — sayısal `0`
 * geçerli kabul edilir ve `'0'` metnine dönüşür. Bu yüklem o durumu yakalar.
 */
export function isRealIdentity(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  return !PLACEHOLDER_IDENTITIES.has(String(value).trim())
}

export interface OrderIdentityRow {
  packageId?: unknown
  orderNumber?: unknown
  marketplace?: unknown
  marketplaceStatus?: unknown
  marketplaceAccountId?: unknown
}

export type IdentityDefect =
  | 'placeholder_order_number'
  | 'placeholder_package_id'
  | 'missing_marketplace_status'
  | 'missing_marketplace'
  | 'unscoped_marketplace_account'

/**
 * MİNİMUM KİMLİK SÖZLEŞMESİ (tanı amaçlı; henüz bir ENGEL DEĞİL):
 *   · gerçek packageId · gerçek orderNumber · marketplace
 * Bunlar olmadan kayıt hangi pazaryeri siparişine ait olduğunu SÖYLEYEMEZ.
 *
 * `marketplaceStatus` ve hesap kapsamı AYRI raporlanır: eksiklikleri kimlik
 * kaybı DEĞİL, ayrı sinyallerdir.
 */
export function findIdentityDefects(row: OrderIdentityRow): IdentityDefect[] {
  const defects: IdentityDefect[] = []
  if (!isRealIdentity(row.orderNumber)) defects.push('placeholder_order_number')
  if (!isRealIdentity(row.packageId)) defects.push('placeholder_package_id')
  if (!String(row.marketplace ?? '').trim()) defects.push('missing_marketplace')
  if (!String(row.marketplaceStatus ?? '').trim()) {
    defects.push('missing_marketplace_status')
  }
  if (row.marketplaceAccountId === null || row.marketplaceAccountId === undefined) {
    defects.push('unscoped_marketplace_account')
  }
  return defects
}

/** Kimlik açısından bozuk mu? (statü/kapsam sinyalleri TEK BAŞINA yetmez.) */
export function isMalformedIdentity(row: OrderIdentityRow): boolean {
  const defects = findIdentityDefects(row)
  return (
    defects.includes('placeholder_order_number') ||
    defects.includes('placeholder_package_id') ||
    defects.includes('missing_marketplace')
  )
}

// ═══ HAM YÜK ŞEKLİ (PII YOK) ══════════════════════════════════════════════

export interface FieldShape {
  present: boolean
  type: string
  /** Sayısal `0` mı? `??` zincirinin kimlik sandığı kritik durum. */
  isZero?: boolean
  empty?: boolean
  /** Diziler için yalnız uzunluk. */
  length?: number
}

function shapeOf(value: unknown): FieldShape {
  if (value === undefined) return { present: false, type: 'undefined' }
  if (value === null) return { present: false, type: 'null' }
  if (Array.isArray(value)) {
    return { present: true, type: 'array', length: value.length }
  }
  if (typeof value === 'number') {
    return { present: true, type: 'number', isZero: value === 0 }
  }
  if (typeof value === 'string') {
    return { present: true, type: 'string', empty: value.trim() === '' }
  }
  if (typeof value === 'object') return { present: true, type: 'object' }
  return { present: true, type: typeof value }
}

/**
 * Kalıcı ham Trendyol paketinin KİMLİK ŞEKLİ. Yalnız alan varlığı/tipi döner;
 * müşteri adı, adres, ürün adı, tutar gibi DEĞERLER ASLA dönmez.
 */
export function describeRawIdentityShape(
  raw: unknown,
): Record<string, FieldShape> | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  return {
    id: shapeOf(item.id),
    packageId: shapeOf(item.packageId),
    shipmentPackageId: shapeOf(item.shipmentPackageId),
    orderNumber: shapeOf(item.orderNumber),
    status: shapeOf(item.status),
    shipmentPackageStatus: shapeOf(item.shipmentPackageStatus),
    packageStatus: shapeOf(item.packageStatus),
    lastModifiedDate: shapeOf(item.lastModifiedDate),
    lines: shapeOf(item.lines),
    customerFirstName: shapeOf(item.customerFirstName),
    customerLastName: shapeOf(item.customerLastName),
    shipmentAddress: shapeOf(item.shipmentAddress),
    cargoTrackingNumber: shapeOf(item.cargoTrackingNumber),
  }
}

/**
 * `isTrendyolOrderPackage` (server/index.mjs) yüklemini AYNEN yeniden kurar:
 * bozuk kaydın normalize filtresinden NASIL geçtiğini göstermek için.
 * Kopya değil, kanıt: sözleşme testinde kaynakla karşılaştırılır.
 */
export function passesTrendyolPackagePredicate(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const item = raw as Record<string, unknown>
  const hasPackageIdentity = Boolean(
    item.orderNumber || item.packageId || item.shipmentPackageId || item.id,
  )
  const hasCustomerOrAddress = Boolean(
    item.customerFirstName ||
      item.customerLastName ||
      item.customerFullName ||
      item.shipmentAddress,
  )
  if (!hasPackageIdentity || !hasCustomerOrAddress) return false
  if (item.shipmentAddress || Array.isArray(item.lines)) return true
  return Boolean(
    item.customerFirstName || item.customerLastName || item.customerFullName,
  )
}

// ═══ YAZAR ATIFI (ATTRIBUTION) ════════════════════════════════════════════

export type WriterHint =
  | 'marketplace_sync_scoped'
  | 'marketplace_sync_unscoped_legacy'
  | 'non_sync_or_unknown'

/**
 * KAYIT HANGİ YAZAR İMZASINI TAŞIYOR?
 *
 * `orders` tablosuna marketplace statüsü YAZAN TEK yol upsert zinciridir
 * (toOrderInsertValues / marketplaceUpdateSet). Ayırt edici imza hesap
 * kapsamıdır:
 *   · hesap damgalı  → manuel "Şimdi Yenile", historical backfill veya
 *     hesap kapsamı düzeltmesinden SONRAKİ arka plan turu,
 *   · hesapsız (NULL) → hesap kapsamı düzeltmesinden ÖNCEKİ arka plan turu
 *     ya da legacy/import kaydı.
 * Bu bir İPUCUDUR; kesin atıf için `createdAt` ile deploy/scheduler zamanı
 * karşılaştırılmalıdır (rapor bu iki damgayı da verir).
 */
export function attributeWriter(row: {
  marketplaceAccountId?: unknown
  rawPayloadPresent: boolean
}): WriterHint {
  if (!row.rawPayloadPresent) return 'non_sync_or_unknown'
  return row.marketplaceAccountId
    ? 'marketplace_sync_scoped'
    : 'marketplace_sync_unscoped_legacy'
}
