import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ÇAPRAZ HESAP TEKRARI + TANI HESAP KAPSAMI.
//
// URETIM VAKASI (PII YOK): packageId 4028055254 / orderNumber 11448183224
//   ROW A · hesap db74a7c0… · Delivered · operationStatus null · lastSeen 08-11
//   ROW B · hesap 82505c2e… · Picking   · operationStatus NEW  · lastSeen 07-28
// UI aktif hesap kapsamini kullanip Delivered gosteriyor; eski tani araci
// kapsam belirtmeden satir sectigi icin Picking satirini "persisted" sanip
// yanlis B2_persistence_or_matching_bug verdikti.
//
// Bu paket: (a) tani araci KANONIK aktif hesap satirini secer, (b) capraz
// hesap tekrarlari salt okunur sayilir/siniflandirilir. TEMIZLIK YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const trace = await import('./orders/trendyolPackageIdentityTrace.ts')
const audit = await import('./orders/crossAccountDuplicateAudit.ts')

const { orders, organizations, marketplaceAccounts, shipments } = schema
const CLI_SOURCE = readFileSync(
  'server/orders/trendyolPackageIdentityTraceCli.ts',
  'utf8',
)
const AUDIT_CLI_SOURCE = readFileSync(
  'server/orders/crossAccountDuplicateAuditCli.ts',
  'utf8',
)

const GOLDEN = { packageId: '4028055254', orderNumber: '11448183224' }
const NOW = new Date('2026-08-11T21:00:00.000Z')

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
  return drizzle(pglite, { schema })
}

async function makeOrg(db, { activeProviderId = '277221' } = {}) {
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Org', slug: `org-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  const [active] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      providerAccountId: activeProviderId,
      isActive: true,
    })
    .returning({ id: marketplaceAccounts.id })
  const [legacy] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      providerAccountId: `${activeProviderId}-legacy`,
      isActive: false,
    })
    .returning({ id: marketplaceAccounts.id })
  return { organizationId: org.id, activeId: active.id, legacyId: legacy.id }
}

const seedRow = (db, organizationId, accountId, overrides = {}) =>
  db.insert(orders).values({
    organizationId,
    marketplaceAccountId: accountId,
    marketplace: 'Trendyol',
    packageId: GOLDEN.packageId,
    orderNumber: GOLDEN.orderNumber,
    marketplaceStatus: 'Picking',
    operationStatus: 'NEW',
    orderDate: new Date('2026-07-26T10:00:00.000Z'),
    lastSeenAt: NOW,
    ...overrides,
  })

/** CLI'nin kanonik satir secimini AYNEN uygular (kopya degil, sozlesme). */
function selectCanonical(rows, activeAccountId) {
  const scoped =
    rows.find(
      (row) =>
        String(row.marketplaceAccountId ?? '') === String(activeAccountId ?? ''),
    ) ?? null
  return {
    row: scoped ?? rows[0] ?? null,
    selection: scoped
      ? 'active_account_scope'
      : rows.length > 0
        ? 'fallback_most_recently_seen'
        : 'not_found',
  }
}

const livePackage = (status = 'Delivered') => ({
  id: GOLDEN.packageId,
  packageId: GOLDEN.packageId,
  orderNumber: GOLDEN.orderNumber,
  status,
  shipmentPackageStatus: status,
  lastModifiedDate: NOW.getTime(),
})

// ═══ TANI HESAP KAPSAMI ═══════════════════════════════════════════════════

test('ACCOUNT-DIAG-1: farkli hesaplardaki iki satirdan KANONIK olan secilir', async () => {
  const db = await makeDb()
  const { organizationId, activeId, legacyId } = await makeOrg(db)
  await seedRow(db, organizationId, legacyId, {
    marketplaceStatus: 'Picking',
    lastSeenAt: new Date('2026-07-28T08:21:32.472Z'),
  })
  await seedRow(db, organizationId, activeId, {
    marketplaceStatus: 'Delivered',
    operationStatus: null,
  })
  const rows = await db
    .select({
      marketplaceAccountId: orders.marketplaceAccountId,
      marketplaceStatus: orders.marketplaceStatus,
    })
    .from(orders)
  assert.equal(rows.length, 2, 'iki AYRI satir')

  const canonical = selectCanonical(rows, activeId)
  assert.equal(canonical.selection, 'active_account_scope')
  assert.equal(canonical.row.marketplaceStatus, 'Delivered')
})

