import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// P1/B2 — SORGU ŞEKLİ KIYASLAMASI (yüksek hacim).
//
// AMAÇ: gecikme ÖLÇMEK DEĞİL. PGlite süreleri üretime taşınmaz; darboğaz
// genellikle DB değil sonuç aktarımıdır. Burada YAPISAL değişmezler ölçülür:
// sorgu SAYISI sayfa boyutuyla ölçeklenmemeli (N+1 yok), okunan satır sayısı
// SINIRLI kalmalı ve toplam sayım sayfadan BAĞIMSIZ olmalı.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const orderService = await import('./orders/orderPersistenceService.ts')
const orderRepo = await import('./orders/orderRepository.ts')

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

/** Gerçek sorguları sayan sarmalayıcı — SQL metni saklanmaz, yalnız sayaç. */
async function makeCountingDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const counter = { queries: 0 }
  const original = pglite.query.bind(pglite)
  pglite.query = (...args) => { counter.queries += 1; return original(...args) }
  return { db: drizzle(pglite, { schema }), counter }
}

const seedOrder = (index) => ({
  marketplace: 'Trendyol',
  packageId: `PKG${String(index).padStart(6, '0')}`,
  shipmentPackageId: `PKG${String(index).padStart(6, '0')}`,
  orderNumber: `114${String(index).padStart(7, '0')}`,
  marketplaceStatus: 'Created',
  operationStatus: 'NEW',
  customerFirstName: 'A', customerLastName: 'B',
  city: 'İstanbul', totalAmount: 100, currency: 'TRY',
  orderDate: '2026-07-26T08:00:00Z',
  lines: [
    { externalLineId: `L${index}-1`, productName: 'X', quantity: 1, price: 50 },
    { externalLineId: `L${index}-2`, productName: 'Y', quantity: 1, price: 50 },
  ],
})

const SEED_COUNT = 400

async function seeded() {
  const { db, counter } = await makeCountingDb()
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'bench', slug: 'bench' }).returning()
  await orderRepo.upsertMarketplaceOrders(
    db, org.id, Array.from({ length: SEED_COUNT }, (_, i) => seedOrder(i)),
  )
  counter.queries = 0
  return { db, counter, organizationId: org.id }
}

/* ═══ SORGU SAYISI SAYFA BOYUTUYLA ÖLÇEKLENMEZ ═══════════════════════ */

test('B2-1: sorgu sayisi sayfa boyutuyla ORANTILI ARTMAZ (N+1 yok)', async () => {
  const small = await seeded()
  await orderService.listOrders(small.db, small.organizationId, { pageSize: 10 })
  const smallQueries = small.counter.queries

  const large = await seeded()
  await orderService.listOrders(large.db, large.organizationId, { pageSize: 200 })
  const largeQueries = large.counter.queries

  // 20 kat daha fazla satir icin sorgu sayisi AYNI kalmali.
  assert.equal(
    largeQueries, smallQueries,
    `N+1: pageSize=10 → ${smallQueries} sorgu, pageSize=200 → ${largeQueries}`,
  )
  // Sabit sayida sorgu: sayfa + satirlar + toplam. Ust sinir cömert tutuldu.
  assert.ok(smallQueries <= 6, `sabit sorgu sayisi beklenir, ${smallQueries}`)
})

/* ═══ OKUNAN SATIR SINIRLI ═══════════════════════════════════════════ */

test('B2-2: sayfalama okunan satiri SINIRLAR', async () => {
  const { db, organizationId } = await seeded()
  const page = await orderService.listOrders(db, organizationId, { pageSize: 25 })
  assert.equal(page.orders.length, 25, 'sayfa boyutu ASILMAZ')
  // Toplam, sayfadan BAGIMSIZ gercek sayimdir.
  assert.equal(page.total, SEED_COUNT)
  assert.equal(page.pageSize, 25)
})

test('B2-3: sayfa boyutu ust sinira KELEPCELENIR', async () => {
  const { db, organizationId } = await seeded()
  const page = await orderService.listOrders(
    db, organizationId, { pageSize: 100000 },
  )
  // Istemci sinirsiz sayfa TALEP EDEMEZ.
  assert.ok(page.pageSize <= SEED_COUNT || page.pageSize < 100000,
    `sinirsiz sayfa boyutu kabul edildi: ${page.pageSize}`)
  assert.ok(page.orders.length <= page.pageSize)
})

/* ═══ SAYFALAMA TUTARLI ══════════════════════════════════════════════ */

test('B2-4: ardisik sayfalar AYNI kaydi tekrarlamaz', async () => {
  const { db, organizationId } = await seeded()
  const first = await orderService.listOrders(
    db, organizationId, { page: 1, pageSize: 50 },
  )
  const second = await orderService.listOrders(
    db, organizationId, { page: 2, pageSize: 50 },
  )
  const ids = new Set(first.orders.map((o) => o.packageId))
  const overlap = second.orders.filter((o) => ids.has(o.packageId))
  assert.equal(overlap.length, 0, `sayfalar ortusuyor: ${overlap.length}`)
  assert.equal(first.total, second.total, 'toplam sayfaya gore DEGISMEZ')
})

/* ═══ DASHBOARD/ANALİTİK OKUMASI ═════════════════════════════════════ */

test('B2-5: analitik okumasi satir sayisindan BAGIMSIZ sorgu kullanir', async () => {
  const { db, counter, organizationId } = await seeded()
  const range = {
    startMs: Date.parse('2026-07-01T00:00:00Z'),
    endMs: Date.parse('2026-08-01T00:00:00Z'),
  }
  const rows = await orderService.listOrdersForAnalytics(db, organizationId, range)
  assert.equal(rows.length, SEED_COUNT, 'aralik icindeki TUM kayitlar gelir')
  // Satis toplami CAP'SIZ olmali (eksik sayim yanlis ciro demektir), ama
  // sorgu sayisi sabit kalmali: siparisler + satirlar.
  assert.ok(
    counter.queries <= 4,
    `analitik yolunda N+1: ${counter.queries} sorgu / ${rows.length} satir`,
  )
})

test('B2-6: analitik okumasi tarih araligiyla SINIRLIDIR', async () => {
  const { db, organizationId } = await seeded()
  const empty = await orderService.listOrdersForAnalytics(db, organizationId, {
    startMs: Date.parse('2020-01-01T00:00:00Z'),
    endMs: Date.parse('2020-02-01T00:00:00Z'),
  })
  // Aralik disi kayitlar OKUNMAZ — sinir gercektir, dekoratif degil.
  assert.equal(empty.length, 0)
})
