import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// ═══ TRENDYOL_HIGH_VOLUME_AUTO_LABEL_PRODUCT_E2E ════════════════════════
//
// Ürünün ASIL vaadi: yüksek hacimli bir satıcı sabah gelir, siparişler
// çekilmiştir, etiketler hazırdır. Bu dosya o zinciri UÇTAN UCA sürer:
//
//   pazaryeri akışı → yerel kalıcılık → iş kuyruğu → worker → etiket
//
// ═══ SINIRLAR (İHLAL EDİLİRSE TEST DÜŞER) ═══════════════════════════════
//   • GERÇEK Sürat çağrısı YOK — create enjekte edilir.
//   • GERÇEK Trendyol çağrısı YOK — stream `fetchJson` enjekte edilir.
//   • Aynı paket İKİ KEZ create edilemez (kuyruk tekilliği VERİTABANINDA).
//   • Ağ geçildikten sonra belirsizlik → iş BİR DAHA TALEP EDİLMEZ.
//   • Otomatik etiket VARSAYILAN KAPALI.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

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

const PACKAGE_COUNT = 250

async function seedOrg(db) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'hacim', slug: `hacim-${randomBytes(4).toString('hex')}` })
    .returning()
  const rows = Array.from({ length: PACKAGE_COUNT }, (_, index) => ({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: `HV-${index}`,
    orderNumber: `ORD-${index}`,
    orderDate: new Date('2026-08-20T00:00:00.000Z'),
    operationStatus: 'NEW',
  }))
  for (let index = 0; index < rows.length; index += 250) {
    await db.insert(schema.orders).values(rows.slice(index, index + 250))
  }
  return org.id
}

test('HV-1: otomatik etiket VARSAYILAN KAPALI', async () => {
  const policy = await load('/server/shipments/suratAutoLabelPolicy.ts')
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const stream = await load('/server/marketplaces/trendyolStreamScheduler.ts')

  assert.equal(policy.AUTO_LABEL_DEFAULT_ENABLED, false)
  // Bayraksız ortamda hiçbir zamanlayıcı KURULMAZ: boot'ta taşıyıcı veya
  // pazaryeri çağrısı olmaz.
  assert.equal(worker.isLabelWorkerEnabled({}), false)
  assert.equal(stream.isStreamSchedulerEnabled({}), false)
  assert.equal(
    worker.startLabelJobScheduler({ runCycle: async () => {}, env: {} }),
    false,
  )
  assert.equal(
    stream.startTrendyolStreamScheduler({ runCycle: async () => {}, env: {} }),
    false,
  )
})

test('HV-2: 250 paket kuyruga TEK KEZ girer (mukerrer talep yok)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await seedOrg(db)

  const enqueueAll = async () => {
    let inserted = 0
    for (let index = 0; index < PACKAGE_COUNT; index += 1) {
      const result = await queue.enqueueLabelJob(db, {
        organizationId,
        marketplace: 'Trendyol',
        carrier: 'surat',
        packageId: `HV-${index}`,
      })
      if (result.enqueued) inserted += 1
    }
    return inserted
  }

  assert.equal(await enqueueAll(), PACKAGE_COUNT)
  // AYNI tur tekrar çalışsa (webhook + stream + elle yenileme) ikinci bir
  // iş DOĞMAZ: tekillik veritabanı kısıtındadır.
  assert.equal(await enqueueAll(), 0)

  const stats = await queue.labelJobStats(db, organizationId)
  assert.equal(stats.QUEUED, PACKAGE_COUNT)
})

test('HV-3: worker 250 paketi SINIRLI eszamanlilikla bitirir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const policy = await load('/server/shipments/suratAutoLabelPolicy.ts')
  const organizationId = await seedOrg(db)

  for (let index = 0; index < PACKAGE_COUNT; index += 1) {
    await queue.enqueueLabelJob(db, {
      organizationId, marketplace: 'Trendyol', carrier: 'surat',
      packageId: `HV-${index}`,
    })
  }

  // create ENJEKTE EDİLİR: gerçek Sürat çağrısı YOKTUR.
  const created = new Set()
  let maxObserved = 0
  let active = 0
  const runLabel = async (job) => {
    active += 1
    maxObserved = Math.max(maxObserved, active)
    try {
      // AYNI paket için ikinci create ÇAĞRISI olmamalı.
      assert.equal(created.has(job.packageId), false, `mukerrer: ${job.packageId}`)
      created.add(job.packageId)
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    } finally {
      active -= 1
    }
  }

  let totalReady = 0
  let carrierCalls = 0
  for (let cycle = 0; cycle < 20 && totalReady < PACKAGE_COUNT; cycle += 1) {
    const report = await worker.runLabelJobCycle({
      db, workerId: `w-${cycle}`, batchSize: 50, runLabel,
    })
    if (report.claimed === 0) break
    totalReady += report.ready
    carrierCalls += report.carrierCalls
    assert.ok(
      report.maxConcurrentObserved <= policy.AUTO_LABEL_CONCURRENCY.global,
      `eszamanlilik ${report.maxConcurrentObserved}`,
    )
  }

  assert.equal(totalReady, PACKAGE_COUNT)
  assert.equal(created.size, PACKAGE_COUNT)
  // PAKET BASINA TAM BIR taşıyıcı çağrısı — ne eksik ne fazla.
  assert.equal(carrierCalls, PACKAGE_COUNT)
  assert.ok(maxObserved <= policy.AUTO_LABEL_CONCURRENCY.global)

  const stats = await queue.labelJobStats(db, organizationId)
  assert.equal(stats.QUEUED ?? 0, 0)
  // Her iş TERMİNAL bir durumda biter; hiçbiri havada kalmaz.
  assert.equal(
    Object.values(stats).reduce((total, value) => total + value, 0),
    PACKAGE_COUNT,
  )
})

