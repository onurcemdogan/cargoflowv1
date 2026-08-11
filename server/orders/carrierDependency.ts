// ═══ TAŞIYICI BAĞIMLILIĞI — TEK KANONİK HESAP ════════════════════════════
//
// İki salt-okunur denetim farklı sonuç veriyordu (230 ≠ 35). Sebep, taşıyıcı
// sorgusunun İKİ FARKLI yerde ayrı ayrı yazılmış olmasıydı. Bu modül TEK
// kaynak olur; her iki denetim de buradan hesaplar.
//
// ═══ KANONİK DOĞAL ANAHTAR (VARSAYIM DEĞİL, KANIT) ════════════════════════
// `shipments` tekilliği (server/db/schema.ts):
//   uniqueIndex('shipments_org_marketplace_package_provider_unique')
//     (organization_id, marketplace, package_id, provider)
// Çalışma zamanı okuması (server/shipments/shipmentRepository.ts ·
// `findShipment`) AYNI dörtlüyü kullanır.
//
// `shipment_operations` için kanonik kapsam kodun tamamında
//   (organization_id, marketplace, package_id)
// üçlüsüdür (bkz. orderRetention.purgeOrderRecord ve suratTrackingReconciler).
//
// VARLIK sorusu için `provider` DAHİL EDİLMEZ: "bu paketin herhangi bir
// taşıyıcı kaydı var mı?" sorusu sağlayıcıdan bağımsızdır. Ancak organizasyon
// ve pazaryeri kapsamı ZORUNLUDUR — bunları düşürmek farklı organizasyon veya
// pazaryerindeki aynı `package_id` değerlerini yanlışlıkla eşleştirir.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { shipmentOperations, shipments } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface PackageKey {
  organizationId: string
  marketplace: string
  packageId: string
}

export interface CarrierDependency {
  shipments: number
  shipmentOperations: number
}

const keyOf = (key: PackageKey) =>
  `${key.organizationId}::${key.marketplace}::${key.packageId}`

/**
 * KANONİK sayım: (organizationId, marketplace, packageId) üçlüsü başına
 * gönderi ve taşıyıcı operasyonu sayıları. Tek sorguda toplanır.
 */
export async function loadCarrierDependencies(
  db: Db,
  keys: readonly PackageKey[],
): Promise<Map<string, CarrierDependency>> {
  const result = new Map<string, CarrierDependency>()
  if (keys.length === 0) return result
  for (const key of keys) {
    result.set(keyOf(key), { shipments: 0, shipmentOperations: 0 })
  }
  const packageIds = [...new Set(keys.map((key) => key.packageId))]

  const shipmentRows = (await db
    .select({
      organizationId: shipments.organizationId,
      marketplace: shipments.marketplace,
      packageId: shipments.packageId,
      total: sql<number>`count(*)`,
    })
    .from(shipments)
    .where(inArray(shipments.packageId, packageIds))
    .groupBy(
      shipments.organizationId,
      shipments.marketplace,
      shipments.packageId,
    )) as Record<string, any>[]
  for (const row of shipmentRows) {
    const entry = result.get(
      keyOf({
        organizationId: String(row.organizationId),
        marketplace: String(row.marketplace),
        packageId: String(row.packageId),
      }),
    )
    if (entry) entry.shipments = Number(row.total)
  }

  const operationRows = (await db
    .select({
      organizationId: shipmentOperations.organizationId,
      marketplace: shipmentOperations.marketplace,
      packageId: shipmentOperations.packageId,
      total: sql<number>`count(*)`,
    })
    .from(shipmentOperations)
    .where(inArray(shipmentOperations.packageId, packageIds))
    .groupBy(
      shipmentOperations.organizationId,
      shipmentOperations.marketplace,
      shipmentOperations.packageId,
    )) as Record<string, any>[]
  for (const row of operationRows) {
    const entry = result.get(
      keyOf({
        organizationId: String(row.organizationId),
        marketplace: String(row.marketplace),
        packageId: String(row.packageId),
      }),
    )
    if (entry) entry.shipmentOperations = Number(row.total)
  }
  return result
}

export function carrierKeyOf(key: PackageKey): string {
  return keyOf(key)
}

export function isCarrierDependent(value: CarrierDependency | undefined): boolean {
  if (!value) return false
  return value.shipments > 0 || value.shipmentOperations > 0
}

// ═══ ESKİ (TUTARSIZ) ALGORİTMALAR — YALNIZ MUTABAKAT İÇİN ═════════════════

/**
 * ESKİ-A (`duplicateCleanupEligibility` ilk sürümü): YALNIZ `package_id` ile
 * eşleştirir; organizasyon ve pazaryeri kapsamını DÜŞÜRÜR → FAZLA sayar.
 */
export async function legacyCountByPackageIdOnly(
  db: Db,
  packageIds: readonly string[],
): Promise<Map<string, CarrierDependency>> {
  const result = new Map<string, CarrierDependency>()
  if (packageIds.length === 0) return result
  const ids = [...new Set(packageIds)]
  for (const id of ids) result.set(id, { shipments: 0, shipmentOperations: 0 })
  const shipmentRows = (await db
    .select({ packageId: shipments.packageId, total: sql<number>`count(*)` })
    .from(shipments)
    .where(inArray(shipments.packageId, ids))
    .groupBy(shipments.packageId)) as Record<string, any>[]
  for (const row of shipmentRows) {
    const entry = result.get(String(row.packageId))
    if (entry) entry.shipments = Number(row.total)
  }
  const operationRows = (await db
    .select({
      packageId: shipmentOperations.packageId,
      total: sql<number>`count(*)`,
    })
    .from(shipmentOperations)
    .where(inArray(shipmentOperations.packageId, ids))
    .groupBy(shipmentOperations.packageId)) as Record<string, any>[]
  for (const row of operationRows) {
    const entry = result.get(String(row.packageId))
    if (entry) entry.shipmentOperations = Number(row.total)
  }
  return result
}

/**
 * ESKİ-B (`nullShadowAudit` ilk sürümü): organizasyon kimliğini TEK bir
 * satırdan (ilk NULL satır) türetir ve tüm gruplara uygular; çok
 * organizasyonlu veride veya boş kimlikte YANLIŞ daraltma yapar.
 */
export async function legacyCountWithFixedOrganization(
  db: Db,
  keys: readonly PackageKey[],
  fixedOrganizationId: string,
): Promise<Map<string, CarrierDependency>> {
  const result = new Map<string, CarrierDependency>()
  for (const key of keys) {
    const [shipmentRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(shipments)
      .where(
        and(
          eq(shipments.marketplace, key.marketplace),
          eq(shipments.packageId, key.packageId),
          fixedOrganizationId
            ? eq(shipments.organizationId, fixedOrganizationId)
            : sql`true`,
        ),
      )
    const [operationRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(shipmentOperations)
      .where(
        and(
          eq(shipmentOperations.marketplace, key.marketplace),
          eq(shipmentOperations.packageId, key.packageId),
          fixedOrganizationId
            ? eq(shipmentOperations.organizationId, fixedOrganizationId)
            : sql`true`,
        ),
      )
    result.set(keyOf(key), {
      shipments: Number(shipmentRow?.total ?? 0),
      shipmentOperations: Number(operationRow?.total ?? 0),
    })
  }
  return result
}
