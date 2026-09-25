// IKAS SİPARİŞ NORMALLEŞTİRİCİ — İÇ MODEL (kanonik canlı sipariş DEĞİL).
//
// Kaynak: providers/ikas/contracts/admin-v1.json (v2). Yalnız sözleşmede
// BELGELENMİŞ alanlar okunur; eksik alan UYDURULMAZ.
//
//   · Kimlik          : order.id (orderNumber insan-okunur referanstır)
//   · Satır / varyant : orderLineItems[].id / variant.id
//   · Statü           : ham değer KORUNUR; OrderStatusEnum değerleri
//                       belgelenmediği için kanonik statü `null` kalır
//   · Zaman           : Timestamp mutlak andır — ±3 saat DÜZELTMESİ YOK;
//                       bozuk değer ASLA Unix epoch'a çevrilmez
//   · Para            : Float → ondalık DİZGE; ikili aritmetik YAPILMAZ
//   · Adres           : city/district İÇ İÇE nesnenin `name` alanı; ilçe
//                       serbest metinden ÇIKARILMAZ; telefon yalnız adres
//                       veya müşteri `phone` alanından
//   · Paket           : orderPackages AYNEN taşınır; paket yoksa CargoFlow
//                       paket kimliği UYDURULMAZ (order.id paket DEĞİLDİR)

export interface IkasNormalizedLine {
  providerLineId: string
  variantId: string | null
  sku: string | null
  barcodes: string[]
  name: string | null
  quantity: string | null
  price: string | null
  finalPrice: string | null
  rawStatus: string | null
  options: { name: string; values: string[] }[]
}

export interface IkasNormalizedPackage {
  providerPackageId: string
  orderPackageNumber: string | null
  orderLineItemIds: string[]
  rawFulfillStatus: string | null
  trackingNumber: string | null
  cargoCompany: string | null
}

export interface IkasNormalizedOrder {
  providerOrderId: string
  orderNumber: string | null
  merchantId: string | null
  rawStatus: string | null
  /** Doğrulanmış eşleme YOK → daima `null` (TAHMİN EDİLMEZ). */
  canonicalStatus: null
  rawPackageStatus: string | null
  orderedAt: string | null
  orderedAtMalformed: boolean
  currencyCode: string | null
  totalFinalPrice: string | null
  customerName: string | null
  shipping: {
    recipientName: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    district: string | null
    postalCode: string | null
    phone: string | null
  }
  lines: IkasNormalizedLine[]
  packages: IkasNormalizedPackage[]
  /**
   * Paket kimliği durumu: sağlayıcı paketi yoksa CargoFlow paketi
   * OLUŞTURULMAZ (IKAS_PACKAGE_IDENTITY = NOT_FULLY_VERIFIED).
   */
  packageIdentity: 'PROVIDER_PACKAGES' | 'NO_PROVIDER_PACKAGE'
}

export interface IkasOrderRejection {
  providerOrderId: string | null
  reason: 'MISSING_ID' | 'MERCHANT_MISMATCH'
}

