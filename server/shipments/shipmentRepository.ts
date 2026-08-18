// Organization bazlı shipment kayıtları. Tracking/sender/barcode açık
// kolonlarda (sorgu/UI); hassas carrier payload şifreli. db DI ile gelir.
import { and, eq, inArray } from 'drizzle-orm'
import { shipments } from '../db/schema.ts'
import {
  decryptShipmentPayload,
  encryptShipmentPayload,
} from './shipmentEncryption.ts'

export type ShipmentSource =
  | 'local_create'
  | 'marketplace_external'
  | 'imported_legacy'

export interface ShipmentRecord {
  organizationId: string
  marketplace: string
  packageId: string
  orderNumber?: string | null
  provider: string
  source: ShipmentSource
  status: string
  trackingNumber?: string | null
  senderNumber?: string | null
  barcode?: string | null
  trackingLink?: string | null
  carrierPayload?: Record<string, unknown> | null
}

// Minimal yapısal db arayüzü (node-postgres/pglite drizzle).
export interface RepositoryDb {
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => {
      onConflictDoUpdate: (config: unknown) => Promise<unknown>
    }
  }
  select: (fields?: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) => Promise<Record<string, unknown>[]>
    }
  }
}

export async function findShipment(
  db: RepositoryDb,
  organizationId: string,
  marketplace: string,
  packageId: string,
  provider: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.marketplace, marketplace),
        eq(shipments.packageId, packageId),
        eq(shipments.provider, provider),
      ),
    )
  const row = rows[0]
  if (!row) return null
  return {
    ...row,
    carrierPayload: decryptShipmentPayload(
      row.carrierPayloadEncrypted as string | null,
    ),
  }
}

/**
 * TOPLU okuma: bir sipariş sayfasındaki TÜM paketlerin gönderileri TEK
 * sorguda gelir. `findShipment` ile aynı semantik — yalnız çağrı sayısı
 * satır sayısıyla ölçeklenmez (liste yolundaki N+1'i kaldırır).
 */
export async function findShipmentsForPackages(
  db: RepositoryDb,
  organizationId: string,
  marketplace: string,
  packageIds: string[],
  provider: string,
): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(packageIds.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.marketplace, marketplace),
        inArray(shipments.packageId, unique),
        eq(shipments.provider, provider),
      ),
    )
  const byPackage = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const key = String(row.packageId)
    // Tekil okuyucu ilk satırı alır; toplu okuyucu da İLKİNİ korur.
    if (byPackage.has(key)) continue
    byPackage.set(key, {
      ...row,
      carrierPayload: decryptShipmentPayload(
        row.carrierPayloadEncrypted as string | null,
      ),
    })
  }
  return byPackage
}

export async function upsertShipment(
  db: RepositoryDb,
  record: ShipmentRecord,
): Promise<void> {
  const values = {
    organizationId: record.organizationId,
    marketplace: record.marketplace,
    packageId: record.packageId,
    orderNumber: record.orderNumber ?? null,
    provider: record.provider,
    source: record.source,
    status: record.status,
    trackingNumber: record.trackingNumber ?? null,
    senderNumber: record.senderNumber ?? null,
    barcode: record.barcode ?? null,
    trackingLink: record.trackingLink ?? null,
    carrierPayloadEncrypted: encryptShipmentPayload(record.carrierPayload),
  }
  await db
    .insert(shipments)
    .values(values)
    .onConflictDoUpdate({
      target: [
        shipments.organizationId,
        shipments.marketplace,
        shipments.packageId,
        shipments.provider,
      ],
      set: {
        orderNumber: values.orderNumber,
        source: values.source,
        status: values.status,
        trackingNumber: values.trackingNumber,
        senderNumber: values.senderNumber,
        barcode: values.barcode,
        trackingLink: values.trackingLink,
        carrierPayloadEncrypted: values.carrierPayloadEncrypted,
        updatedAt: new Date(),
      },
    })
}
