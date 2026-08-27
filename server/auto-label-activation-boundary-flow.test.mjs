import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ AKTİVASYON SINIRI — ÜRETİCİ SEVİYESİNDE ════════════════════════════
//
// KANITLANMIŞ BOŞLUK: üretim kodunda `enqueueLabelJob` çağıran TEK BİR YER
// yoktu. Kuyruk, worker ve politika hazırdı ama ÜRETİCİ yoktu; yani
// LABEL_WORKER_ENABLED=true yapılsaydı hiçbir etiket üretilmeyecekti.
//
// EN KRİTİK RİSK: üretici eklenirken bayrak açıldığı anda GEÇMİŞ YIĞININ
// tamamının sıraya girmesi. Bu, tek bir ayar değişikliğiyle binlerce
// GERİ ALINAMAZ ve FATURALANABİLİR Sürat etiketi demektir.
//
// Bu dosya sınırın SQL seviyesinde uygulandığını kanıtlar: sınırdan önceki
// paketler Node'a bile GELMEZ.
//
// TAŞIYICI ÇAĞRISI YOKTUR: yalnız yerel kayıt okunur, iş satırı yazılır.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}

const ACTIVATED_AT = '2026-08-28T00:00:00.000Z'
const BACKLOG = 120
const FRESH = 3

/** Sınırdan ÖNCE 120 paket (geçmiş yığın), SONRA 3 paket (yeni). */
async function seedTenant(db) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'tarzim', slug: `tarzim-${randomBytes(4).toString('hex')}` })
    .returning()

  const rows = []
  for (let index = 0; index < BACKLOG; index += 1) {
    rows.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId: `OLD-${index}`,
      orderNumber: `ORD-OLD-${index}`,
      orderDate: new Date('2026-08-20T00:00:00.000Z'),
      cargoTrackingNumber: `72700${index}`,
      operationStatus: 'NEW',
      firstSeenAt: new Date('2026-08-20T00:00:00.000Z'),
    })
  }
  for (let index = 0; index < FRESH; index += 1) {
    rows.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId: `NEW-${index}`,
      orderNumber: `ORD-NEW-${index}`,
      orderDate: new Date('2026-08-28T06:00:00.000Z'),
      cargoTrackingNumber: `72799${index}`,
      operationStatus: 'NEW',
      firstSeenAt: new Date('2026-08-28T06:00:00.000Z'),
    })
  }
  await db.insert(schema.orders).values(rows)
  return org.id
}

test('BOUNDARY-1: uretici ACILMADAN once HICBIR is yaratmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const producer = await load('/server/shipments/autoLabelProducer.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await seedTenant(db)

  // Ayar YOK → sınır yok → hiçbir paket TARANMAZ.
  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(report.examined, 0)
  assert.equal(report.enqueued, 0)
  assert.equal(report.boundaryMs, null)
  assert.deepEqual(await queue.labelJobStats(db, organizationId), {})
})

test('BOUNDARY-2: aktivasyon SONRASI yalniz YENI paketler siraya girer', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const producer = await load('/server/shipments/autoLabelProducer.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await seedTenant(db)

  await producer.activateAutoLabel(db, organizationId, {
    marketplaces: ['trendyol'],
    carriers: ['surat'],
    now: ACTIVATED_AT,
  })
  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)

  // KÖK KANIT: 120 geçmiş paket Node'a BİLE GELMEZ (sınır SQL'de).
  assert.equal(report.examined, FRESH, 'gecmis yigin taranmis!')
  assert.equal(report.enqueued, FRESH)
  const stats = await queue.labelJobStats(db, organizationId)
  assert.equal(stats.QUEUED, FRESH)

  // Kuyruktaki işlerin HEPSİ sınır sonrası paketlerdir.
  const jobs = await db.select().from(schema.labelJobs)
  assert.equal(jobs.length, FRESH)
  for (const job of jobs) {
    assert.ok(String(job.packageId).startsWith('NEW-'), job.packageId)
  }
})

test('BOUNDARY-3: uretici IKI KEZ calissa da mukerrer is DOGMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const producer = await load('/server/shipments/autoLabelProducer.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await seedTenant(db)
  await producer.activateAutoLabel(db, organizationId, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
  })

  const first = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  const second = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(first.enqueued, FRESH)
  // İkinci turda TEK BİR yeni iş bile doğmaz — tekillik veritabanındadır.
  assert.equal(second.enqueued, 0)
  assert.equal(second.blocked.ALREADY_QUEUED, FRESH)
  const stats = await queue.labelJobStats(db, organizationId)
  assert.equal(stats.QUEUED, FRESH)
})

test('BOUNDARY-4: aktivasyon ayari DIGER ayarlari SILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const producer = await load('/server/shipments/autoLabelProducer.ts')
  const repo = await load('/server/labels/labelTemplateRepository.ts')
  const organizationId = await seedTenant(db)

  await repo.saveLabelTemplate(
    db, organizationId,
    [{ key: 'orderTime', label: 'Sipariş Saati', visible: true, order: 1 }],
    '2026-08-27T10:00:00.000Z',
  )
  await producer.activateAutoLabel(db, organizationId, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
  })

  const template = await repo.loadLabelTemplate(db, organizationId)
  assert.equal(template.fields.length, 1, 'etiket sablonu SILINDI')
  const settings = await producer.loadAutoLabelSettings(db, organizationId)
  assert.equal(settings.enabled, true)
  assert.equal(settings.activatedAt, ACTIVATED_AT)
})

test('BOUNDARY-5: acmadan ONCE kac paket etkilenecegi SAYILABILIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const producer = await load('/server/shipments/autoLabelProducer.ts')
  const organizationId = await seedTenant(db)

  // Operatör "şimdi açarsam kaç etiket üretilir?" sorusunu ÖNCEDEN sorabilir.
  const now = Date.parse(ACTIVATED_AT)
  assert.equal(
    await producer.countAutoLabelCandidates(db, organizationId, now),
    FRESH,
  )
  // Sınırı geriye çekmek geçmiş yığını KAPSAR — bu yüzden sınır ileri alınır.
  assert.equal(
    await producer.countAutoLabelCandidates(
      db, organizationId, Date.parse('2026-08-01T00:00:00.000Z'),
    ),
    BACKLOG + FRESH,
  )
})

test('BOUNDARY-6: tek turda sinirsiz yigin ISLENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const producer = await load('/server/shipments/autoLabelProducer.ts')
  assert.ok(producer.AUTO_LABEL_PRODUCER_BATCH > 0)
  assert.ok(
    producer.AUTO_LABEL_PRODUCER_BATCH <= 500,
    'tur basina parti fazla buyuk',
  )
})

test('BOUNDARY-7: URETICI calisma zamanina BAGLI (senkron sonrasi)', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  // KANITLANMIS BOSLUK: bir tur uretim kodunda enqueueLabelJob cagiran TEK
  // BIR YER yoktu; worker acilsa bile hicbir etiket uretilmezdi.
  assert.match(source, /enqueueEligibleAutoLabelJobs/)
  assert.match(source, /enqueueAutoLabelAfterSync/)
  // HEM durum senkronu HEM akis senkronu besler.
  const calls = source.split('await enqueueAutoLabelAfterSync(').length - 1
  assert.ok(calls >= 2, `uretici yalniz ${calls} yerde cagriliyor`)
  // Uretici SENKRON AKISINI BOZMAZ (best-effort).
  const start = source.indexOf('async function enqueueAutoLabelAfterSync')
  const body = source.slice(start, source.indexOf('async function syncTrendyolOrdersForOrganization'))
  assert.match(body, /catch/)
})
