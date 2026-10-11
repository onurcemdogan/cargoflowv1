// TRENDYOL `order_date` KAYMASININ KAPSAM ANALİZİ — SALT OKUNUR.
//
// ═══ NEDEN BU ARAÇ VAR ═══════════════════════════════════════════════════
//
// Üretim örneklemi "yeni siparişlerde DRIFT=0" gösteriyor ve buradan
// "kusur tarihsel, artık olmuyor" sonucu çıkarılmak isteniyor. BU ÇIKARIM
// ÖRNEKLEMDEN YAPILAMAZ. Eski alım yolu şuydu:
//
//   toIsoDate(v) = typeof v === 'number' ? new Date(v).toISOString()
//                                        : new Date(v).toISOString()
//
// Bu fonksiyon ham değerin BİÇİMİNE göre FARKLI davranır:
//
//   SAYISAL epoch (sözleşmenin belgelediği biçim) → +3 saat KAYAR
//   AÇIK OFSETLİ dizgi ("...Z" / "...+03:00")     → HİÇ KAYMAZ
//
// Yani "kaymış" ve "zaten doğru" ayrımı TARİHTEN değil BİÇİMDEN doğmuş
// olabilir. İki hipotez GÖZLEMLE ayrışır:
//
//   H1 (tarihsel kesme): DRIFT=0 satırlar belirli bir TARİHTEN SONRA
//      yoğunlaşır ve biçimleri de sayısaldır.
//   H2 (biçim farkı): DRIFT=0 satırlar TARİHE YAYILMIŞTIR ve biçimleri
//      OFFSET_STRING'dir → kusur hâlâ CANLIDIR, yalnız düzeltme henüz
//      üretime çıkmamıştır.
//
// Bu yüzden kırılım hem TARİHE hem HAM BİÇİME göre verilir. Karar veriden
// çıkar, varsayımdan değil.
//
// YAZMA YOLU YOKTUR.
import { and, asc, eq, gt } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import {
  classifyOrderDateDrift,
  classifyRawOrderDateShape,
  type OrderDateDriftClassification,
  type TrendyolRawOrderDateShape,
} from './trendyolOrderDateDrift.ts'
import { readRawOrderDate, TRENDYOL_MARKETPLACE } from './trendyolOrderDateRepair.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface RangeBucket {
  total: number
  drifted: number
  correct: number
  rawMissing: number
  rawUnparseable: number
  ambiguous: number
}

function emptyBucket(): RangeBucket {
  return {
    total: 0,
    drifted: 0,
    correct: 0,
    rawMissing: 0,
    rawUnparseable: 0,
    ambiguous: 0,
  }
}

function tallyInto(bucket: RangeBucket, classification: OrderDateDriftClassification): void {
  bucket.total += 1
  if (classification === 'DRIFTED_BY_OFFSET') bucket.drifted += 1
  else if (classification === 'ALREADY_CORRECT') bucket.correct += 1
  else if (classification === 'RAW_UNAVAILABLE') bucket.rawMissing += 1
  else if (classification === 'RAW_UNPARSEABLE') bucket.rawUnparseable += 1
  else bucket.ambiguous += 1
}

/** Sınır satırı: kimlik + iki değer. PII YOK. */
export interface BoundaryRow {
  orderId: string
  organizationId: string
  packageId: string | null
  storedOrderDate: string | null
  correctedOrderDate: string | null
  rawShape: TrendyolRawOrderDateShape
}

export interface OrderDateRangeAuditResult {
  totals: RangeBucket
  byOrganization: Record<string, RangeBucket>
  byMonth: Record<string, RangeBucket>
  byCalendarDate: Record<string, RangeBucket>
  byMarketplace: Record<string, RangeBucket>
  /** KUSURUN EKSENİ: ham değerin biçimi. H1/H2 ayrımı burada görünür. */
  byRawShape: Record<string, RangeBucket>
  /** Kaymış satırların EN ESKİ ve EN YENİsi — örneklemden DEĞİL, tam taramadan. */
  earliestDrifted: BoundaryRow | null
  latestDrifted: BoundaryRow | null
  /** Zaten doğru satırların sınırları — "kesme tarihi" iddiasını sınar. */
  earliestCorrect: BoundaryRow | null
  latestCorrect: BoundaryRow | null
  scanned: number
  batches: number
  lastId: string | null
}

export interface OrderDateRangeAuditOptions {
  organizationId?: string | null
  batchSize?: number
  startAfterId?: string | null
  /** Tüm pazaryerleri taransın mı (varsayılan: yalnız Trendyol). */
  allMarketplaces?: boolean
}

function isoOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/**
 * TAM VERİ SETİ ÜZERİNDE kapsam analizi. Keyset sayfalama: satırlar belleğe
 * TOPLUCA alınmaz, yalnız sayaçlar ve dört sınır satırı tutulur.
 */
