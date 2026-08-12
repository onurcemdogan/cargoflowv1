// Organization bazlı Sürat create idempotency kayıtları. Atomik create
// koruması unique(organization_id, idempotency_key) + INSERT ON CONFLICT
// üzerinden: eşzamanlı iki create'te yalnız biri rezervasyonu kazanır.
import { and, eq, inArray } from 'drizzle-orm'
import { shipmentOperations } from '../db/schema.ts'
import {
  decryptShipmentPayload,
  encryptShipmentPayload,
} from './shipmentEncryption.ts'

export type OperationStatus = 'pending' | 'succeeded' | 'failed' | 'blocked'

export interface OperationDb {
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => {
      onConflictDoNothing: () => { returning: () => Promise<Record<string, unknown>[]> }
      onConflictDoUpdate: (config: unknown) => Promise<unknown>
    }
  }
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => Promise<unknown>
    }
  }
  delete: (table: unknown) => { where: (condition: unknown) => Promise<unknown> }
  select: (fields?: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) => Promise<Record<string, unknown>[]>
    }
  }
}

export interface OperationColumns {
  organizationId: string
  marketplace: string
  packageId: string
  orderNumber?: string | null
  provider: string
  operationType: string
  idempotencyKey: string
  status: OperationStatus
  requestFingerprint?: string | null
  payload?: Record<string, unknown> | null
  trackingNumber?: string | null
  senderNumber?: string | null
  createCallCount?: number
  carrierCreateCalled?: boolean
  errorCode?: string | null
  errorMessage?: string | null
  completedAt?: Date | null
}

export async function findLatestOperationByPackage(
  db: OperationDb,
  organizationId: string,
  packageId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, organizationId),
        eq(shipmentOperations.packageId, packageId),
      ),
    )
  // Başarılı olanı tercih et; yoksa herhangi biri.
  const succeeded = rows.find((row) => String(row.status) === 'succeeded')
  return toRow(succeeded ?? rows[0] ?? null)
}

/**
 * TOPLU (BATCH) OPERASYON YÜKLEME — `findLatestOperationByPackage`in
 * N+1'siz eşdeğeri. SEÇİM KURALI BİREBİR AYNIDIR:
 *   pakete ait satırlar arasında `succeeded` olan TERCİH EDİLİR,
 *   yoksa ilk görülen satır kullanılır.
 *
 * Tek fark ÇAĞRI SAYISIDIR: sipariş başına bir sorgu yerine sayfa başına bir
 * sorgu. Kapsam (organizationId + packageId) aynen korunur.
 *
 * ŞİFRE ÇÖZME YALNIZ SEÇİLEN SATIR İÇİNDİR — tekil sürümdeki davranışın aynısı;
 * elenen operasyonların ZPL payload'ları çözülmez.
 */
export async function findLatestOperationsByPackageIds(
  db: OperationDb,
  organizationId: string,
  packageIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>()
  const unique = Array.from(new Set(packageIds.filter(Boolean)))
  if (unique.length === 0) return result
  const rows = await db
    .select()
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, organizationId),
        inArray(shipmentOperations.packageId, unique),
      ),
    )
  // Pakete göre grupla; tekil sürümdeki "başarılıyı öncele, yoksa ilkini al"
  // kuralını satır sırasını KORUYARAK uygula.
  const chosen = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const key = String(row.packageId)
    const current = chosen.get(key)
    if (!current) {
      chosen.set(key, row)
      continue
    }
    if (
      String(current.status) !== 'succeeded' &&
      String(row.status) === 'succeeded'
    ) {
      chosen.set(key, row)
    }
  }
  for (const [key, row] of chosen) {
    const mapped = toRow(row)
    if (mapped) result.set(key, mapped)
  }
  return result
}

