// SATIŞ DİSPOZİSYONU GERİ DOLDURMA — 0011 sonrası TEK SEFERLİK.
//
// ═══ NEDEN GEREKLİ ═══════════════════════════════════════════════════════
// `sales_disposition` kolonu 0011 ile eklendi ve YAZIM ANINDA dolar. Ama
// göçten ÖNCE yazılmış satırlarda NULL'dur ve toplama sorgusu NULL'u
// 'sale' sayar (eski davranışla aynı varsayılan).
//
// Bu, geri doldurulmazsa GEÇMİŞ iade/iptal siparişlerinin dashboard'da
// SATIŞ görünmesi demektir — para rakamı yanlış olur. Göçün hemen ardından
// bir kez çalıştırılır.
//
// ═══ GÜVENLİ ═════════════════════════════════════════════════════════════
//   • Yalnız `sales_disposition IS NULL` satırlara dokunur (idempotent).
//   • Sınıflandırma İSTEMCİYLE AYNI saf fonksiyondan gelir; ikinci bir
//     kural yazılmaz.
//   • Taşıyıcıya/pazaryerine ÇIKMAZ. Sipariş içeriği DEĞİŞMEZ, yalnız
//     türetilmiş sınıflandırma kolonu yazılır.
//   • --dry-run ile önce SAYIM yapılır.
import { and, eq, isNull, sql } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import { decryptOrderPayload } from './orderEncryption.ts'
import { orderDispositionOf } from '../../src/dashboard/dashboardSalesMetricDefinition.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const BACKFILL_BATCH = 500

export interface BackfillReport {
  scanned: number
  updated: number
  byDisposition: Record<string, number>
  dryRun: boolean
}

/**
 * NULL dispozisyonlu satırları sınıflandırır.
 *
 * Ham payload ŞİFRELİDİR ve `rawOrder.status` sinyali oradadır; bu yüzden
 * satır satır çözülür. Çözülemeyen payload sessizce yok sayılmaz —
 * `marketplace_status` tek başına sınıflandırmaya girer.
 */
export async function backfillSalesDisposition(
  db: Db,
  options: { dryRun?: boolean; limit?: number } = {},
): Promise<BackfillReport> {
  const dryRun = options.dryRun === true
  const byDisposition: Record<string, number> = {}
  let scanned = 0
  let updated = 0

  for (;;) {
    const rows = await db
      .select()
      .from(orders)
      .where(isNull(orders.salesDisposition))
      .limit(Math.min(BACKFILL_BATCH, Number(options.limit ?? BACKFILL_BATCH)))
    if (rows.length === 0) break

    for (const row of rows as Record<string, unknown>[]) {
      scanned += 1
      let rawOrder: unknown
      try {
        rawOrder = decryptOrderPayload(row.rawPayloadEncrypted as string | null)
      } catch {
        // Çözülemeyen payload: sinyal EKSİK sayılır, uydurulmaz.
        rawOrder = undefined
      }
      const disposition = orderDispositionOf({
        marketplaceStatus: row.marketplaceStatus,
        rawOrder: rawOrder ?? undefined,
      })
      byDisposition[disposition] = (byDisposition[disposition] ?? 0) + 1
      if (!dryRun) {
        await db
          .update(orders)
          .set({ salesDisposition: disposition })
          .where(eq(orders.id, row.id as string))
        updated += 1
      }
    }
    // Kuru koşuda döngü SONSUZA gitmesin: tek parti yeter.
    if (dryRun) break
    if (options.limit && scanned >= options.limit) break
  }

  return { scanned, updated, byDisposition, dryRun }
}

/** Geri doldurulacak satır sayısı — çalıştırmadan ÖNCE görülür. */
export async function countPendingBackfill(db: Db): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(isNull(orders.salesDisposition)))
  return Number(rows[0]?.total ?? 0)
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('backfillSalesDispositionCli.ts')
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run')
  const { getDb } = await import('../db/client.ts')
  const db = getDb()
  const pending = await countPendingBackfill(db)
  console.log(`[backfill] dispozisyonu bos satir: ${pending}`)
  const report = await backfillSalesDisposition(db, { dryRun })
  console.log(
    `[backfill] ${report.dryRun ? 'KURU KOSU' : 'UYGULANDI'} `
      + `tarandi=${report.scanned} guncellendi=${report.updated} `
      + `dagilim=${JSON.stringify(report.byDisposition)}`,
  )
  if (!report.dryRun) {
    console.log(`[backfill] kalan: ${await countPendingBackfill(db)}`)
  }
}
