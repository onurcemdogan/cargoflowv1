import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { sql } from 'drizzle-orm'

// B2-1b-B2 · FAZ 3 — SALT OKUNUR ÖN KONTROL.
//
// FAIL-CLOSED sözleşmesi: şema beklenenden farklıysa hazırlık YOK sayılır.
// Rapora sır/PII girmez.

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', 'drizzle')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const preflight = await import('./orders/orderProjectionPreflight.ts')
const orderRepo = await import('./orders/orderRepository.ts')
const schema = await import('./db/schema.ts')

const nl = (v) => v.split('\r\n').join('\n')
const rows = (r) => (Array.isArray(r) ? r : r.rows) ?? []

async function makeDb({ withProjection = true } = {}) {
  const pglite = new PGlite()
  const db = drizzle(pglite, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  if (!withProjection) {
    // 0008 UYGULANMAMIŞ bir üretimi taklit et.
    await pglite.exec('DROP TABLE order_filter_projection')
  }
  return { pglite, db }
}

async function makeOrg(db) {
  const result = await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('Org','org-${randomBytes(5).toString('hex')}') returning id`))
  return String(rows(result)[0].id)
}

async function makeOrder(db, organizationId, packageId, { archived = false } = {}) {
  const id = randomUUID()
  await db.execute(sql.raw(
    `insert into orders (id, organization_id, marketplace, package_id, order_number,
       marketplace_status, operation_status, shipping_city, order_date${archived ? ', archived_at' : ''})
     values ('${id}','${organizationId}','Trendyol','${packageId}','ORD-${packageId}',
       'Created','NEW','İstanbul','2026-01-01T09:00:00.000Z'${archived ? ",'2026-02-01T00:00:00.000Z'" : ''})`))
  return id
}

/* ═══ ŞEMA SÖZLEŞMESİ ═══════════════════════════════════════════════════ */

test('PRE-1: temiz semada tum kontroller GECER', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())

  const report = await preflight.buildProjectionPreflightReport(db)
  assert.equal(report.projectionTableExists, true)
  assert.equal(report.projectionColumnsOk, true)
  assert.equal(report.projectionIndexesOk, true)
  assert.equal(report.projectionFkCascadeOk, true)
  assert.equal(report.migration0008Applied, true)
  assert.equal(report.schemaOk, true)
  assert.deepEqual(report.problems, [])
  assert.match(report.schemaVersion, /migrations/)
  assert.notEqual(report.databaseEngine, 'UNKNOWN')
})

test('PRE-2: 0008 UYGULANMAMISSA fail-closed', async (t) => {
  const { pglite, db } = await makeDb({ withProjection: false })
  t.after(() => pglite.close())

  const report = await preflight.buildProjectionPreflightReport(db)
  assert.equal(report.projectionTableExists, false)
  assert.equal(report.migration0008Applied, false)
  assert.equal(report.schemaOk, false)
  assert.ok(report.problems.includes('PROJECTION_TABLE_MISSING'))
  // Tablo yokken tenant hazırlığı ASLA aday olamaz.
  for (const tenant of report.tenants) {
    assert.equal(tenant.readinessCandidate, false)
  }
})

test('PRE-3: kolon DRIFTI yakalanir (fail-closed)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  // Üretimde biri elle kolon eklemiş gibi davran.
  await pglite.exec('ALTER TABLE order_filter_projection ADD COLUMN rogue text')

  const report = await preflight.buildProjectionPreflightReport(db)
  assert.equal(report.projectionColumnsOk, false)
  assert.equal(report.schemaOk, false)
  assert.ok(report.problems.includes('PROJECTION_COLUMNS_MISMATCH'))
})

test('PRE-4: eksik INDEKS yakalanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  await pglite.exec('DROP INDEX order_filter_projection_org_version_idx')

  const report = await preflight.buildProjectionPreflightReport(db)
  assert.equal(report.projectionIndexesOk, false)
  assert.equal(report.schemaOk, false)
  assert.ok(report.problems.includes('PROJECTION_INDEXES_MISSING'))
})

/* ═══ SAYIMLAR + TENANT KIRILIMI ════════════════════════════════════════ */

test('PRE-5: sayimlar ve stale tahmini DOGRU', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const covered = await makeOrder(db, org, 'PKG-1')
  await makeOrder(db, org, 'PKG-2')
  await makeOrder(db, org, 'PKG-3', { archived: true })

  // Yalnız bir siparişin projeksiyonu var.
  await orderRepo.markOrderLabelReady(db, org, covered)

  const report = await preflight.buildProjectionPreflightReport(db)
  assert.equal(report.orderCount, 3)
  assert.equal(report.activeOrderCount, 2, 'arsivli siparis aktif SAYILMAZ')
  assert.equal(report.projectionRowCount, 1)

  const tenant = report.tenants[0]
  assert.equal(tenant.orderCount, 3)
  assert.equal(tenant.projectionCount, 1)
  assert.deepEqual(tenant.versionDistribution, { 1: 1 })
  assert.equal(tenant.staleEstimate, 2, 'kapsanmayan 2 siparis stale')
  assert.equal(tenant.readinessCandidate, false, 'stale varken aday DEGIL')
})

test('PRE-6: kapsama TAMSA tenant aday olur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  for (const packageId of ['P1', 'P2', 'P3']) {
    const id = await makeOrder(db, org, packageId)
    await orderRepo.markOrderLabelReady(db, org, id)
  }

  const report = await preflight.buildProjectionPreflightReport(db)
  const tenant = report.tenants[0]
  assert.equal(tenant.staleEstimate, 0)
  assert.equal(tenant.readinessCandidate, true)
})

test('PRE-7: ESKI SURUM satirlari stale sayilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const id = await makeOrder(db, org, 'P1')
  await orderRepo.markOrderLabelReady(db, org, id)
  // Sözleşme sürümü ilerlemiş gibi: satır eski sürümde kalmış.
  await db.execute(sql.raw(
    `update order_filter_projection set projection_version = 0`))

  const report = await preflight.buildProjectionPreflightReport(db)
  const tenant = report.tenants[0]
  assert.deepEqual(tenant.versionDistribution, { 0: 1 })
  assert.equal(tenant.staleEstimate, 1, 'eski surum GUNCEL sayilmaz')
  assert.equal(tenant.readinessCandidate, false)
})

test('PRE-8: --org kapsami tek tenant ile SINIRLI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  await makeOrder(db, orgA, 'A1')
  await makeOrder(db, orgB, 'B1')
  await makeOrder(db, orgB, 'B2')

  const scoped = await preflight.buildProjectionPreflightReport(db, {
    organizationId: orgB,
  })
  assert.equal(scoped.orderCount, 2)
  assert.equal(scoped.organizationCount, 1)
  assert.equal(scoped.tenants.length, 1)
  assert.equal(scoped.tenants[0].organizationMasked, `****${orgB.slice(-4)}`)
})

/* ═══ GİZLİLİK ══════════════════════════════════════════════════════════ */

test('PRE-9: rapor SIR/PII SIZDIRMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const id = await makeOrder(db, org, 'PKG-1')
  await db.execute(sql.raw(
    `update orders set customer_first_name='Ömer', customer_last_name='Şahin',
       customer_email='omer@ornek.com', customer_phone='05550001000'
     where id='${id}'`))
  await orderRepo.markOrderLabelReady(db, org, id)

  const text = preflight.formatPreflightReport(
    await preflight.buildProjectionPreflightReport(db),
  ).join('\n')

  for (const secret of ['Ömer', 'Şahin', 'omer@ornek.com', '05550001000']) {
    assert.equal(text.includes(secret), false, `PII sizdi: ${secret}`)
  }
  // Tam organizasyon kimliği de basılmaz.
  assert.equal(text.includes(org), false, 'ham organizationId basilmamali')
  assert.ok(text.includes(`****${org.slice(-4)}`), 'maskeli kimlik olmali')
})

test('PRE-10: modul SALT OKUNUR (yazma/ag YOK)', () => {
  const source = nl(
    readFileSync('server/orders/orderProjectionPreflight.ts', 'utf8'),
  )
  for (const forbidden of [
    '.insert(', '.update(', '.delete(', 'migrate(', 'fetch(', 'axios',
    'refreshOrderProjectionFragment', 'decrypt',
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} olmamali`)
  }
  // Beklenen kolon listesi ELLE YAZILMAZ; şemadan türer.
  assert.ok(source.includes('getTableColumns(orderFilterProjection)'))
})

