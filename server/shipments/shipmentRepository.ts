// Organization bazlı shipment kayıtları. Tracking/sender/barcode açık
// kolonlarda (sorgu/UI); hassas carrier payload şifreli. db DI ile gelir.
import { and, eq } from 'drizzle-orm'
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