test('HV-4: ag sinirindan SONRA belirsizlik → is BIR DAHA talep EDILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const organizationId = await seedOrg(db)

  await queue.enqueueLabelJob(db, {
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId: 'HV-0',
  })

  let attempts = 0
  const runLabel = async () => {
    attempts += 1
    // Ağ GEÇİLDİ, sonuç BİLİNMİYOR — ikinci gönderi riski burada doğar.
    throw new Error('baglanti koptu')
  }
  const first = await worker.runLabelJobCycle({
    db, workerId: 'w1', batchSize: 10, runLabel,
  })
  assert.equal(first.unknownAfterNetwork, 1)

  // Worker yeniden başlasa bile bu iş TALEP EDİLMEZ: ikinci gönderi yaratmak
  // geri alınamaz ve faturalanabilir bir hatadır.
  const second = await worker.runLabelJobCycle({
    db, workerId: 'w2', batchSize: 10,
    staleLockMs: 1, runLabel,
  })
  assert.equal(second.claimed, 0)
  assert.equal(attempts, 1)
})

test('HV-5: stream turu YEREL kalicilikla ayni yoldan yazar', async () => {
  const stream = await load('/server/marketplaces/trendyolOrderStream.ts')
  // Pencere SABİT kalmalı: parmak izi her turda değişseydi imleç her tur
  // atılır ve zincir hiç sürdürülemezdi.
  const windows = stream.planStreamWindows({ nowMs: Date.UTC(2026, 7, 27) })
  const last = windows.at(-1)
  const filters = {
    startDate: last.startDate,
    endDate: last.endDate,
    size: stream.TRENDYOL_STREAM_MAX_SIZE,
  }
  assert.equal(
    stream.streamFilterFingerprint(filters),
    stream.streamFilterFingerprint({ ...filters }),
  )

  // Zincir: iki sayfa, sonra biter. GERÇEK Trendyol çağrısı YOK.
  const pages = [
    { content: [{ shipmentPackageId: 1 }], nextCursor: 'c1', hasMore: true },
    { content: [{ shipmentPackageId: 2 }], nextCursor: null, hasMore: false },
  ]
  let call = 0
  const result = await stream.runTrendyolStream({
    baseUrl: 'https://example.invalid',
    sellerId: '277221',
    filters,
    fetchJson: async () => ({ ok: true, body: pages[call++] }),
    delay: async () => {},
    minIntervalMs: 0,
  })
  assert.equal(result.pages, 2)
  assert.equal(result.packages.length, 2)
  assert.equal(result.stopReason, 'NO_MORE_PAGES')
})

test('HV-6: worker create ORKESTRASYONUNU yeniden yazmaz', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Arka plan yolu, elle basılan butonun çağırdığı AYNI handler'ı sürer.
  // İkinci bir create yazılsaydı zamanla butondan ayrışır ve faturalama /
  // kimlik güvenceleri yalnız birinde kalırdı.
  assert.match(source, /runLabelJobViaCreateHandler/)
  const start = source.indexOf('async function runLabelJobViaCreateHandler')
  assert.ok(start > 0)
  const body = source.slice(start, source.indexOf('async function startLabelJobWorkerOnBoot'))
  assert.match(body, /withSuratTracePersistence\(createSuratShipment\)/)
  // Worker KENDİ taşıyıcı istemcisini kurmaz.
  for (const forbidden of [
    'createSuratSoapPrimaryShipment',
    'OrtakBarkodOlustur',
    'services.asmx',
  ]) {
    assert.ok(!body.includes(forbidden), `worker icinde ${forbidden} bulundu`)
  }
  // Zamanlayıcılar boot'ta KURULUR ve kapanışta DURDURULUR.
  assert.match(source, /void startLabelJobWorkerOnBoot\(\)/)
  assert.match(source, /void startTrendyolStreamSyncOnBoot\(\)/)
  assert.match(source, /worker\.stopLabelJobScheduler\(\)/)
  assert.match(source, /scheduler\.stopTrendyolStreamScheduler\(\)/)
})

