// CLI: TRENDYOL `orderDate` SAAT DİLİMİ KAYMASI TANISI — TAMAMEN SALT OKUNUR.
//
//   npm run orders:orderdate:drift
//   npm run orders:orderdate:drift -- --limit 500 --org <uuid> --sample 10
//
// YAPAR : `orders` OKUR, kalıcı ham Trendyol yükünden ORİJİNAL numerik
//         `orderDate` değerini çözer, düzeltilmiş kanonik anı HESAPLAR ve
//         kayıtlı değerle arasındaki FARKI raporlar.
// YAPMAZ: DB update/insert/delete · onarım · sipariş senkronu · Trendyol
//         çağrısı · Sürat çağrısı · etiket üretimi.
//
// ═══ NEDEN YALNIZ KURU ÇALIŞMA ═══════════════════════════════════════════
//
// TRENDYOL-ORDERDATE-TZ-001 yeni alımı düzeltir; MEVCUT satırlar düzeltilene
// kadar 3 saat ileri kalır. Bu araç, onarımın KAPSAMINI ve GÜVENLİĞİNİ
// görünür kılar. YAZMA MODU YOKTUR — bilinçli olarak eklenmemiştir: geçmiş
// finansal/operasyonel kayıtların toplu güncellenmesi AYRI ve AÇIK bir karar
// olmalıdır, tanı aracının yan etkisi DEĞİL.
//
// PII YOK: müşteri adı/adres/telefon ve tutar ASLA yazdırılmaz.
import { and, eq } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { orders } from '../db/schema.ts'
import { decryptOrderPayload } from './orderEncryption.ts'
import { TRENDYOL_ORDER_DATE_OFFSET_MINUTES } from '../marketplaces/trendyolOrderDate.ts'
import {
  classifyOrderDateDrift,
  type OrderDateDriftClassification,
} from './trendyolOrderDateDrift.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

/** Ham yükten YALNIZ `orderDate` alanını okur; başka alan OKUNMAZ. */
function readRawOrderDate(encrypted: string | null): unknown {
  const raw = decryptOrderPayload(encrypted) as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object') return null
  return (raw as { orderDate?: unknown }).orderDate ?? null
}

export interface OrderDateDriftRow {
  organizationId: string
  marketplace: string
  packageId: string | null
  orderNumber: string | null
  storedOrderDate: string | null
  rawOrderDate: unknown
  correctedOrderDate: string | null
  driftMinutes: number | null
  classification: OrderDateDriftClassification
}

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }
  const limit = positiveInt(parseArg('limit'), 500)
  const sampleSize = positiveInt(parseArg('sample'), 5)
  const organizationId = parseArg('org')

  const db = getDb()
  // KİRACI İZOLASYONU: org verilirse YALNIZ o organizasyon okunur.
  // PAZARYERİ FİLTRESİ: sözleşme Trendyol'a özeldir; başka pazaryeri
  // satırları bu tanıya HİÇ girmez.
  const where = organizationId
    ? and(eq(orders.marketplace, 'Trendyol'), eq(orders.organizationId, organizationId))
    : eq(orders.marketplace, 'Trendyol')

  const rows = await db
    .select({
      organizationId: orders.organizationId,
      marketplace: orders.marketplace,
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
      orderDate: orders.orderDate,
      rawPayloadEncrypted: orders.rawPayloadEncrypted,
    })
    .from(orders)
    .where(where)
    .limit(limit)

  const tally: Record<OrderDateDriftClassification, number> = {
    DRIFTED_BY_OFFSET: 0,
    ALREADY_CORRECT: 0,
    RAW_UNAVAILABLE: 0,
    RAW_UNPARSEABLE: 0,
  }
  const samples: OrderDateDriftRow[] = []

  for (const row of rows) {
    let rawOrderDate: unknown
    try {
      rawOrderDate = readRawOrderDate(row.rawPayloadEncrypted as string | null)
    } catch {
      rawOrderDate = null
    }
    const verdict = classifyOrderDateDrift({
      storedOrderDate: row.orderDate as Date | null,
      rawOrderDate,
    })
    tally[verdict.classification] += 1
    if (samples.length < sampleSize) {
      samples.push({
        organizationId: String(row.organizationId),
        marketplace: String(row.marketplace),
        packageId: row.packageId ? String(row.packageId) : null,
        orderNumber: row.orderNumber ? String(row.orderNumber) : null,
        storedOrderDate: (row.orderDate as Date | null)?.toISOString() ?? null,
        rawOrderDate,
        ...verdict,
      })
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: 'DRY_RUN_READ_ONLY',
        mutation: 'NONE',
        marketplace: 'Trendyol',
        organizationId: organizationId ?? '(tümü)',
        inspected: rows.length,
        limit,
        expectedDriftMinutes: TRENDYOL_ORDER_DATE_OFFSET_MINUTES,
        tally,
        samples,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => closePool())
