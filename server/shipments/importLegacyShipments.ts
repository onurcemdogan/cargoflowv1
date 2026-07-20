// Tek seferlik, AÇIKÇA çağrılan legacy import: surat-create-operations.json →
// organization bazlı shipment_operations + shipments (source=imported_legacy).
// Server başlangıcında ÇALIŞMAZ. organizationId açık env/arg ile zorunludur.
// JSON dosyası DEĞİŞTİRİLMEZ/silinmez. Duplicate'ler unique constraint ile
// güvenle atlanır. Secret/tam payload loglanmaz.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { shipmentOperations } from '../db/schema.ts'
import { encryptShipmentPayload } from './shipmentEncryption.ts'
import { upsertShipment } from './shipmentRepository.ts'

export interface ImportSummary {
  read: number
  inserted: number
  skipped: number
  failed: number
  dryRun: boolean
}

interface ImportDb {
  select: (fields?: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) => Promise<Record<string, unknown>[]>
    }
  }
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
}

function legacyStorePath(): string {
  const dir =
    process.env.CARGOFLOW_CONFIG_DIR ||
    join(process.env.LOCALAPPDATA || homedir(), 'CargoFlow')
  return join(dir, 'surat-create-operations.json')
}

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

// Tek bir legacy operation record'unu import eder. dry-run'da DB'ye yazılmaz.
async function importOne(
  db: ImportDb,
  organizationId: string,
  record: Record<string, unknown>,
  dryRun: boolean,
): Promise<'inserted' | 'skipped' | 'failed'> {
  const idempotencyKey = first(record.idempotencyKey)
  if (!idempotencyKey) return 'failed'
  const shipment = (record.shipment ?? {}) as Record<string, unknown>
  const status = first(record.status)
  const opStatus =
    status === 'SUCCESS'
      ? 'succeeded'
      : status === 'FAILED_SAFE'
        ? 'failed'
        : 'pending'
  const trackingNumber =
    first(record.carrierTrackingNumber, record.candidateTrackingNumber) || null
  const senderNumber =
    first(record.carrierSenderNumber, shipment.senderNumber) || null
  const packageId = first(record.packageId, shipment.packageId)
  const marketplace = first(record.marketplace, 'Trendyol')
  const provider = first(record.provider, 'surat')
  if (dryRun) return 'inserted'
  try {
    // Duplicate güvenli atlama: onConflictDoNothing ile mevcut kayıt korunur.
    const existing = await db
      .insert(shipmentOperations)
      .values({
        organizationId,
        marketplace,
        packageId,
        orderNumber: first(record.orderNumber, record.orderId) || null,
        provider,
        operationType: first(record.operation, 'CREATE'),
        idempotencyKey,
        status: opStatus,
        requestFingerprint: (record.requestFingerprint as string) ?? null,
        responsePayloadEncrypted: encryptShipmentPayload({
          ...record,
          source: 'imported_legacy',
        }),
        trackingNumber,
        senderNumber,
        createCallCount: Number(record.createCallCount ?? 0),
        carrierCreateCalled: Boolean(record.carrierCreateCalled ?? record.completedAt),
        errorCode: first(record.errorCode, record.businessCode) || null,
        errorMessage: record.businessMessage
          ? String(record.businessMessage).slice(0, 600)
          : null,
        completedAt: record.completedAt ? new Date(String(record.completedAt)) : null,
      })
      .onConflictDoNothing()
      .returning()
    if (existing.length === 0) return 'skipped'
    if (opStatus === 'succeeded' && packageId) {
      await upsertShipment(db, {
        organizationId,
        marketplace,
        packageId,
        orderNumber: first(record.orderNumber, record.orderId) || null,
        provider,
        source: 'imported_legacy',
        status: 'created',
        trackingNumber,
        senderNumber,
        barcode: first(shipment.barkodNo, shipment.barcode, record.carrierBarcodeNumber) || null,
        trackingLink: first(shipment.trackingLink) || null,
        carrierPayload: record,
      })
    }
    return 'inserted'
  } catch {
    return 'failed'
  }
}

export async function importLegacyShipments(
  db: ImportDb,
  organizationId: string,
  options: { dryRun?: boolean; storePath?: string } = {},
): Promise<ImportSummary> {
  const dryRun = options.dryRun !== false // varsayılan güvenli: dry-run
  const path = options.storePath ?? legacyStorePath()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return { read: 0, inserted: 0, skipped: 0, failed: 0, dryRun }
  }
  const operations = (parsed?.operations ?? {}) as Record<string, unknown>
  const records = Object.values(operations).filter(
    (value) => value && typeof value === 'object',
  ) as Record<string, unknown>[]
  const summary: ImportSummary = {
    read: records.length,
    inserted: 0,
    skipped: 0,
    failed: 0,
    dryRun,
  }
  for (const record of records) {
    const outcome = await importOne(db, organizationId, record, dryRun)
    summary[outcome] += 1
  }
  return summary
}