test('PRE-11: CLI fail-closed ve salt okunur', () => {
  const source = nl(
    readFileSync('server/orders/orderProjectionPreflightCli.ts', 'utf8'),
  )
  assert.ok(source.includes('if (!report.schemaOk)'), 'fail-closed dali olmali')
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'migrate(']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} olmamali`)
  }
})

/* ═══ TENANT HAZIRLIĞI (B2.9) ══════════════════════════════════════════ */

test('RDY-1: kapsama TAM olsa bile parite KABUL EDILMEDEN hazir DEGIL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const id = await makeOrder(db, org, 'P1')
  await orderRepo.markOrderLabelReady(db, org, id)

  const readiness = await preflight.evaluateTenantReadiness(db, org)
  assert.equal(readiness.migrationCompatible, true)
  assert.equal(readiness.backfillComplete, true)
  assert.equal(readiness.versionCurrent, true)
  assert.equal(readiness.shadowParityAccepted, false, 'varsayilan KABUL EDILMEMIS')
  assert.equal(readiness.ready, false, 'kendiliginden hazir OLAMAZ')
  assert.deepEqual(readiness.blockers, ['SHADOW_PARITY_NOT_ACCEPTED'])
})

test('RDY-2: parite kabul edilince HAZIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const id = await makeOrder(db, org, 'P1')
  await orderRepo.markOrderLabelReady(db, org, id)

  const readiness = await preflight.evaluateTenantReadiness(db, org, {
    shadowParityAccepted: true,
  })
  assert.equal(readiness.ready, true)
  assert.deepEqual(readiness.blockers, [])
})

test('RDY-3: eksik backfill hazirligi ENGELLER', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await makeOrder(db, org, 'P1')
  await makeOrder(db, org, 'P2')

  const readiness = await preflight.evaluateTenantReadiness(db, org, {
    shadowParityAccepted: true,
  })
  assert.equal(readiness.staleCount, 2)
  assert.equal(readiness.backfillComplete, false)
  assert.equal(readiness.ready, false)
  assert.ok(readiness.blockers.includes('BACKFILL_INCOMPLETE'))
})

test('RDY-4: 0008 yoksa hicbir sey hazir DEGIL', async (t) => {
  const { pglite, db } = await makeDb({ withProjection: false })
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const readiness = await preflight.evaluateTenantReadiness(db, org, {
    shadowParityAccepted: true,
  })
  assert.equal(readiness.migrationCompatible, false)
  assert.equal(readiness.ready, false)
  assert.ok(readiness.blockers.includes('MIGRATION_NOT_APPLIED'))
})

test('RDY-5: TENANT BAGIMSIZ — biri digerini ETKILEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  const covered = await makeOrder(db, orgA, 'A1')
  await orderRepo.markOrderLabelReady(db, orgA, covered)
  await makeOrder(db, orgB, 'B1')

  const a = await preflight.evaluateTenantReadiness(db, orgA, { shadowParityAccepted: true })
  const b = await preflight.evaluateTenantReadiness(db, orgB, { shadowParityAccepted: true })
  assert.equal(a.ready, true)
  assert.equal(b.ready, false, 'B hazir degil')
  assert.equal(a.staleCount, 0)
  assert.equal(b.staleCount, 1)
  // Global bayrak YOK: modül tekil bir "hepsi hazır" değeri üretmez.
  const source = nl(readFileSync('server/orders/orderProjectionPreflight.ts', 'utf8'))
  assert.equal(source.includes('globalReady'), false)
  assert.equal(source.includes('allTenantsReady'), false)
})