test('HV-7: stream imleci VERITABANINDA, diger ayarlar KORUNUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const repo = await load('/server/labels/labelTemplateRepository.ts')
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'cp', slug: `cp-${randomBytes(4).toString('hex')}` })
    .returning()

  // Önce etiket şablonu yazılır…
  await repo.saveLabelTemplate(
    db, org.id, [{ key: 'orderTime', label: 'x', visible: true, order: 1 }],
    '2026-08-27T10:00:00.000Z',
  )
  // …sonra stream imleci AYNI JSONB'ye MERGE edilir.
  await db
    .update(schema.organizationSettings)
    .set({
      settingsJson: {
        ...(await db.select().from(schema.organizationSettings)
          .where(eq(schema.organizationSettings.organizationId, org.id))
          .limit(1))[0].settingsJson,
        trendyolStreamCheckpoint: { cursor: 'c1', status: 'PAGE_LIMIT_REACHED' },
      },
    })
    .where(eq(schema.organizationSettings.organizationId, org.id))

  const rows = await db.select().from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, org.id)).limit(1)
  assert.equal(rows[0].settingsJson.trendyolStreamCheckpoint.cursor, 'c1')
  // Şablon SİLİNMEDİ.
  assert.ok(rows[0].settingsJson.labelTemplate)
  const template = await repo.loadLabelTemplate(db, org.id)
  assert.equal(template.fields.length, 1)
})

test('HV-8: sentetik istek/yanit SOZLESMESI create yolunu karsilar', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const lines = source.split(/\r?\n/)

  // Worker gercek Express nesnesi VEREMEZ; sentetik bir cift verir. Create
  // yolu ileride `response.setHeader` gibi yeni bir API kullanmaya baslarsa
  // arka plan etiket uretimi CALISMA ZAMANINDA patlardi ve bunu ancak canli
  // bir paket harcayarak ogrenirdik. Bu yuzden kullanilan API yuzeyi
  // sentetik ciftin SAGLADIGI ile sinirli tutulur.
  const PROVIDED_RESPONSE = new Set(['json', 'status'])
  const PROVIDED_REQUEST = new Set(['auth', 'body', 'query', 'headers'])

  // `toName` verilmezse fonksiyonun kendi kapanis satirina kadar okunur.
  const collect = (fromName, toName) => {
    const start = lines.findIndex((line) => line.startsWith(fromName))
    const end = toName
      ? lines.findIndex((line, index) => index > start && line.startsWith(toName))
      : lines.findIndex((line, index) => index > start && line === '}')
    assert.ok(start >= 0 && end > start, `${fromName} bulunamadi`)
    return lines.slice(start, end).join('\n')
  }

  const body = [
    collect('async function createSuratShipment(', 'async function createSuratShipmentCore'),
    collect('async function createSuratShipmentCore', 'async function createSuratLabelForRegisteredShipment'),
    collect('async function persistSuratTraceAttempt'),
  ].join('\n')

  for (const match of body.match(/response\.[a-zA-Z]+/g) ?? []) {
    const name = match.split('.')[1]
    assert.ok(
      PROVIDED_RESPONSE.has(name),
      `create yolu response.${name} kullaniyor; sentetik yanit bunu SAGLAMIYOR`,
    )
  }
  for (const match of body.match(/request\.[a-zA-Z]+/g) ?? []) {
    const name = match.split('.')[1]
    assert.ok(
      PROVIDED_REQUEST.has(name),
      `create yolu request.${name} kullaniyor; sentetik istek bunu SAGLAMIYOR`,
    )
  }

  // Sentetik cift gercekten bu alanlari SAGLIYOR olmali.
  const workerBody = collect(
    'async function runLabelJobViaCreateHandler',
    'async function startLabelJobWorkerOnBoot',
  )
  assert.match(workerBody, /auth: \{ organizationId \}/)
  assert.match(workerBody, /status\(code\)/)
  assert.match(workerBody, /json\(body\)/)
})

test('HV-9: worker HAZIRLIGI kanonik labelState alanindan okur', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function runLabelJobViaCreateHandler'),
  )
  const end = lines.findIndex((line, index) =>
    index > start && line.startsWith('async function startLabelJobWorkerOnBoot'),
  )
  const body = lines.slice(start, end).join('\n')

  // OTORITE: `labelState` (READY | GENERATING | FAILED). `ok` zaten ondan
  // turetilir. `zpl`/`barcodeRaw` gibi turev alanlara bakmak, yanit sekli
  // degistiginde sessizce "hazir degil" demeye baslardi.
  assert.match(body, /payload\?\.labelState/)
  assert.match(body, /labelState === 'READY'/)
  assert.ok(!body.includes('payload?.barcodeRaw'), 'turev alan okunuyor')
  // Tasiyici cagrisi sayisi da kanonik adiyla tasinir.
  assert.match(body, /carrierCreateAttempts/)
  assert.ok(!body.includes('payload?.carrierCalls'), 'olmayan alan okunuyor')
})