test('ACCOUNT-DIAG-2: aktif Delivered + legacy Picking → IN_SYNC', () => {
  const packages = [livePackage('Delivered')].map(
    trace.extractPackageIdentityFields,
  )
  const verdict = trace.classifyPackageIdentityCase({
    persistedPackageId: GOLDEN.packageId,
    packages,
    persistedMarketplaceStatus: 'Delivered',
  })
  assert.equal(verdict.case, 'IN_SYNC')
  assert.equal(verdict.conclusive, true)

  // ESKI DAVRANIS: kanonik statu verilmezse hala B2 der (yanlis teshis).
  const withoutCanonical = trace.classifyPackageIdentityCase({
    persistedPackageId: GOLDEN.packageId,
    packages,
  })
  assert.equal(withoutCanonical.case, 'B2_persistence_or_matching_bug')

  // Kanonik satir GERCEKTEN geride ise B2 KORUNUR.
  const stillBehind = trace.classifyPackageIdentityCase({
    persistedPackageId: GOLDEN.packageId,
    packages,
    persistedMarketplaceStatus: 'Picking',
  })
  assert.equal(stillBehind.case, 'B2_persistence_or_matching_bug')
})

test('ACCOUNT-DIAG-3: NULL golge satir kanonik secimi BOZMAZ', async () => {
  const db = await makeDb()
  const { organizationId, activeId } = await makeOrg(db)
  await seedRow(db, organizationId, null, {
    marketplaceStatus: 'Picking',
    lastSeenAt: new Date('2026-08-11T23:00:00.000Z'), // EN YENI
  })
  await seedRow(db, organizationId, activeId, { marketplaceStatus: 'Delivered' })
  const rows = await db
    .select({
      marketplaceAccountId: orders.marketplaceAccountId,
      marketplaceStatus: orders.marketplaceStatus,
    })
    .from(orders)
  const canonical = selectCanonical(rows, activeId)
  assert.equal(canonical.selection, 'active_account_scope')
  assert.equal(canonical.row.marketplaceStatus, 'Delivered', 'golge SECILMEZ')
})

test('ACCOUNT-DIAG-4: iki organizasyon birbirine KARISMAZ', async () => {
  const db = await makeDb()
  const first = await makeOrg(db, { activeProviderId: '111' })
  const second = await makeOrg(db, { activeProviderId: '222' })
  await seedRow(db, first.organizationId, first.activeId, {
    marketplaceStatus: 'Delivered',
  })
  await seedRow(db, second.organizationId, second.activeId, {
    marketplaceStatus: 'Picking',
  })
  const report = await audit.auditCrossAccountDuplicates(db, {
    organizationId: first.organizationId,
    activeAccountIds: [first.activeId],
  })
  assert.equal(report.duplicatePackageCount, 0, 'org kapsami korunur')
})

test('ACCOUNT-DIAG-5: tani ciktilari PII/credential SIZDIRMAZ', () => {
  for (const source of [CLI_SOURCE, AUDIT_CLI_SOURCE]) {
    const code = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    for (const forbidden of [
      'customerFirstName',
      'customerPhone',
      'shippingAddressEncrypted',
      'encryptedPayload',
      'apiSecret:',
      'providerAccountId:',
    ]) {
      assert.equal(code.includes(forbidden), false, forbidden)
    }
  }
  // Tekrar tanisi YAZMA yapmaz.
  for (const forbidden of ['.update(', '.insert(', '.delete(']) {
    assert.equal(AUDIT_CLI_SOURCE.includes(forbidden), false, forbidden)
  }
  assert.ok(AUDIT_CLI_SOURCE.includes('cleanupPerformed: false'))
})

// ═══ TEKRAR SAYIMI ════════════════════════════════════════════════════════