export async function auditTrendyolOrderDateRange(
  db: Db,
  options: OrderDateRangeAuditOptions = {},
): Promise<OrderDateRangeAuditResult> {
  const batchSize = Math.max(1, options.batchSize ?? 500)
  const result: OrderDateRangeAuditResult = {
    totals: emptyBucket(),
    byOrganization: {},
    byMonth: {},
    byCalendarDate: {},
    byMarketplace: {},
    byRawShape: {},
    earliestDrifted: null,
    latestDrifted: null,
    earliestCorrect: null,
    latestCorrect: null,
    scanned: 0,
    batches: 0,
    lastId: null,
  }
  let afterId: string | null = options.startAfterId ?? null

  for (;;) {
    const clauses = []
    if (!options.allMarketplaces) {
      clauses.push(eq(orders.marketplace, TRENDYOL_MARKETPLACE))
    }
    if (options.organizationId) {
      clauses.push(eq(orders.organizationId, options.organizationId))
    }
    if (afterId) clauses.push(gt(orders.id, afterId))

    const rows: Record<string, unknown>[] = await db
      .select({
        id: orders.id,
        organizationId: orders.organizationId,
        marketplace: orders.marketplace,
        packageId: orders.packageId,
        orderDate: orders.orderDate,
        rawPayloadEncrypted: orders.rawPayloadEncrypted,
      })
      .from(orders)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(asc(orders.id))
      .limit(batchSize)

    if (rows.length === 0) break
    result.batches += 1

    for (const row of rows) {
      afterId = String(row.id)
      let rawOrderDate: unknown
      try {
        rawOrderDate = readRawOrderDate((row.rawPayloadEncrypted as string | null) ?? null)
      } catch {
        rawOrderDate = null
      }
      const verdict = classifyOrderDateDrift({
        storedOrderDate: (row.orderDate as Date | null) ?? null,
        rawOrderDate,
      })
      const shape = classifyRawOrderDateShape(rawOrderDate)
      const storedIso = isoOf(row.orderDate)
      // KOVA ANAHTARI KAYITLI (KUSURLU) DEĞERDİR: "hangi günler etkilendi"
      // sorusu bugünkü veriye göre sorulur; düzeltilmiş güne göre değil.
      const day = storedIso ? storedIso.slice(0, 10) : 'UNKNOWN'
      const month = storedIso ? storedIso.slice(0, 7) : 'UNKNOWN'

      result.scanned += 1
      tallyInto(result.totals, verdict.classification)
      tallyInto(
        (result.byOrganization[String(row.organizationId)] ??= emptyBucket()),
        verdict.classification,
      )
      tallyInto((result.byMonth[month] ??= emptyBucket()), verdict.classification)
      tallyInto((result.byCalendarDate[day] ??= emptyBucket()), verdict.classification)
      tallyInto(
        (result.byMarketplace[String(row.marketplace)] ??= emptyBucket()),
        verdict.classification,
      )
      tallyInto((result.byRawShape[shape] ??= emptyBucket()), verdict.classification)

      const boundary: BoundaryRow = {
        orderId: String(row.id),
        organizationId: String(row.organizationId),
        packageId: row.packageId ? String(row.packageId) : null,
        storedOrderDate: storedIso,
        correctedOrderDate: verdict.correctedOrderDate,
        rawShape: shape,
      }
      const storedMs = storedIso ? Date.parse(storedIso) : Number.NaN
      if (Number.isFinite(storedMs)) {
        if (verdict.classification === 'DRIFTED_BY_OFFSET') {
          if (
            result.earliestDrifted === null ||
            storedMs < Date.parse(String(result.earliestDrifted.storedOrderDate))
          ) {
            result.earliestDrifted = boundary
          }
          if (
            result.latestDrifted === null ||
            storedMs > Date.parse(String(result.latestDrifted.storedOrderDate))
          ) {
            result.latestDrifted = boundary
          }
        } else if (verdict.classification === 'ALREADY_CORRECT') {
          if (
            result.earliestCorrect === null ||
            storedMs < Date.parse(String(result.earliestCorrect.storedOrderDate))
          ) {
            result.earliestCorrect = boundary
          }
          if (
            result.latestCorrect === null ||
            storedMs > Date.parse(String(result.latestCorrect.storedOrderDate))
          ) {
            result.latestCorrect = boundary
          }
        }
      }
    }

    if (rows.length < batchSize) break
  }

  result.lastId = afterId
  return result
}

/**
 * Gözlemden hipotez seçer — YORUM DEĞİL, ÖLÇÜM.
 *
 * `FORMAT_DEPENDENT`: doğru satırların TAMAMINA YAKINI sayısal OLMAYAN ham
 * biçimden geliyor → kusur hâlâ canlı, yalnız bazı kayıtlar ondan etkilenmiyor.
 * `HISTORICAL_CUTOFF`: kaymış satırların en yenisi, doğru satırların en
 * eskisinden ÖNCE → gerçek bir zaman kesmesi var.
 * `MIXED`: ikisi de net değil → tek başına örneklemle karar VERİLEMEZ.
 */
export function interpretRangeAudit(
  result: OrderDateRangeAuditResult,
): 'FORMAT_DEPENDENT' | 'HISTORICAL_CUTOFF' | 'MIXED' | 'NO_DRIFT' {
  if (result.totals.drifted === 0) return 'NO_DRIFT'
  const correctFromNumeric = result.byRawShape.EPOCH_MS?.correct ?? 0
  const correctTotal = result.totals.correct
  if (correctTotal > 0 && correctFromNumeric === 0) return 'FORMAT_DEPENDENT'
  const latestDriftedMs = Date.parse(String(result.latestDrifted?.storedOrderDate ?? ''))
  const earliestCorrectMs = Date.parse(String(result.earliestCorrect?.storedOrderDate ?? ''))
  if (
    Number.isFinite(latestDriftedMs) &&
    Number.isFinite(earliestCorrectMs) &&
    latestDriftedMs < earliestCorrectMs
  ) {
    return 'HISTORICAL_CUTOFF'
  }
  return 'MIXED'
}
