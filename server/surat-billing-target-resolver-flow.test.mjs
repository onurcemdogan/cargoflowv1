import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// FAZ 3D — TEŞHİS HEDEFİ ÇÖZÜMÜ.
//
// ÜRETİMDE ÇÖKTÜ: tarayıcı aday olarak `cargoTrackingNumber` (727…) üretip
// `--package <727…>` komutunu KENDİSİ yazıyordu; teşhis aracı ise yalnız
// `orders.package_id` ile arıyordu. Üretilen komut yapısı gereği çalışamazdı.
//
// EN ÖNEMLİ DEĞİŞMEZ (bu paketin varlık sebebi):
//   SCAN_CANDIDATE_IS_INSPECTABLE — tarayıcının aday gösterdiği her kimlik
//   teşhis aracı tarafından çözülebilmelidir. Aksi hâlde araç zinciri kopuk.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const scanner = await import('./shipments/suratBillingScanner.ts')

const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []

async function makeDb() {
  const pglite = new PGlite()
  const dir = join(here, '..', 'drizzle')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pglite.exec(statement)
    }
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db, name = 'MonalisaToka') {
  const rows = rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('${name}','${name.toLowerCase()}-${randomBytes(3).toString('hex')}')
     returning id, name, slug`)))
  return { id: String(rows[0].id), name: rows[0].name, slug: rows[0].slug }
}

async function seedOrder(db, org, o) {
  await db.execute(sql`insert into orders
    (organization_id, marketplace, package_id, order_number, external_order_id,
     marketplace_status, operation_status, shipping_city, cargo_tracking_number,
     order_date)
    values (${org.id}, 'Trendyol', ${o.packageId}, ${o.orderNumber ?? 'ORD-1'},
      ${o.externalOrderId ?? null}, 'Created', 'NEW', 'İstanbul',
      ${o.cargoTrackingNumber ?? null}, ${o.orderDate ?? '2026-03-01T09:00:00.000Z'})`)
}

const PARCEL = '7270035942963454'

/* ═══ ÇOK ALANLI ÇÖZÜM ═════════════════════════════════════════════════ */

test('RES-A: packageId ile bulur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-1', cargoTrackingNumber: PARCEL })

  const result = await scanner.resolveBillingInspectionTarget(db, org.id, 'PKG-1')
  assert.equal(result.status, 'ok')
  assert.equal(result.matchedField, 'packageId')
  assert.equal(String(result.order.packageId), 'PKG-1')
})

test('RES-C: 727 (cargoTrackingNumber) ile bulur — KÖK NEDEN', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-1', cargoTrackingNumber: PARCEL })

  const result = await scanner.resolveBillingInspectionTarget(db, org.id, PARCEL)
  assert.equal(result.status, 'ok', 'tarayicinin urettigi kimlik COZULMELI')
  assert.equal(result.matchedField, 'cargoTrackingNumber')
  assert.equal(String(result.order.packageId), 'PKG-1')
})

test('RES-B: shipment paket kimligi ile bulur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-SHIP', cargoTrackingNumber: null })
  await db.execute(sql`insert into shipments
    (organization_id, marketplace, package_id, provider, source, status)
    values (${org.id}, 'Trendyol', 'PKG-SHIP', 'surat', 'local_create', 'created')`)

  const result = await scanner.resolveBillingInspectionTarget(db, org.id, 'PKG-SHIP')
  // packageId zaten eşleşir; gönderi yolu yalnız sipariş bulunamazsa devreye girer.
  assert.equal(result.status, 'ok')
})

test('RES-EXT: externalOrderId ve orderNumber ile bulur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, {
    packageId: 'PKG-2', orderNumber: '1141000777', externalOrderId: 'EXT-777',
  })

  const byExternal = await scanner.resolveBillingInspectionTarget(db, org.id, 'EXT-777')
  assert.equal(byExternal.matchedField, 'externalOrderId')
  const byOrderNumber = await scanner.resolveBillingInspectionTarget(
    db, org.id, '1141000777',
  )
  assert.equal(byOrderNumber.matchedField, 'orderNumber')
})

/* ═══ TENANT İZOLASYONU ════════════════════════════════════════════════ */

test('RES-D: BASKA tenanttaki ayni kimlik BULUNMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'TenantA')
  const orgB = await makeOrg(db, 'TenantB')
  await seedOrder(db, orgA, { packageId: 'PKG-X', cargoTrackingNumber: PARCEL })

  const wrongTenant = await scanner.resolveBillingInspectionTarget(db, orgB.id, PARCEL)
  assert.equal(wrongTenant.status, 'not_found', 'tenant kapsami ASILMAZ')
  const rightTenant = await scanner.resolveBillingInspectionTarget(db, orgA.id, PARCEL)
  assert.equal(rightTenant.status, 'ok')
})

/* ═══ BELİRSİZLİK + FAIL-CLOSED ════════════════════════════════════════ */

test('RES-E: ayni kimlik iki siparistr → AMBIGUOUS (tahmin YOK)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, {
    packageId: 'PKG-A', orderNumber: 'ORD-A', cargoTrackingNumber: PARCEL,
  })
  await seedOrder(db, org, {
    packageId: 'PKG-B', orderNumber: 'ORD-B', cargoTrackingNumber: PARCEL,
  })

  const result = await scanner.resolveBillingInspectionTarget(db, org.id, PARCEL)
  assert.equal(result.status, 'ambiguous')
  assert.equal(result.matchedField, 'cargoTrackingNumber')
  assert.ok(result.matches >= 2)
})

test('RES-F: bos/bozuk girdi fail-closed', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  for (const bad of ['', '   ', null, undefined]) {
    const result = await scanner.resolveBillingInspectionTarget(db, org.id, bad)
    assert.equal(result.status, 'not_found', String(bad))
  }
  const noTenant = await scanner.resolveBillingInspectionTarget(db, '', PARCEL)
  assert.equal(noTenant.status, 'not_found')
})

test('RES-G: eslesme yoksa NOT_FOUND (regresyon yok)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-1', cargoTrackingNumber: PARCEL })
  const result = await scanner.resolveBillingInspectionTarget(db, org.id, 'YOK-123')
  assert.equal(result.status, 'not_found')
  assert.equal(result.matchedField, null)
})

/* ═══ EN ÖNEMLİ DEĞİŞMEZ ═══════════════════════════════════════════════ */

test('SCAN_CANDIDATE_IS_INSPECTABLE: tarayici adayi TESHIS EDILEBILIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // Üretimdeki gerçek şekil: packageId ayrı, 727 cargoTrackingNumber'da.
  await seedOrder(db, org, {
    packageId: 'PKG-PROD-1', cargoTrackingNumber: PARCEL, orderDate: '2026-03-05T09:00:00.000Z',
  })
  await seedOrder(db, org, {
    packageId: 'PKG-PROD-2', orderNumber: 'ORD-2',
    cargoTrackingNumber: '7270035942963455', orderDate: '2026-03-04T09:00:00.000Z',
  })

  const scan = await scanner.scanTenantBillingCandidates(db, org, { limit: 50 })
  const candidates = [
    ...scan.supplierCandidates,
    ...scan.trendyolPaysCandidates,
  ].filter((candidate) => candidate.parcelIdentity)
  assert.ok(candidates.length > 0, 'tarayici aday uretmeli')

  // HER aday teşhis aracı tarafından çözülebilmeli.
  for (const candidate of candidates) {
    const resolved = await scanner.resolveBillingInspectionTarget(
      db, org.id, candidate.parcelIdentity,
    )
    assert.equal(
      resolved.status, 'ok',
      `aday cozulemedi: ${candidate.parcelIdentity}`,
    )
  }

  // Üretilen komut da aynı kimliği taşımalı (komut/araç sözleşmesi tutarlı).
  const report = scanner.formatScanReport(scan, org.name).join('\n')
  const match = report.match(/--package (\S+)/)
  assert.ok(match, 'NEXT komutu paket kimligi icermeli')
  const fromCommand = await scanner.resolveBillingInspectionTarget(db, org.id, match[1])
  assert.equal(fromCommand.status, 'ok', 'URETILEN KOMUT calisabilir olmali')
})

/* ═══ YAPISAL ══════════════════════════════════════════════════════════ */

test('RES-SRC: genis LIKE taramasi YOK, tenant kapsami HER sorguda', () => {
  const source = readFileSync('server/shipments/suratBillingScanner.ts', 'utf8')
  const start = source.indexOf('export async function resolveBillingInspectionTarget')
  const body = source.slice(start)
  assert.equal(body.includes('like'), false, 'LIKE taramasi OLMAMALI')
  assert.equal(body.includes('ilike'), false)
  // Tenant kapsamı ve gönderi sorgusu ayrı ayrı kapsamlı.
  assert.ok(body.includes('eq(orders.organizationId, organizationId)'))
  assert.ok(body.includes('eq(shipments.organizationId, organizationId)'))
})