// Kayıtlı (persisted) yazdırılabilir ham ZPL'i pakete ait TÜM operasyonları
// tarayarak çözer. `findLatestOperationByPackage` yalnız EN SON operasyonu
// döndürür; ham ZPL daha ESKİ bir create operasyonunda (technicalZpl) olabilir
// ve sonraki operasyon yalnız hash/length metadata taşıyabilir. Bu tarayıcı,
// başarılıyı önceleyerek non-empty technicalZpl (veya persisted shipment.
// barcodeRaw) taşıyan ilk operasyonun ZPL'ini getirir. Provider'a ÇIKMAZ,
// yeni kayıt oluşturmaz; yalnız decrypt eder.
export async function findPrintableZplByPackage(
  db: OperationDb,
  organizationId: string,
  packageId: string,
): Promise<{ zpl: string; source: string } | null> {
  if (!packageId) return null
  const rows = await db
    .select()
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, organizationId),
        eq(shipmentOperations.packageId, packageId),
      ),
    )
  // Başarılı operasyonları öncele; ardından diğerleri.
  const ordered = [
    ...rows.filter((row) => String(row.status) === 'succeeded'),
    ...rows.filter((row) => String(row.status) !== 'succeeded'),
  ]
  for (const row of ordered) {
    const payload = decryptShipmentPayload(
      row.responsePayloadEncrypted as string | null,
    ) as Record<string, unknown> | null
    if (!payload) continue
    const persisted =
      payload.shipment && typeof payload.shipment === 'object'
        ? (payload.shipment as Record<string, unknown>)
        : null
    const zpl = String(
      payload.technicalZpl ?? persisted?.barcodeRaw ?? '',
    ).trim()
    if (zpl) {
      return { zpl, source: 'operation.technicalZpl' }
    }
  }
  return null
}

function toRow(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null
  return {
    ...record,
    payload: decryptShipmentPayload(
      record.responsePayloadEncrypted as string | null,
    ),
  }
}

export async function findOperationByIdempotencyKey(
  db: OperationDb,
  organizationId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, organizationId),
        eq(shipmentOperations.idempotencyKey, idempotencyKey),
      ),
    )
  return toRow(rows[0] ?? null)
}

function toValues(columns: OperationColumns): Record<string, unknown> {
  return {
    organizationId: columns.organizationId,
    marketplace: columns.marketplace,
    packageId: columns.packageId,
    orderNumber: columns.orderNumber ?? null,
    provider: columns.provider,
    operationType: columns.operationType,
    idempotencyKey: columns.idempotencyKey,
    status: columns.status,
    requestFingerprint: columns.requestFingerprint ?? null,
    responsePayloadEncrypted: encryptShipmentPayload(columns.payload ?? null),
    trackingNumber: columns.trackingNumber ?? null,
    senderNumber: columns.senderNumber ?? null,
    createCallCount: columns.createCallCount ?? 0,
    carrierCreateCalled: columns.carrierCreateCalled ?? false,
    errorCode: columns.errorCode ?? null,
    errorMessage: columns.errorMessage ?? null,
    completedAt: columns.completedAt ?? null,
  }
}

// ATOMİK rezervasyon: INSERT ON CONFLICT DO NOTHING. Kazanan (won:true) tek
// request'tir; kaybeden mevcut kaydı görür. Eşzamanlı/çok-süreçli korumanın
// temel taşı.
export async function reserveCreateOperation(
  db: OperationDb,
  columns: OperationColumns,
): Promise<{ won: boolean; existing: Record<string, unknown> | null }> {
  const inserted = await db
    .insert(shipmentOperations)
    .values(toValues({ ...columns, status: columns.status ?? 'pending' }))
    .onConflictDoNothing()
    .returning()
  if (inserted.length > 0) {
    return { won: true, existing: toRow(inserted[0]) }
  }
  const existing = await findOperationByIdempotencyKey(
    db,
    columns.organizationId,
    columns.idempotencyKey,
  )
  return { won: false, existing }
}

// Var olan kaydı günceller (status geçişleri). Yoksa insert eder (upsert).
export async function upsertCreateOperation(
  db: OperationDb,
  columns: OperationColumns,
): Promise<void> {
  const values = toValues(columns)
  await db
    .insert(shipmentOperations)
    .values(values)
    .onConflictDoUpdate({
      target: [
        shipmentOperations.organizationId,
        shipmentOperations.idempotencyKey,
      ],
      set: {
        status: values.status,
        requestFingerprint: values.requestFingerprint,
        responsePayloadEncrypted: values.responsePayloadEncrypted,
        trackingNumber: values.trackingNumber,
        senderNumber: values.senderNumber,
        createCallCount: values.createCallCount,
        carrierCreateCalled: values.carrierCreateCalled,
        errorCode: values.errorCode,
        errorMessage: values.errorMessage,
        completedAt: values.completedAt,
        updatedAt: new Date(),
      },
    })
}

export async function deleteCreateOperation(
  db: OperationDb,
  organizationId: string,
  idempotencyKey: string,
): Promise<void> {
  await db
    .delete(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, organizationId),
        eq(shipmentOperations.idempotencyKey, idempotencyKey),
      ),
    )
}
