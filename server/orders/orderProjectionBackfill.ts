// PROJEKSİYON GERİ DOLDURMA — SINIRLI, DEVAM ETTİRİLEBİLİR, TENANT KAPSAMLI.
//
// `0008` uygulandıktan sonra mevcut siparişlerin projeksiyon satırlarını kurar.
// Normal çalışma zamanı yazıcıları (B1) DEĞİŞMEZ; bu yalnız tek seferlik/
// onarım amaçlı sınırlı bir işçidir.
//
// SÖZLEŞMELER
//   TENANT KAPSAMLI  — `organizationId` ZORUNLU; kazara tüm-tenant koşum yok.
//   SINIRLI          — parti parti çalışır; 10K sipariş tek diziye YÜKLENMEZ.
//   DEVAM EDEBİLİR   — imleç döndürür; yeniden başlatma güvenlidir.
//   IDEMPOTENT       — aynı koşum tekrar edilince yeni satır ÜRETMEZ.
//   BAYAT YAZMAZ     — araya giren canlı yazım EZİLMEZ (repository koruması).
//
// NORMALİZASYON YENİDEN YAZILMAZ: FROZEN üretici fonksiyonlar çağrılır.
//
// ŞİFRE ÇÖZME: eski gönderi/operasyon yükleri YALNIZ burada, parti sınırı
// içinde çözülür. Normal projeksiyon bakımında çözme YOKTUR.
import { and, asc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm'
import { orderFilterProjection, orders, shipmentOperations, shipments } from '../db/schema.ts'
import { decryptShipmentPayload } from '../shipments/shipmentEncryption.ts'
import {
  ORDER_FILTER_PROJECTION_VERSION,
  operationFragmentInput,
  shipmentFragmentInput,
} from './orderFilterProjectionBuilder.ts'
import { backfillProjectionRows } from './orderFilterProjectionRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const DEFAULT_BACKFILL_BATCH_SIZE = 500
export const MAX_BACKFILL_BATCH_SIZE = 2000

export interface BackfillOptions {
  organizationId: string
  batchSize?: number
  maxBatches?: number
  /** Bu kimlikten SONRAKİ siparişler (dışlayıcı). */
  cursor?: string
  /** Bu kimlik DAHİL sonrakiler (devam ederken kullanılır). */
  from?: string
  dryRun?: boolean
}

export interface BackfillSummary {
  organizationId: string
  scanned: number
  written: number
  skippedStale: number
  batches: number
  nextCursor: string | null
  done: boolean
  dryRun: boolean
}

export function resolveBatchSize(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BACKFILL_BATCH_SIZE
  return Math.min(Math.floor(parsed), MAX_BACKFILL_BATCH_SIZE)
}

const text = (value: unknown): string => String(value ?? '').trim()

/** Şifreli yükü GÜVENLİ çözer: bozuk/anahtarsız kayıt partiyi DÜŞÜRMEZ. */
function safeDecrypt(encrypted: unknown): Record<string, unknown> {
  const value = text(encrypted)
  if (!value) return {}
  try {
    const decrypted = decryptShipmentPayload(value)
    return decrypted && typeof decrypted === 'object'
      ? (decrypted as Record<string, unknown>)
      : {}
  } catch {
    // İlişkisel kolonlar yine kullanılır; tanımlayıcı UYDURULMAZ.
    return {}
  }
}

/**
 * DEVAM NOKTASI — projeksiyonu eksik/eski olan EN KÜÇÜK sipariş kimliği.
 *
 * Yarıda kalmış bir koşumdan sonra buradan (dahil) devam etmek hem eksik
 * satır bırakmaz hem de gereksiz baştan tarama yapmaz.
 */
export async function resolveResumeCursor(
  db: Db,
  organizationId: string,
): Promise<string | null> {
  const rows = (await db
    .select({ id: orders.id })
    .from(orders)
    .leftJoin(
      orderFilterProjection,
      and(
        eq(orderFilterProjection.organizationId, orders.organizationId),
        eq(orderFilterProjection.orderId, orders.id),
        eq(
          orderFilterProjection.projectionVersion,
          ORDER_FILTER_PROJECTION_VERSION,
        ),
      ),
    )
    .where(
      and(
        eq(orders.organizationId, organizationId),
        isNull(orderFilterProjection.orderId),
      ),
    )
    .orderBy(asc(orders.id))
    .limit(1)) as { id: string }[]
  return rows[0]?.id ? String(rows[0].id) : null
}

/**
 * Tek partilik iş: sipariş satırları + ilgili gönderi/operasyon kayıtları
 * SABİT sayıda sorgu ile çözülür (sipariş başına sorgu YOK).
 */
async function loadBatch(
  db: Db,
  organizationId: string,
  batchSize: number,
  cursor: string | null,
  inclusiveFrom: string | null,
) {
  const bounds = [eq(orders.organizationId, organizationId)]
  if (inclusiveFrom) bounds.push(gte(orders.id, inclusiveFrom))
  else if (cursor) bounds.push(gt(orders.id, cursor))

  const orderRows = (await db
    .select()
    .from(orders)
    .where(and(...bounds))
    .orderBy(asc(orders.id))
    .limit(batchSize)) as Record<string, unknown>[]
  if (orderRows.length === 0) return { orderRows, shipmentByKey: new Map(), operationByKey: new Map() }

  const packageIds = [
    ...new Set(orderRows.map((row) => text(row.packageId)).filter(Boolean)),
  ]
  const scope = and(
    eq(shipments.organizationId, organizationId),
    inArray(shipments.packageId, packageIds),
  )
  const shipmentRows = packageIds.length
    ? ((await db.select().from(shipments).where(scope)) as Record<string, unknown>[])
    : []
  const operationRows = packageIds.length
    ? ((await db
        .select()
        .from(shipmentOperations)
        .where(
          and(
            eq(shipmentOperations.organizationId, organizationId),
            inArray(shipmentOperations.packageId, packageIds),
          ),
        )) as Record<string, unknown>[])
    : []

  const key = (marketplace: unknown, packageId: unknown) =>
    `${text(marketplace)}::${text(packageId)}`
  const shipmentByKey = new Map<string, Record<string, unknown>>()
  for (const row of shipmentRows) {
    shipmentByKey.set(key(row.marketplace, row.packageId), row)
  }
  // Operasyonlarda EN GÜNCEL kayıt kazanır (aynı pakette birden çok deneme).
  const operationByKey = new Map<string, Record<string, unknown>>()
  for (const row of operationRows) {
    const k = key(row.marketplace, row.packageId)
    const current = operationByKey.get(k)
    const at = new Date(String(row.updatedAt ?? row.createdAt ?? 0)).getTime()
    const currentAt = current
      ? new Date(String(current.updatedAt ?? current.createdAt ?? 0)).getTime()
      : -1
    if (!current || at >= currentAt) operationByKey.set(k, row)
  }
  return { orderRows, shipmentByKey, operationByKey }
}

/** Sınırlı, devam ettirilebilir geri doldurma koşumu. */
export async function runProjectionBackfill(
  db: Db,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const organizationId = text(options.organizationId)
  if (!organizationId) {
    // TENANT KAPSAMI ZORUNLU: kazara tüm-tenant koşumu ENGELLE.
    throw new Error('BACKFILL_ORGANIZATION_REQUIRED')
  }
  const batchSize = resolveBatchSize(options.batchSize)
  const maxBatches =
    Number.isFinite(Number(options.maxBatches)) && Number(options.maxBatches) > 0
      ? Math.floor(Number(options.maxBatches))
      : Number.POSITIVE_INFINITY
  const dryRun = Boolean(options.dryRun)

  let cursor = text(options.cursor) || null
  let inclusiveFrom = text(options.from) || null
  let scanned = 0
  let written = 0
  let skippedStale = 0
  let batches = 0
  let done = false

  while (batches < maxBatches) {
    // ANLIK GÖRÜNTÜ ZAMANI — bayat yazma korumasının çapası.
    const snapshotAt = new Date()
    const { orderRows, shipmentByKey, operationByKey } = await loadBatch(
      db,
      organizationId,
      batchSize,
      cursor,
      inclusiveFrom,
    )
    inclusiveFrom = null
    if (orderRows.length === 0) {
      done = true
      break
    }

    const entries = orderRows.map((orderRow) => {
      const k = `${text(orderRow.marketplace)}::${text(orderRow.packageId)}`
      const shipmentRow = shipmentByKey.get(k)
      const operationRow = operationByKey.get(k)
      return {
        orderRow,
        shipment: shipmentRow
          ? shipmentFragmentInput(
              {
                trackingNumber: shipmentRow.trackingNumber,
                barcode: shipmentRow.barcode,
              },
              safeDecrypt(shipmentRow.carrierPayloadEncrypted),
            )
          : undefined,
        operation: operationRow
          ? operationFragmentInput(
              { trackingNumber: operationRow.trackingNumber },
              safeDecrypt(operationRow.responsePayloadEncrypted),
            )
          : undefined,
      }
    })

    if (!dryRun) {
      const result = await backfillProjectionRows(
        db,
        organizationId,
        entries,
        snapshotAt,
      )
      written += result.written
      skippedStale += result.skippedStale
    }
    scanned += orderRows.length
    batches += 1
    cursor = text(orderRows[orderRows.length - 1].id)
    if (orderRows.length < batchSize) {
      done = true
      break
    }
  }

  return {
    organizationId,
    scanned,
    written,
    skippedStale,
    batches,
    nextCursor: done ? null : cursor,
    done,
    dryRun,
  }
}

/** Kapsanmamış sipariş sayısı — koşum sonrası doğrulama için. */
export async function countUncoveredOrders(
  db: Db,
  organizationId: string,
): Promise<number> {
  const rows = (await db.execute(
    sql`select count(*)::int as n from orders o
        left join order_filter_projection p
          on p.organization_id = o.organization_id
         and p.order_id = o.id
         and p.projection_version = ${ORDER_FILTER_PROJECTION_VERSION}
        where o.organization_id = ${organizationId}
          and p.order_id is null`,
  )) as unknown
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) ?? []
  return Number((list[0] as { n?: unknown })?.n ?? 0)
}
