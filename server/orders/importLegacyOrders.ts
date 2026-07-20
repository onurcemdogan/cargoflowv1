// Tek seferlik, AÇIKÇA çağrılan legacy sipariş import'u: dışa aktarılmış
// localStorage sipariş JSON'u (cargoFlow_orders_v3:<sellerId>) → organization
// bazlı orders + order_lines. Server başlangıcında ÇALIŞMAZ. organizationId
// açık arg ile ZORUNLUDUR. Export dosyası DEĞİŞTİRİLMEZ/silinmez. Duplicate'ler
// unique(org, marketplace, packageId) ile güvenle atlanır (mevcut DB kaydı
// EZİLMEZ — operasyonel state korunur). PII/secret loglanmaz.
import { readFile } from 'node:fs/promises'
import { and, eq, inArray } from 'drizzle-orm'
import { orderLines, orders } from '../db/schema.ts'
import { toLineInsertValues, toOrderInsertValues } from './orderMapper.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface OrderImportSummary {
  read: number
  inserted: number
  skipped: number
  failed: number
  linesInserted: number
  dryRun: boolean
}

// Export dosyasından sipariş dizisini çözer. Kabul edilen biçimler:
//  - CargoOrder[] (ham dizi)
//  - { orders: CargoOrder[] }
//  - { "<sellerId>": CargoOrder[], ... } (localStorage scope haritası)
// sellerId verilirse yalnız o scope'un siparişleri alınır.
export function extractLegacyOrders(
  parsed: unknown,
  sellerId?: string,
): Record<string, unknown>[] {
  const isOrder = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object'

  if (Array.isArray(parsed)) {
    return parsed.filter(isOrder)
  }
  if (!isOrder(parsed)) return []

  if (Array.isArray((parsed as Record<string, unknown>).orders)) {
    return ((parsed as Record<string, unknown>).orders as unknown[]).filter(isOrder)
  }

  // Scope haritası: değerleri dizi olan anahtarlar.
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([, value]) => Array.isArray(value),
  )
  if (entries.length === 0) return []
  const selected = sellerId
    ? entries.filter(([key]) =>
        key.toLowerCase().includes(String(sellerId).toLowerCase()),
      )
    : entries
  const source = selected.length > 0 ? selected : sellerId ? [] : entries
  return source.flatMap(([, value]) => (value as unknown[]).filter(isOrder))
}

async function importOne(
  db: Db,
  organizationId: string,
  order: Record<string, unknown>,
  dryRun: boolean,
): Promise<{ outcome: 'inserted' | 'skipped' | 'failed'; lines: number }> {
  const packageId = String(order.packageId ?? order.shipmentPackageId ?? '').trim()
  if (!packageId) return { outcome: 'failed', lines: 0 }
  if (dryRun) {
    const lines = Array.isArray(order.items) ? order.items.length : 0
    return { outcome: 'inserted', lines }
  }
  try {
    const insertValues = toOrderInsertValues(organizationId, order)
    // Duplicate güvenli: mevcut DB kaydı EZİLMEZ (onConflictDoNothing).
    const inserted = await db
      .insert(orders)
      .values(insertValues)
      .onConflictDoNothing({
        target: [orders.organizationId, orders.marketplace, orders.packageId],
      })
      .returning({ id: orders.id })
    if (inserted.length === 0) return { outcome: 'skipped', lines: 0 }
    const lineValues = toLineInsertValues(
      organizationId,
      String(inserted[0].id),
      order,
    )
    let linesInserted = 0
    for (const line of lineValues) {
      const insertedLine = await db
        .insert(orderLines)
        .values(line)
        .onConflictDoNothing({
          target: [
            orderLines.organizationId,
            orderLines.orderId,
            orderLines.externalLineId,
          ],
        })
        .returning({ id: orderLines.id })
      if (insertedLine.length > 0) linesInserted += 1
    }
    return { outcome: 'inserted', lines: linesInserted }
  } catch {
    return { outcome: 'failed', lines: 0 }
  }
}

export async function importLegacyOrders(
  db: Db,
  organizationId: string,
  options: { dryRun?: boolean; storePath: string; sellerId?: string },
): Promise<OrderImportSummary> {
  const dryRun = options.dryRun !== false // varsayılan güvenli: dry-run
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(options.storePath, 'utf8'))
  } catch {
    return {
      read: 0,
      inserted: 0,
      skipped: 0,
      failed: 0,
      linesInserted: 0,
      dryRun,
    }
  }
  const records = extractLegacyOrders(parsed, options.sellerId)
  const summary: OrderImportSummary = {
    read: records.length,
    inserted: 0,
    skipped: 0,
    failed: 0,
    linesInserted: 0,
    dryRun,
  }
  for (const record of records) {
    const { outcome, lines } = await importOne(db, organizationId, record, dryRun)
    summary[outcome] += 1
    summary.linesInserted += lines
  }
  return summary
}

// Var olan DB kayıtlarını (org bazında) paket kimliğiyle döndürür — testlerin
// import öncesi/sonrası duplicate atlamayı doğrulaması için yardımcı.
export async function existingOrderPackageIds(
  db: Db,
  organizationId: string,
  packageIds: string[],
): Promise<Set<string>> {
  if (packageIds.length === 0) return new Set()
  const rows = await db
    .select({ packageId: orders.packageId })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        inArray(orders.packageId, packageIds),
      ),
    )
  return new Set(rows.map((row: { packageId: string }) => row.packageId))
}