export interface IkasBatchNormalization {
  orders: IkasNormalizedOrder[]
  rejected: IkasOrderRejection[]
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Float → ondalık dizge. Sağlayıcının gönderdiği sayının EN KISA doğru
 * gösterimi kullanılır (ör. 99.95 → "99.95"); çarpma/bölme/toplama
 * YAPILMAZ. Üstel gösterim düz ondalığa açılır. Sayı değilse `null`.
 */
export function ikasDecimalString(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^-?\d+(\.\d+)?$/.test(value.trim()) ? value.trim() : null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const plain = String(value)
  if (!/e/i.test(plain)) return plain
  return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
}

/**
 * Timestamp → ISO anı.
 *
 * Sözleşme: "The javascript `Date` as integer" — UNIX epoch'tan beri
 * MİLİSANİYE. Yalnız pozitif TAM sayı (veya yalnız rakamdan oluşan dizge)
 * kabul edilir. Saat dilimi DÜZELTMESİ YAPILMAZ (mutlak an). Bozuk/eksik/
 * sıfır değer `null` döner — ASLA 1970'e düşmez.
 */
export function ikasTimestampToIso(value: unknown): string | null {
  let ms: number
  if (typeof value === 'number') {
    ms = value
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    ms = Number(value.trim())
  } else {
    return null
  }
  if (!Number.isSafeInteger(ms) || ms <= 0) return null
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function nestedName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  return text((value as { name?: unknown }).name)
}

function normalizeLine(raw: Record<string, unknown>): IkasNormalizedLine | null {
  const id = text(raw.id)
  if (!id) return null
  const variant = (raw.variant && typeof raw.variant === 'object' ? raw.variant : {}) as Record<
    string,
    unknown
  >
  const options = Array.isArray(raw.options) ? (raw.options as Record<string, unknown>[]) : []
  return {
    providerLineId: id,
    variantId: text(variant.id),
    sku: text(variant.sku),
    barcodes: Array.isArray(variant.barcodeList)
      ? (variant.barcodeList as unknown[]).map(text).filter((entry): entry is string => entry !== null)
      : [],
    name: text(variant.name),
    quantity: ikasDecimalString(raw.quantity),
    price: ikasDecimalString(raw.price),
    finalPrice: ikasDecimalString(raw.finalPrice),
    rawStatus: text(raw.status),
    options: options.map((option) => ({
      name: String(option?.name ?? ''),
      values: Array.isArray(option?.values)
        ? (option.values as Record<string, unknown>[])
            .map((entry) => text(entry?.value))
            .filter((entry): entry is string => entry !== null)
        : [],
    })),
  }
}

function normalizePackage(raw: Record<string, unknown>): IkasNormalizedPackage | null {
  const id = text(raw.id)
  if (!id) return null
  const tracking = (raw.trackingInfo && typeof raw.trackingInfo === 'object'
    ? raw.trackingInfo
    : {}) as Record<string, unknown>
  return {
    providerPackageId: id,
    orderPackageNumber: text(raw.orderPackageNumber),
    orderLineItemIds: Array.isArray(raw.orderLineItemIds)
      ? (raw.orderLineItemIds as unknown[]).map(text).filter((entry): entry is string => entry !== null)
      : [],
    rawFulfillStatus: text(raw.orderPackageFulfillStatus),
    trackingNumber: text(tracking.trackingNumber),
    cargoCompany: text(tracking.cargoCompany),
  }
}

export function normalizeIkasOrder(raw: Record<string, unknown>): IkasNormalizedOrder | null {
  const id = text(raw.id)
  if (!id) return null
  const address = (raw.shippingAddress && typeof raw.shippingAddress === 'object'
    ? raw.shippingAddress
    : {}) as Record<string, unknown>
  const customer = (raw.customer && typeof raw.customer === 'object' ? raw.customer : {}) as Record<
    string,
    unknown
  >
  const orderedAt = ikasTimestampToIso(raw.orderedAt)
  const packages = (Array.isArray(raw.orderPackages) ? (raw.orderPackages as Record<string, unknown>[]) : [])
    .map(normalizePackage)
    .filter((entry): entry is IkasNormalizedPackage => entry !== null)
  const recipient = [text(address.firstName), text(address.lastName)].filter(Boolean).join(' ')
  return {
    providerOrderId: id,
    orderNumber: text(raw.orderNumber),
    merchantId: text(raw.merchantId),
    rawStatus: text(raw.status),
    canonicalStatus: null,
    rawPackageStatus: text(raw.orderPackageStatus),
    orderedAt,
    orderedAtMalformed: raw.orderedAt !== null && raw.orderedAt !== undefined && orderedAt === null,
    currencyCode: text(raw.currencyCode),
    totalFinalPrice: ikasDecimalString(raw.totalFinalPrice),
    customerName:
      text(customer.fullName) ??
      ([text(customer.firstName), text(customer.lastName)].filter(Boolean).join(' ') || null),
    shipping: {
      recipientName: recipient === '' ? null : recipient,
      addressLine1: text(address.addressLine1),
      addressLine2: text(address.addressLine2),
      city: nestedName(address.city),
      district: nestedName(address.district),
      postalCode: text(address.postalCode),
      // Telefon: önce teslimat adresi, yoksa müşteri — başka alandan ÜRETİLMEZ.
      phone: text(address.phone) ?? text(customer.phone),
    },
    lines: (Array.isArray(raw.orderLineItems) ? (raw.orderLineItems as Record<string, unknown>[]) : [])
      .map(normalizeLine)
      .filter((entry): entry is IkasNormalizedLine => entry !== null),
    packages,
    packageIdentity: packages.length > 0 ? 'PROVIDER_PACKAGES' : 'NO_PROVIDER_PACKAGE',
  }
}

/**
 * Toplu normalleştirme — kararlı `order.id` ile TEKİLLEŞTİRİR ve bağlı
 * mağazanın `merchant.id`si ile çapraz doğrular (başka mağazanın siparişi
 * bu hesaba YAZILAMAZ).
 */
export function normalizeIkasOrders(
  rawOrders: Record<string, unknown>[],
  expectedMerchantId: string | null,
): IkasBatchNormalization {
  const seen = new Map<string, IkasNormalizedOrder>()
  const rejected: IkasOrderRejection[] = []
  for (const raw of rawOrders) {
    const normalized = normalizeIkasOrder(raw)
    if (!normalized) {
      rejected.push({ providerOrderId: null, reason: 'MISSING_ID' })
      continue
    }
    if (expectedMerchantId && normalized.merchantId && normalized.merchantId !== expectedMerchantId) {
      rejected.push({ providerOrderId: normalized.providerOrderId, reason: 'MERCHANT_MISMATCH' })
      continue
    }
    // Aynı kimlik tekrar gelirse SON görülen kazanır; kimlik TEK kalır.
    seen.set(normalized.providerOrderId, normalized)
  }
  return { orders: [...seen.values()], rejected }
}
