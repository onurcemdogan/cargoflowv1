// Auth modu shipment persistence adapter'ı. index.mjs'teki idempotency store
// üçlüsünü (read/write/delete) organization bazlı PostgreSQL'e bağlar. JSON
// record ŞEKLİ korunur (executeIdempotentSuratCreate değişmez); yalnız kaynak
// PG olur. Başarılı create'te shipment + operation TEK transaction'da yazılır.
import {
  deleteCreateOperation,
  findOperationByIdempotencyKey,
  reserveCreateOperation,
  upsertCreateOperation,
  type OperationColumns,
  type OperationDb,
} from './shipmentOperationRepository.ts'
import { upsertShipment, type RepositoryDb } from './shipmentRepository.ts'

type ServiceDb = OperationDb &
  RepositoryDb & {
    transaction: (fn: (tx: OperationDb & RepositoryDb) => Promise<void>) => Promise<void>
  }

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

// JSON idempotency record → operation kolonları. Record'un tamamı şifreli
// payload olarak saklanır; sorgu kolonları (status/tracking/sender/sayaç)
// ayrıca doldurulur.
function recordToColumns(
  organizationId: string,
  record: Record<string, unknown>,
): OperationColumns {
  const status = String(record.status ?? '')
  const opStatus =
    status === 'SUCCESS'
      ? 'succeeded'
      : status === 'FAILED_SAFE'
        ? 'failed'
        : 'pending'
  const shipment = (record.shipment ?? {}) as Record<string, unknown>
  return {
    organizationId,
    marketplace: first(record.marketplace, 'Trendyol'),
    packageId: first(record.packageId, shipment.packageId),
    orderNumber: first(record.orderNumber, record.orderId) || null,
    provider: first(record.provider, 'surat'),
    operationType: first(record.operation, 'CREATE'),
    idempotencyKey: String(record.idempotencyKey ?? ''),
    status: opStatus,
    requestFingerprint: (record.requestFingerprint as string) ?? null,
    payload: record,
    trackingNumber:
      first(record.carrierTrackingNumber, record.candidateTrackingNumber) || null,
    senderNumber:
      first(record.carrierSenderNumber, record.senderNumber, shipment.senderNumber) ||
      null,
    createCallCount: Number(record.createCallCount ?? 0),
    carrierCreateCalled: Boolean(
      record.carrierCreateCalled ?? record.completedAt,
    ),
    errorCode: first(record.errorCode, record.businessCode) || null,
    errorMessage: record.businessMessage
      ? String(record.businessMessage).slice(0, 600)
      : null,
    completedAt: record.completedAt ? new Date(String(record.completedAt)) : null,
  }
}

export async function readOperationRecord(
  db: OperationDb,
  organizationId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | undefined> {
  const row = await findOperationByIdempotencyKey(db, organizationId, idempotencyKey)
  if (!row) return undefined
  // Kaydın orijinal (JSON) şekli şifreli payload'dadır.
  const payload = row.payload as Record<string, unknown> | null
  return payload ?? undefined
}

// Başarılı create'te shipment + operation TEK transaction'da yazılır (M:
// yarıda hata → sahte shipment oluşmaz). Diğer durumlarda yalnız operation.
export async function writeOperationRecord(
  db: ServiceDb,
  organizationId: string,
  record: Record<string, unknown>,
): Promise<void> {
  const columns = recordToColumns(organizationId, record)
  if (columns.status === 'succeeded') {
    await db.transaction(async (tx) => {
      await upsertCreateOperation(tx, columns)
      await upsertShipment(tx, {
        organizationId,
        marketplace: columns.marketplace,
        packageId: columns.packageId,
        orderNumber: columns.orderNumber,
        provider: columns.provider,
        source: 'local_create',
        status: 'created',
        trackingNumber: columns.trackingNumber,
        senderNumber: columns.senderNumber,
        barcode:
          first(
            (record.shipment as Record<string, unknown> | undefined)?.barkodNo,
            (record.shipment as Record<string, unknown> | undefined)?.barcode,
            record.carrierBarcodeNumber,
          ) || null,
        trackingLink:
          first((record.shipment as Record<string, unknown> | undefined)?.trackingLink) ||
          null,
        carrierPayload: record,
      })
    })
    return
  }
  await upsertCreateOperation(db, columns)
}

export async function deleteOperationRecord(
  db: OperationDb,
  organizationId: string,
  idempotencyKey: string,
): Promise<void> {
  await deleteCreateOperation(db, organizationId, idempotencyKey)
}

// Atomik rezervasyon (JSON record ile): kazanan tek request. Kaybeden mevcut
// kaydın (payload) orijinal şeklini alır.
export async function reserveOperationRecord(
  db: OperationDb,
  organizationId: string,
  record: Record<string, unknown>,
): Promise<{ won: boolean; existing: Record<string, unknown> | null }> {
  const { won, existing } = await reserveCreateOperation(
    db,
    recordToColumns(organizationId, record),
  )
  const existingRecord =
    existing && (existing.payload as Record<string, unknown> | null)
  return { won, existing: existingRecord ?? null }
}

// Atomik rezervasyon proxy'si (eşzamanlı create koruması testleri için).
export { reserveCreateOperation }

// Harici (marketplace) shipment: operation ÜRETMEZ, salt okunur upsert.
// Yalnız KANITLI (sender_number veya Shipped statü) durumda çağrılmalı;
// ön-atanmış cargoTrackingNumber tek başına yeterli değildir (çağıran karar verir).
export async function upsertExternalShipment(
  db: RepositoryDb,
  input: {
    organizationId: string
    marketplace: string
    packageId: string
    orderNumber?: string | null
    provider: string
    status: string
    trackingNumber?: string | null
    senderNumber?: string | null
  },
): Promise<void> {
  await upsertShipment(db, {
    organizationId: input.organizationId,
    marketplace: input.marketplace,
    packageId: input.packageId,
    orderNumber: input.orderNumber ?? null,
    provider: input.provider,
    source: 'marketplace_external',
    status: input.status,
    trackingNumber: input.trackingNumber ?? null,
    senderNumber: input.senderNumber ?? null,
    carrierPayload: null,
  })
}
