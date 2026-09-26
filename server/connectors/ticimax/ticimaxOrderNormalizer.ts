// TICIMAX SİPARİŞ NORMALLEŞTİRME — PAKETTEKİ BİLİNEN ALANLAR.
//
// Kaynak: providers/ticimax/contracts/siparisservis-v1.json ORDER_MODEL.
// Bilinmeyen statü HAM kalır (kanonik eşleme YOK). Bozuk tarih epoch'a
// düşmez. Para ondalık DİZGİ olarak korunur.
import { ticimaxOrderExternalId } from './ticimaxIdentity.ts'

export const TICIMAX_KNOWN_ORDER_FIELDS = [
  'SiparisID',
  'SiparisNo',
  'SiparisKodu',
  'SiparisDurumu',
  'OdemeTipi',
  'UyeID',
  'KargoTakipNo',
  'AliciAdi',
] as const

export const TICIMAX_NORMALIZATION_REJECTIONS = ['MISSING_SIPARIS_ID'] as const
export type TicimaxNormalizationRejection =
  (typeof TICIMAX_NORMALIZATION_REJECTIONS)[number]

export interface TicimaxNormalizedOrder {
  marketplace: 'Ticimax'
  /** Kararlı dış kimlik = SiparisID. */
  externalOrderId: string
  orderNumber: string | null
  orderCode: string | null
  rawStatus: string | null
  /** Doğrulanmış eşleme YOK → daima null. */
  canonicalStatus: null
  paymentType: string | null
  memberId: string | null
  trackingNumber: string | null
  customerName: string | null
  /** ISO an veya null — bozuk/eksik ASLA epoch-zero. */
  orderDate: string | null
  orderDateMalformed: boolean
  /** Ondalık dizgi — Number() ile yuvarlanmaz. */
  totalDecimal: string | null
  currency: string | null
  rawOrder: Record<string, unknown>
}

export interface TicimaxNormalizationSuccess {
  ok: true
  order: TicimaxNormalizedOrder
}
export interface TicimaxNormalizationFailure {
  ok: false
  rejection: TicimaxNormalizationRejection
  externalOrderId: string | null
}
export type TicimaxNormalizationResult =
  | TicimaxNormalizationSuccess
  | TicimaxNormalizationFailure

export interface TicimaxBatchNormalization {
  orders: TicimaxNormalizedOrder[]
  rejected: TicimaxNormalizationFailure[]
  duplicateRemovedCount: number
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/** Para: ondalık dizgi korunur; ikili aritmetik yok. */
export function ticimaxDecimalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed
    return trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const plain = String(value)
    if (!/e/i.test(plain)) return plain
    return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
  }
  return null
}

/**
 * Tarih → ISO. Bozuk / boş / epoch-zero ADAYLARI null (sessiz 1970 YOK).
 *
 * Saat dilimi pakette doğrulanmadı → ofset eklenmez; parse edilebilen
 * mutlak anlar ISO'ya çevrilir, aksi halde malformed bayrağı.
 */
export function ticimaxDateToInstant(value: unknown): {
  instant: string | null
  malformed: boolean
} {
  if (value === null || value === undefined) return { instant: null, malformed: false }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return { instant: null, malformed: value === 0 || value < 0 }
    }
    const date = new Date(value)
    if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) {
      return { instant: null, malformed: true }
    }
    return { instant: date.toISOString(), malformed: false }
  }
  const textValue = String(value).trim()
  if (textValue === '') return { instant: null, malformed: false }
  // Açık epoch / sıfır tarih kalıpları — UYDURULMAZ.
  if (
    textValue === '0' ||
    textValue === '0001-01-01' ||
    textValue.startsWith('0001-01-01') ||
    textValue.startsWith('1970-01-01T00:00:00')
  ) {
    return { instant: null, malformed: true }
  }
  const ms = Date.parse(textValue)
  if (!Number.isFinite(ms) || ms <= 0) return { instant: null, malformed: true }
  return { instant: new Date(ms).toISOString(), malformed: false }
}

export function normalizeTicimaxOrder(rawOrder: unknown): TicimaxNormalizationResult {
  const record = (rawOrder ?? {}) as Record<string, unknown>
  const externalOrderId = ticimaxOrderExternalId(record)
  if (!externalOrderId) {
    return { ok: false, rejection: 'MISSING_SIPARIS_ID', externalOrderId: null }
  }

  const dateField =
    record.SiparisTarihi ?? record.OrderDate ?? record.CreatedAt ?? record.Tarih ?? null
  const { instant, malformed } = ticimaxDateToInstant(dateField)

  const totalField =
    record.ToplamTutar ?? record.SiparisToplam ?? record.Total ?? record.Tutar ?? null

  return {
    ok: true,
    order: {
      marketplace: 'Ticimax',
      externalOrderId,
      orderNumber: text(record.SiparisNo),
      orderCode: text(record.SiparisKodu),
      rawStatus: text(record.SiparisDurumu),
      canonicalStatus: null,
      paymentType: text(record.OdemeTipi),
      memberId: text(record.UyeID),
      trackingNumber: text(record.KargoTakipNo),
      customerName: text(record.AliciAdi),
      orderDate: instant,
      orderDateMalformed: malformed,
      totalDecimal: ticimaxDecimalString(totalField),
      currency: text(record.ParaBirimi) ?? text(record.Currency),
      rawOrder: record,
    },
  }
}

export function normalizeTicimaxOrders(rawOrders: unknown): TicimaxBatchNormalization {
  const list = Array.isArray(rawOrders) ? rawOrders : []
  const byId = new Map<string, TicimaxNormalizedOrder>()
  const rejected: TicimaxNormalizationFailure[] = []
  let duplicateRemovedCount = 0

  for (const raw of list) {
    const result = normalizeTicimaxOrder(raw)
    if (!result.ok) {
      rejected.push(result)
      continue
    }
    if (byId.has(result.order.externalOrderId)) {
      duplicateRemovedCount += 1
      byId.set(result.order.externalOrderId, result.order)
      continue
    }
    byId.set(result.order.externalOrderId, result.order)
  }

  return {
    orders: [...byId.values()],
    rejected,
    duplicateRemovedCount,
  }
}