test('ACCOUNT-DUP-1: capraz hesap tekrari DOGRU sayilir ve siniflanir', async () => {
  const db = await makeDb()
  const { organizationId, activeId, legacyId } = await makeOrg(db)
  await seedRow(db, organizationId, activeId, { marketplaceStatus: 'Delivered' })
  await seedRow(db, organizationId, legacyId, { marketplaceStatus: 'Picking' })
  // Tekrarsiz baska bir paket (sayima GIRMEZ).
  await seedRow(db, organizationId, activeId, {
    packageId: 'P-SOLO',
    orderNumber: 'O-SOLO',
  })

  const report = await audit.auditCrossAccountDuplicates(db, {
    organizationId,
    activeAccountIds: [activeId],
  })
  assert.equal(report.duplicatePackageCount, 1)
  assert.equal(report.duplicateRowCount, 2)
  assert.equal(report.samples.length, 1)
  assert.equal(report.samples[0].packageId, GOLDEN.packageId)
  assert.equal(report.samples[0].duplicateClass, 'active_plus_legacy')
  assert.deepEqual(report.classCounts, { active_plus_legacy: 1 })
  // Aktif kapsam bayragi satir bazinda dogru.
  const active = report.samples[0].rows.filter((row) => row.isActiveAccountScope)
  assert.equal(active.length, 1)
  assert.equal(active[0].marketplaceStatus, 'Delivered')
})

test('ACCOUNT-DUP-1b: siniflandirma NULL golge ve aktif-yok durumunu ayirir', () => {
  assert.equal(
    audit.classifyDuplicateGroup(['a', null], ['a']),
    'null_shadow',
  )
  assert.equal(audit.classifyDuplicateGroup(['a', 'b'], ['a', 'b']), 'multiple_active')
  assert.equal(audit.classifyDuplicateGroup(['a', 'b'], ['a']), 'active_plus_legacy')
  assert.equal(audit.classifyDuplicateGroup(['a', 'b'], []), 'no_active_scope')
})

test('ACCOUNT-DUP-2: tasiyici/islem bagimlilik sayimlari RAPORLANIR', async () => {
  const db = await makeDb()
  const { organizationId, activeId, legacyId } = await makeOrg(db)
  await seedRow(db, organizationId, activeId, { marketplaceStatus: 'Delivered' })
  await seedRow(db, organizationId, legacyId, { marketplaceStatus: 'Picking' })
  await db.insert(shipments).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: GOLDEN.packageId,
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  const report = await audit.auditCrossAccountDuplicates(db, {
    organizationId,
    activeAccountIds: [activeId],
  })
  const counts = report.samples[0].rows[0].childCounts
  assert.equal(counts.shipments, 1, 'tasiyici kaydi gorunur')
  assert.equal(counts.shipmentOperations, 0)
  assert.ok(Number.isInteger(counts.orderLines))
})

// ═══ KAPSAM ═══════════════════════════════════════════════════════════════

test('ACCOUNT-DIAG-SCOPE: tani araci hala SALT OKUNUR ve kanonik secim yapar', () => {
  assert.ok(CLI_SOURCE.includes('getActiveAccount(db, organizationId'))
  assert.ok(CLI_SOURCE.includes('canonicalSelection'))
  assert.ok(CLI_SOURCE.includes('persistedMatches'))
  assert.ok(CLI_SOURCE.includes('persistedMarketplaceStatus: persistedRow?.marketplaceStatus'))
  const code = CLI_SOURCE.split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  for (const forbidden of ['.update(', '.insert(', '.delete(']) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
})

// ═══ TEMIZLIK UYGUNLUK DENETIMI (SALT OKUNUR, SILME YOK) ══════════════════
//
// URETIM: duplicatePackageCount=964 · duplicateRowCount=1929
//         null_shadow=334 · active_plus_legacy=630
// 2 x 964 = 1928 oldugundan EN AZ BIR grup 3 satirli (anomali).
//
// KRITIK KISIT: shipments/shipment_operations dogal anahtari
// (org, marketplace, package_id) — marketplace_account_id VEYA order_id
// ICERMEZ. Tasiyici kaydi TEK BIR duplicate satira ATFEDILEMEZ; bu yuzden
// paket duzeyinde raporlanir ve MUHAFAZAKAR yorumlanir.

const eligibility = await import('./orders/duplicateCleanupEligibility.ts')

const row = (overrides = {}) => ({
  id: `row-${randomBytes(3).toString('hex')}`,
  marketplaceAccountId: 'legacy-1',
  role: 'legacy',
  marketplaceStatus: 'Picking',
  operationStatus: 'NEW',
  archived: false,
  orderLineCount: 1,
  ...overrides,
})

