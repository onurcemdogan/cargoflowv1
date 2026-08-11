import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// TASIYICI SAYIM MUTABAKATI.
//
// URETIM CELISKISI: duplicates:check ~230 carrier-dependent null_shadow
// paketi bildirirken null-shadow:audit 35 bildiriyordu.
//
// KOK NEDEN (kod duzeyinde): iki denetim tasiyici sorgusunu AYRI AYRI
// yazmisti.
//   ESKI-A (duplicates:check)  → YALNIZ package_id ile eslestiriyordu;
//     organizasyon ve pazaryeri kapsamini dusurdugu icin FAZLA sayiyordu.
//   ESKI-B (null-shadow:audit) → organizasyon kimligini TEK bir satirdan
//     (ilk NULL satir) turetip tum gruplara uyguluyordu.
//
// KANONIK ANAHTAR (schema + repository kaniti):
//   shipments: uniqueIndex(organization_id, marketplace, package_id, provider)
//   findShipment() ayni dortluyu kullanir.
// Varlik sorusunda provider ayrimi yapilmaz; org + marketplace ZORUNLUDUR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const carrier = await import('./orders/carrierDependency.ts')

const { organizations, shipments, shipmentOperations } = schema
const SCHEMA_SOURCE = readFileSync('server/db/schema.ts', 'utf8')
const REPO_SOURCE = readFileSync('server/shipments/shipmentRepository.ts', 'utf8')
const ELIGIBILITY_SOURCE = readFileSync(
  'server/orders/duplicateCleanupEligibility.ts',
  'utf8',
)
const NULL_AUDIT_SOURCE = readFileSync('server/orders/nullShadowAudit.ts', 'utf8')
const RECONCILE_CLI_SOURCE = readFileSync(
  'server/orders/carrierReconcileCli.ts',
  'utf8',
)

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [orgA] = await db
    .insert(organizations)
    .values({ name: 'A', slug: `a-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  const [orgB] = await db
    .insert(organizations)
    .values({ name: 'B', slug: `b-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  return { db, orgA: orgA.id, orgB: orgB.id }
}

// ═══ KANONIK ANAHTAR ══════════════════════════════════════════════════════

test('CARRIER-KEY-1: kanonik anahtar SEMA ve REPOSITORY ile kanitli', () => {
  assert.ok(
    SCHEMA_SOURCE.includes("uniqueIndex('shipments_org_marketplace_package_provider_unique')"),
  )
  // findShipment ayni dortluyu kullanir.
  assert.ok(REPO_SOURCE.includes('eq(shipments.organizationId, organizationId)'))
  assert.ok(REPO_SOURCE.includes('eq(shipments.marketplace, marketplace)'))
  assert.ok(REPO_SOURCE.includes('eq(shipments.packageId, packageId)'))
  assert.ok(REPO_SOURCE.includes('eq(shipments.provider, provider)'))
})

test('CARRIER-KEY-2: kanonik sayim org ve marketplace kapsamina UYAR', async () => {
  const { db, orgA, orgB } = await makeDb()
  // AYNI packageId, FARKLI organizasyon.
  await db.insert(shipments).values({
    organizationId: orgB,
    marketplace: 'Trendyol',
    packageId: 'P-1',
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  const keys = [
    { organizationId: orgA, marketplace: 'Trendyol', packageId: 'P-1' },
  ]
  const canonical = await carrier.loadCarrierDependencies(db, keys)
  assert.equal(
    carrier.isCarrierDependent(canonical.get(carrier.carrierKeyOf(keys[0]))),
    false,
    'baska organizasyonun gonderisi SAYILMAZ',
  )
  // ESKI-A ayni durumda YANLIS pozitif verir.
  const legacyA = await carrier.legacyCountByPackageIdOnly(db, ['P-1'])
  assert.equal(
    carrier.isCarrierDependent(legacyA.get('P-1')),
    true,
    'eski algoritma kapsam dusurdugu icin FAZLA sayar',
  )
})

test('CARRIER-KEY-3: farkli pazaryeri de SAYILMAZ', async () => {
  const { db, orgA } = await makeDb()
  await db.insert(shipments).values({
    organizationId: orgA,
    marketplace: 'Hepsiburada',
    packageId: 'P-2',
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  const keys = [
    { organizationId: orgA, marketplace: 'Trendyol', packageId: 'P-2' },
  ]
  const canonical = await carrier.loadCarrierDependencies(db, keys)
  assert.equal(
    carrier.isCarrierDependent(canonical.get(carrier.carrierKeyOf(keys[0]))),
    false,
  )
})

test('CARRIER-KEY-4: gonderi VEYA operasyon bagimlilik sayilir', async () => {
  const { db, orgA } = await makeDb()
  await db.insert(shipmentOperations).values({
    organizationId: orgA,
    marketplace: 'Trendyol',
    packageId: 'P-3',
    provider: 'surat-kargo',
    operationType: 'create',
    idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
    status: 'succeeded',
  })
  const keys = [
    { organizationId: orgA, marketplace: 'Trendyol', packageId: 'P-3' },
  ]
  const canonical = await carrier.loadCarrierDependencies(db, keys)
  const value = canonical.get(carrier.carrierKeyOf(keys[0]))
  assert.equal(value.shipments, 0)
  assert.equal(value.shipmentOperations, 1)
  assert.equal(carrier.isCarrierDependent(value), true)
  // Kayit YOKSA bagimlilik YOK.
  const empty = await carrier.loadCarrierDependencies(db, [
    { organizationId: orgA, marketplace: 'Trendyol', packageId: 'P-YOK' },
  ])
  assert.equal(
    carrier.isCarrierDependent(
      empty.get(
        carrier.carrierKeyOf({
          organizationId: orgA,
          marketplace: 'Trendyol',
          packageId: 'P-YOK',
        }),
      ),
    ),
    false,
  )
})

// ═══ ESKI ALGORITMALARIN FARKI ════════════════════════════════════════════

test('CARRIER-DIFF-1: uc algoritma AYNI kume uzerinde karsilastirilabilir', async () => {
  const { db, orgA, orgB } = await makeDb()
  // orgA'nin paketi: gercek bagimlilik.
  await db.insert(shipments).values({
    organizationId: orgA,
    marketplace: 'Trendyol',
    packageId: 'P-REAL',
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  // orgB'de AYNI package numarasi: orgA icin bagimlilik DEGIL.
  await db.insert(shipments).values({
    organizationId: orgB,
    marketplace: 'Trendyol',
    packageId: 'P-FALSE',
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  const keys = [
    { organizationId: orgA, marketplace: 'Trendyol', packageId: 'P-REAL' },
    { organizationId: orgA, marketplace: 'Trendyol', packageId: 'P-FALSE' },
  ]

  const canonical = await carrier.loadCarrierDependencies(db, keys)
  const canonicalCount = keys.filter((key) =>
    carrier.isCarrierDependent(canonical.get(carrier.carrierKeyOf(key))),
  ).length

  const legacyA = await carrier.legacyCountByPackageIdOnly(
    db,
    keys.map((key) => key.packageId),
  )
  const legacyACount = keys.filter((key) =>
    carrier.isCarrierDependent(legacyA.get(key.packageId)),
  ).length

  const legacyB = await carrier.legacyCountWithFixedOrganization(db, keys, orgA)
  const legacyBCount = keys.filter((key) =>
    carrier.isCarrierDependent(legacyB.get(carrier.carrierKeyOf(key))),
  ).length

  assert.equal(canonicalCount, 1, 'kanonik: yalniz gercek bagimlilik')
  assert.equal(legacyACount, 2, 'ESKI-A: kapsamsiz eslesme FAZLA sayar')
  assert.equal(legacyBCount, 1, 'ESKI-B: sabit org dogruysa kanonikle ayni')
  assert.ok(legacyACount > canonicalCount, 'fark olculebilir')
})

test('CARRIER-DIFF-2: ESKI-B yanlis org ile ALTTAN sayar', async () => {
  const { db, orgA, orgB } = await makeDb()
  await db.insert(shipments).values({
    organizationId: orgA,
    marketplace: 'Trendyol',
    packageId: 'P-X',
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  const keys = [
    { organizationId: orgA, marketplace: 'Trendyol', packageId: 'P-X' },
  ]
  // Sabit org YANLIS verilirse bagimlilik GORULMEZ (eski null-shadow davranisi).
  const legacyB = await carrier.legacyCountWithFixedOrganization(db, keys, orgB)
  assert.equal(
    carrier.isCarrierDependent(legacyB.get(carrier.carrierKeyOf(keys[0]))),
    false,
  )
  const canonical = await carrier.loadCarrierDependencies(db, keys)
  assert.equal(
    carrier.isCarrierDependent(canonical.get(carrier.carrierKeyOf(keys[0]))),
    true,
  )
})

// ═══ TEK KAYNAK ═══════════════════════════════════════════════════════════

test('CARRIER-SINGLE-SOURCE: her iki denetim AYNI helper i kullanir', () => {
  for (const source of [ELIGIBILITY_SOURCE, NULL_AUDIT_SOURCE]) {
    assert.ok(source.includes("from './carrierDependency.ts'"))
    assert.ok(source.includes('loadCarrierDependencies('))
    // Kendi ayri tasiyici sorgusu KALMADI.
    assert.equal(source.includes('.from(shipments)'), false)
    assert.equal(source.includes('.from(shipmentOperations)'), false)
  }
})

test('CARRIER-RECONCILE-CLI: salt okunur ve UC algoritmayi raporlar', () => {
  for (const field of [
    'nullShadowPackages',
    'packagesWithShipment',
    'packagesWithShipmentOperation',
    'packagesWithAnyCarrierDependency',
    'packagesWithoutCarrierDependency',
    'crossAccountDuplicateAuditCarrierCount',
    'nullShadowAuditCarrierCount',
    'canonicalCarrierCount',
    'differenceSamples',
    'canonicalKeyEvidence',
  ]) {
    assert.ok(RECONCILE_CLI_SOURCE.includes(field), field)
  }
  const code = RECONCILE_CLI_SOURCE.split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of ['.update(', '.insert(', '.delete(', 'transaction(']) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
  assert.ok(RECONCILE_CLI_SOURCE.includes('cleanupPerformed: false'))
})
