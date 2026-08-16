// Organization bazlı shipment kayıtları. Tracking/sender/barcode açık
// kolonlarda (sorgu/UI); hassas carrier payload şifreli. db DI ile gelir.
import { and, eq, inArray } from 'drizzle-orm'
import { shipments } from '../db/schema.ts'
import { orders } from '../db/schema.ts'
import { updateShipmentProjectionFragment } from '../orders/orderFilterProjectionRepository.ts'
import { shipmentFragmentInput } from '../orders/orderFilterProjectionBuilder.ts'
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
 * TOPLU (BATCH) GÖNDERİ YÜKLEME — `findShipment`in N+1'siz eşdeğeri.
 *
 * ÜRETİM HATASI (ölçüldü): sipariş listesi her satır için AYRI `findShipment`
 * çalıştırıyordu (25 satırlık sayfada 25 sorgu, 100'lük sayfada 100). Bu
 * fonksiyon AYNI kanonik anahtarı — (organizationId, marketplace, packageId,
 * provider) — kullanır fakat paketleri TEK sorguda getirir.
 *
 * KAPSAM ASLA GEVŞEMEZ: organizasyon, pazaryeri ve sağlayıcı her zaman
 * eşitlikle sınırlanır; yalnız packageId çoklanır. Dönen Map'in anahtarı
 * packageId'dir ve sorgu zaten tek (org, marketplace, provider) kapsamında
 * olduğu için çakışma OLAMAZ (unique index bunu garanti eder).
 *
 * `carrierPayload` `findShipment` ile AYNI şekilde çözülür (aynı görünüm).
 */
export async function findShipmentsByPackageIds(
  db: RepositoryDb,
  organizationId: string,
  marketplace: string,
  packageIds: string[],
  provider: string,
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>()
  const unique = Array.from(new Set(packageIds.filter(Boolean)))
  if (unique.length === 0) return result
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
  for (const row of rows) {
    result.set(String(row.packageId), {
      ...row,
      carrierPayload: decryptShipmentPayload(
        row.carrierPayloadEncrypted as string | null,
      ),
    })
  }
  return result
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

  // PROJEKSİYON BAKIMI — SHIPMENT parçası.
  // `record.carrierPayload` çağıran tarafından ZATEN çözülmüş bellekteki
  // değerdir; burada YENİDEN DECRYPT YOK, ağ YOK, taşıyıcı çağrısı YOK.
  // Yalnız shipment-owned kolonlar SET edilir (ORDER/OPERATION korunur).
  const payload = (record.carrierPayload ?? {}) as Record<string, unknown>
  const owner = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, record.organizationId),
        eq(orders.marketplace, record.marketplace),
        eq(orders.packageId, record.packageId),
      ),
    )
  const orderId = owner[0]?.id ? String(owner[0].id) : ''
  if (orderId) {
    await updateShipmentProjectionFragment(
      db,
      record.organizationId,
      orderId,
      shipmentFragmentInput(record, payload),
    )
  }
}