const clean = { shipments: 0, shipmentOperations: 0 }

test('ELIGIBILITY-1: aktif karsiligi olan TEMIZ legacy satir potansiyel aday', () => {
  const verdict = eligibility.evaluateGroupEligibility({
    duplicateClass: 'active_plus_legacy',
    rowCount: 2,
    rows: [
      row({ id: 'active-1', marketplaceAccountId: 'active-1', role: 'active' }),
      row({ id: 'legacy-row', marketplaceAccountId: 'legacy-1' }),
    ],
    packageCarrier: clean,
    inactiveAccountIds: ['legacy-1'],
  })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.candidateRowId, 'legacy-row')
  assert.deepEqual(verdict.reasons, [])
})

test('ELIGIBILITY-2: PAKET tasiyici bagimliligi grubu ENGELLER', () => {
  for (const carrier of [
    { shipments: 1, shipmentOperations: 0 },
    { shipments: 0, shipmentOperations: 1 },
  ]) {
    const verdict = eligibility.evaluateGroupEligibility({
      duplicateClass: 'active_plus_legacy',
      rowCount: 2,
      rows: [
        row({ id: 'a', marketplaceAccountId: 'active-1', role: 'active' }),
        row({ id: 'b' }),
      ],
      packageCarrier: carrier,
      inactiveAccountIds: ['legacy-1'],
    })
    assert.equal(verdict.eligible, false)
    assert.ok(
      verdict.reasons.includes('package_has_shipment') ||
        verdict.reasons.includes('package_has_shipment_operation'),
    )
  }
})

test('ELIGIBILITY-3: 2 satirdan fazla grup ANOMALI (aday DEGIL)', () => {
  const verdict = eligibility.evaluateGroupEligibility({
    duplicateClass: 'active_plus_legacy',
    rowCount: 3,
    rows: [
      row({ id: 'a', marketplaceAccountId: 'active-1', role: 'active' }),
      row({ id: 'b' }),
      row({ id: 'c', marketplaceAccountId: null, role: 'null_shadow' }),
    ],
    packageCarrier: clean,
    inactiveAccountIds: ['legacy-1'],
  })
  assert.equal(verdict.eligible, false)
  assert.ok(verdict.reasons.includes('multi_row_group'))
})

test('ELIGIBILITY-4: aktif karsilik YOKSA aday DEGIL', () => {
  const verdict = eligibility.evaluateGroupEligibility({
    duplicateClass: 'active_plus_legacy',
    rowCount: 2,
    rows: [row({ id: 'a' }), row({ id: 'b', marketplaceAccountId: 'legacy-2' })],
    packageCarrier: clean,
    inactiveAccountIds: ['legacy-1', 'legacy-2'],
  })
  assert.equal(verdict.eligible, false)
  assert.ok(verdict.reasons.includes('no_active_counterpart'))
})

test('ELIGIBILITY-5: legacy hesap PASIF degilse aday DEGIL', () => {
  const verdict = eligibility.evaluateGroupEligibility({
    duplicateClass: 'active_plus_legacy',
    rowCount: 2,
    rows: [
      row({ id: 'a', marketplaceAccountId: 'active-1', role: 'active' }),
      row({ id: 'b', marketplaceAccountId: 'other-active' }),
    ],
    packageCarrier: clean,
    inactiveAccountIds: [],
  })
  assert.equal(verdict.eligible, false)
  assert.ok(verdict.reasons.includes('account_not_inactive'))
})

test('ELIGIBILITY-6: arsivli aday satir ENGELLENIR', () => {
  const verdict = eligibility.evaluateGroupEligibility({
    duplicateClass: 'null_shadow',
    rowCount: 2,
    rows: [
      row({ id: 'a', marketplaceAccountId: 'active-1', role: 'active' }),
      row({ id: 'b', marketplaceAccountId: null, role: 'null_shadow', archived: true }),
    ],
    packageCarrier: clean,
    inactiveAccountIds: [],
  })
  assert.equal(verdict.eligible, false)
  assert.ok(verdict.reasons.includes('archived_row'))
})

