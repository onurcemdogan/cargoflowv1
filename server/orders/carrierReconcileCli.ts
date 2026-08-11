// CLI: TAŞIYICI SAYIM MUTABAKATI — TAMAMEN SALT OKUNUR.
//
//   npm run orders:carrier-reconcile:check
//   npm run orders:carrier-reconcile:check -- --org <uuid>
//
// AMAÇ: iki denetimin (duplicates:check ve null-shadow:audit) taşıyıcı
// sayımları arasındaki farkı AYNI anlık görüntüde ölçmek. Üç algoritma da
// aynı NULL-gölge paket kümesi üzerinde çalıştırılır:
//   canonical                     → (organizationId, marketplace, packageId)
//   legacy_package_id_only        → yalnız package_id (eski duplicates:check)
//   legacy_fixed_organization     → sabit org + marketplace (eski null-shadow)
//
// YAPMAZ: DB update/insert/delete/archive · temizlik · migration · runtime
// davranış değişikliği · Trendyol/taşıyıcı çağrısı.
import { and, eq, isNull, sql } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { orders } from '../db/schema.ts'
import {
  carrierKeyOf,
  isCarrierDependent,
  legacyCountByPackageIdOnly,
  legacyCountWithFixedOrganization,
  loadCarrierDependencies,
  type PackageKey,
} from './carrierDependency.ts'

interface ShadowCandidateRow {
  organizationId: string
  marketplace: string
  packageId: string
  marketplaceAccountId: string | null
}

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }
  const organizationId = parseArg('org') ?? null
  const db = getDb()
  const orgScope = organizationId
    ? eq(orders.organizationId, organizationId)
    : sql`true`

  // NULL gölge paketleri: aynı (org, marketplace, package) altında hem NULL
  // hem hesaplı satır bulunanlar.
  const rows = (await db
    .select({
      organizationId: orders.organizationId,
      marketplace: orders.marketplace,
      packageId: orders.packageId,
      marketplaceAccountId: orders.marketplaceAccountId,
    })
    .from(orders)
    .where(orgScope)) as ShadowCandidateRow[]

  const byKey = new Map<string, ShadowCandidateRow[]>()
  for (const row of rows) {
    const key = `${row.organizationId}::${row.marketplace}::${row.packageId}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(row)
  }
  const shadowKeys: PackageKey[] = []
  for (const [, group] of byKey) {
    const hasNull = group.some((row) => row.marketplaceAccountId == null)
    const hasScoped = group.some((row) => row.marketplaceAccountId != null)
    if (hasNull && hasScoped) {
      shadowKeys.push({
        organizationId: String(group[0].organizationId),
        marketplace: String(group[0].marketplace),
        packageId: String(group[0].packageId),
      })
    }
  }

  // ── ÜÇ ALGORİTMA, AYNI KÜME ──────────────────────────────────────────────
  const canonical = await loadCarrierDependencies(db, shadowKeys)
  const legacyByPackage = await legacyCountByPackageIdOnly(
    db,
    shadowKeys.map((key) => key.packageId),
  )
  const [firstNullRow] = (await db
    .select({ organizationId: orders.organizationId })
    .from(orders)
    .where(and(orgScope, isNull(orders.marketplaceAccountId)))
    .limit(1)) as { organizationId: string }[]
  const legacyFixedOrg = await legacyCountWithFixedOrganization(
    db,
    shadowKeys,
    firstNullRow?.organizationId ?? '',
  )

  const canonicalDependent = shadowKeys.filter((key) =>
    isCarrierDependent(canonical.get(carrierKeyOf(key))),
  )
  const legacyPackageDependent = shadowKeys.filter((key) =>
    isCarrierDependent(legacyByPackage.get(key.packageId)),
  )
  const legacyFixedDependent = shadowKeys.filter((key) =>
    isCarrierDependent(legacyFixedOrg.get(carrierKeyOf(key))),
  )

  const withShipment = shadowKeys.filter(
    (key) => (canonical.get(carrierKeyOf(key))?.shipments ?? 0) > 0,
  ).length
  const withOperation = shadowKeys.filter(
    (key) => (canonical.get(carrierKeyOf(key))?.shipmentOperations ?? 0) > 0,
  ).length

  // FARKIN KAYNAĞI: hangi paketler yalnız bir algoritmada bağımlı çıkıyor?
  const canonicalSet = new Set(canonicalDependent.map(carrierKeyOf))
  const onlyLegacyPackage = legacyPackageDependent
    .filter((key) => !canonicalSet.has(carrierKeyOf(key)))
    .slice(0, 10)
    .map((key) => ({ packageId: key.packageId, marketplace: key.marketplace }))
  const legacyFixedSet = new Set(legacyFixedDependent.map(carrierKeyOf))
  const onlyCanonical = canonicalDependent
    .filter((key) => !legacyFixedSet.has(carrierKeyOf(key)))
    .slice(0, 10)
    .map((key) => ({ packageId: key.packageId, marketplace: key.marketplace }))

  console.log(
    JSON.stringify(
      {
        mode: 'read_only',
        canonicalKey: '(organization_id, marketplace, package_id)',
        canonicalKeyEvidence:
          'shipments_org_marketplace_package_provider_unique + findShipment() ' +
          'aynı dörtlüyü kullanır; varlık sorusunda provider ayrımı YAPILMAZ',
        nullShadowPackages: shadowKeys.length,
        packagesWithShipment: withShipment,
        packagesWithShipmentOperation: withOperation,
        packagesWithAnyCarrierDependency: canonicalDependent.length,
        packagesWithoutCarrierDependency:
          shadowKeys.length - canonicalDependent.length,
        // §4 — üç algoritmanın aynı anlık görüntüdeki sonucu
        crossAccountDuplicateAuditCarrierCount: legacyPackageDependent.length,
        nullShadowAuditCarrierCount: legacyFixedDependent.length,
        canonicalCarrierCount: canonicalDependent.length,
        differenceSamples: {
          onlyLegacyPackageIdOnly: onlyLegacyPackage,
          onlyCanonical,
        },
        cleanupPerformed: false,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((error) => {
    console.error('mutabakat başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