test('ELIGIBILITY-7: toplu rapor sinif ve rol kirilimini DOGRU uretir', async () => {
  const db = await makeDb()
  const { organizationId, activeId, legacyId } = await makeOrg(db)

  // (1) active + legacy, TEMIZ → aday
  await seedRow(db, organizationId, activeId, {
    packageId: 'P-CLEAN',
    orderNumber: 'O-CLEAN',
    marketplaceStatus: 'Delivered',
  })
  await seedRow(db, organizationId, legacyId, {
    packageId: 'P-CLEAN',
    orderNumber: 'O-CLEAN',
  })

  // (2) active + legacy, PAKETTE gonderi var → engelli
  await seedRow(db, organizationId, activeId, {
    packageId: 'P-SHIP',
    orderNumber: 'O-SHIP',
    marketplaceStatus: 'Delivered',
  })
  await seedRow(db, organizationId, legacyId, {
    packageId: 'P-SHIP',
    orderNumber: 'O-SHIP',
  })
  await db.insert(shipments).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: 'P-SHIP',
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })

  // (3) NULL golge + active, TEMIZ → aday
  await seedRow(db, organizationId, activeId, {
    packageId: 'P-SHADOW',
    orderNumber: 'O-SHADOW',
    marketplaceStatus: 'Delivered',
  })
  await seedRow(db, organizationId, null, {
    packageId: 'P-SHADOW',
    orderNumber: 'O-SHADOW',
  })

  const report = await eligibility.buildCleanupEligibilityReport(db, {
    organizationId,
    activeAccountIds: [activeId],
    inactiveAccountIds: [legacyId],
  })

  assert.equal(report.totalDuplicatePackages, 3)
  assert.equal(report.totalDuplicateRows, 6)
  assert.equal(report.classAggregates.active_plus_legacy.packageCount, 2)
  assert.equal(report.classAggregates.null_shadow.packageCount, 1)
  // Tasiyici bagimliligi PAKET duzeyinde: her iki satir da isaretlenir.
  assert.equal(report.classAggregates.active_plus_legacy.rowsWithShipments, 2)
  assert.equal(report.classAggregates.active_plus_legacy.activeRowsWithShipment, 1)
  assert.equal(report.classAggregates.active_plus_legacy.legacyRowsWithShipment, 1)
  assert.equal(
    report.classAggregates.active_plus_legacy.legacyRowsWithNoCarrierChildren,
    1,
  )
  assert.equal(report.cleanupEligibleCount, 2, 'temiz iki grup')
  assert.equal(report.blockedCount, 1)
  assert.equal(report.blockedReasons.package_has_shipment, 1)
  assert.equal(report.multiRowGroups.count, 0)
  assert.ok(report.carrierAttribution.includes('ATFEDILEMEZ'))
})

test('ELIGIBILITY-8: 3 satirli grup RAPORLANIR ve adaylıktan CIKAR', async () => {
  const db = await makeDb()
  const { organizationId, activeId, legacyId } = await makeOrg(db)
  await seedRow(db, organizationId, activeId, { packageId: 'P-MULTI', orderNumber: 'O-MULTI' })
  await seedRow(db, organizationId, legacyId, { packageId: 'P-MULTI', orderNumber: 'O-MULTI' })
  await seedRow(db, organizationId, null, { packageId: 'P-MULTI', orderNumber: 'O-MULTI' })

  const report = await eligibility.buildCleanupEligibilityReport(db, {
    organizationId,
    activeAccountIds: [activeId],
    inactiveAccountIds: [legacyId],
  })
  assert.equal(report.multiRowGroups.count, 1)
  assert.equal(report.multiRowGroups.samples[0].rowCount, 3)
  assert.equal(report.multiRowGroups.samples[0].packageId, 'P-MULTI')
  assert.equal(report.cleanupEligibleCount, 0)
  assert.equal(report.blockedReasons.multi_row_group, 1)
})

test('ELIGIBILITY-9: denetim SALT OKUNUR (yazma yuzeyi YOK)', () => {
  const source = readFileSync('server/orders/duplicateCleanupEligibility.ts', 'utf8')
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of ['.update(', '.insert(', '.delete(', 'transaction(']) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
  assert.ok(code.includes('.select('))
  // CLI temizlik YAPMADIGINI acikca bildirir.
  assert.ok(AUDIT_CLI_SOURCE.includes('cleanupPerformed: false'))
})
