// PRINT-PLATFORM-001 — KABUL PAKETİ.
//
// ═══ ÜÇ SORUMLULUK AYRI KANITLANIR ═══════════════════════════════════════
//
//   ARTEFAKT : hangi DEĞİŞMEZ sayfalar (kalıcı baytlar, sıra, hash, ölçü)
//   TAŞIMA   : o sayfalar NASIL gider (yetenek, iş kuralı YOK)
//   YÜRÜTME  : hangi kalemler GERÇEKTEN gönderildi (dürüst durum)
//
// ═══ ÖLÇÜLEN İKİ KUSUR ═══════════════════════════════════════════════════
//
//  D1 GÜVEN SINIRI: eski ham uç `labels[].zpl` alanını İSTEMCİDEN alıp
//     doğrudan sunucu tarafı yazıcı komutuna veriyordu. Kimlik doğrulanmış
//     bir tarayıcı KENDİ uydurduğu ZPL'i "taşıyıcı etiketi" diye
//     bastırabiliyordu; kiracı kapsamı hiç okunmuyordu.
//
//  D2 SAHTE BAŞARI: yazıcı adı geçersizken PowerShell stderr'e .NET
//     istisnası yazıyor ama EXIT 0 dönüyordu. Sunucu bunu BAŞARI sayıyor,
//     uydurma bir UUID'yi `printJobId` diye döndürüyor ve sipariş
//     "Etiket Basıldı" işaretleniyordu — hiçbir şey yazıcıya gitmemişken.
//
// ═══ TAŞIYICIYA/PAZARYERİNE ÇAĞRI YOK ════════════════════════════════════
//
// Paket boyunca ağ TUZAKLANIR: bir tek çağrı bile testi düşürür.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

/* ═══ AĞ TUZAĞI ═══════════════════════════════════════════════════════ */

const networkCalls = []
const realFetch = globalThis.fetch
globalThis.fetch = (...args) => {
  networkCalls.push(String(args[0]?.url ?? args[0] ?? ''))
  throw new Error('AĞ ÇAĞRISI YASAK: baskı yolu sağlayıcıya ÇIKMAZ.')
}
after(() => {
  globalThis.fetch = realFetch
})

const schema = await import('./db/schema.ts')
const printRepo = await import('./shipments/printZplRepository.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')
const orderEncryption = await import('./orders/orderEncryption.ts')
const model = await import('./printing/printArtifactModel.ts')
const geometry = await import('./printing/printSourceGeometry.ts')
const resolver = await import('./printing/printArtifactResolver.ts')
const transport = await import('./printing/printTransport.ts')
const rawTransport = await import('./printing/windowsRawTransport.ts')
const jobService = await import('./printing/printJobService.ts')

/**
 * FRONTEND MODÜL YÜKLEYİCİSİ.
 *
 * `officialSuratPrintDocument.ts` kardeş modülü UZANTISIZ import eder
 * (Vite çözer, node ÇÖZMEZ). Bu yüzden o modül üretimdeki AYNI çözücüyle
 * (Vite SSR) yüklenir; kopya bir sürüm YAZILMAZ.
 */
let _vite
async function loadFrontend(path) {
  if (!_vite) {
    const { createServer } = await import('vite')
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

const REAL_ZPL = readFileSync(
  join(root, 'server', 'fixtures', 'surat-real-success-11415535074.zpl'),
  'utf8',
)
const REAL_TRACKING = '11415535074'

const ITEMS = [
  { productName: 'Sweatshirt', quantity: 2, color: 'Lacivert', size: 'M', sku: 'S-1' },
  { productName: 'Kot Pantolon', quantity: 1, color: 'Siyah', size: '40', sku: 'S-2' },
]

function stripComments(source) {
  return source
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

function migrationStatements() {
  const dir = join(root, 'drizzle')
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
  return { pglite, db }
}

async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug: `${slug}-${randomBytes(3).toString('hex')}` })
    .returning()
  return org.id
}

/** GERÇEK kalıcı artefaktı tohumlar (taşıyıcıya çağrı YOK). */
async function seedShipment(db, organizationId, options = {}) {
  const { analyzeSuratZpl } = await import('../src/utils/suratZplAnalysis.ts')
  const analysis = analyzeSuratZpl(REAL_ZPL)
  const barcode = analysis.acceptedFinalBarcode
  assert.ok(barcode, 'fixture kanonik barkod taşımalı')

  const packageId = options.packageId ?? `PKG-${randomBytes(3).toString('hex')}`
  const orderNumber = options.orderNumber ?? `ORD-${packageId}`
  const payload = printRepo.attachPrintZplArtifact(
    {
      technicalZpl: REAL_ZPL,
      carrierTrackingNumber: REAL_TRACKING,
      carrierBarcodeNumber: barcode,
      ozelKargoTakipNo: barcode,
      labelStatus: 'READY',
      dispatchRegistrationConfirmed: true,
      shipment: {
        tNo: REAL_TRACKING,
        kargoTakipNo: REAL_TRACKING,
        barkodNo: barcode,
        ozelKargoTakipNo: barcode,
        barcodeRaw: REAL_ZPL,
        labelStatus: 'READY',
        printEnabled: true,
        zplReady: true,
        desi: 2,
      },
    },
    options.items ?? ITEMS,
    '2026-08-27T00:00:00.000Z',
  )

  await db.insert(schema.orders).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId,
    orderNumber,
    customerFirstName: 'Ada',
    customerLastName: 'Yılmaz',
    customerPhone: '05380000000',
    shippingCity: 'İstanbul',
    shippingDistrict: 'Kadıköy',
    shippingAddressEncrypted: orderEncryption.encryptOrderPayload({
      fullAddress: 'Örnek Mahallesi Örnek Caddesi No: 12/3',
    }),
    marketplaceStatus: 'Created',
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    operationStatus: 'LABEL_READY',
  })
  const orderRows = await db.select().from(schema.orders)
  const orderRow = orderRows.find((row) => row.packageId === packageId)

  await db.insert(schema.shipments).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId,
    orderNumber,
    provider: 'surat',
    source: 'local_create',
    status: 'created',
    trackingNumber: REAL_TRACKING,
    carrierPayloadEncrypted: encryption.encryptShipmentPayload(
      options.corruptPayload ? options.corruptPayload(payload) : payload,
    ),
  })
  return { orderId: orderRow.id, orderNumber, packageId, payload }
}

/** Kiracı kapsamlı sahte sipariş okuyucu (üretimdeki getOrder imzası). */
const getOrder = async (db, organizationId, orderId) => {
  const rows = await db.select().from(schema.orders)
  const row = rows.find(
    (item) => String(item.id) === String(orderId) && item.organizationId === organizationId,
  )
  if (!row) return null
  return { marketplace: row.marketplace, packageId: row.packageId }
}

/** Baytları KAYDEDEN sahte yürütücü. */
function recordingExecutor(outcome = null) {
  const calls = []
  return {
    calls,
    execute: async (submission) => {
      calls.push(submission)
      return outcome ?? { ok: true, printJobId: String(1000 + calls.length) }
    },
  }
}

const submit = (db, organizationId, items, executor, extra = {}) =>
  jobService.submitPrintJob(db, {
    organizationId,
    transport: 'SERVER_WINDOWS_RAW',
    printerName: 'Zebra-1',
    items,
    getOrder,
    execute: executor,
    ...extra,
  })

/* ═══════════════════════════════════════════════════════════════════════
   GEOMETRİ — KÜRESEL 100×100 VARSAYIMI YOK
   ═══════════════════════════════════════════════════════════════════════ */

test('PG-1/PG-2: Sürat sayfası KANITLANMIŞ ölçüsünü korur, ölçü SAYFANINDIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'pg1')
  const seeded = await seedShipment(db, org)

  const resolution = await resolver.resolveCanonicalPrintArtifact(db, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: seeded.packageId,
  })
  assert.equal(resolution.ok, true)
  assert.ok(resolution.artifact.pages.length >= 1)
  for (const page of resolution.artifact.pages) {
    // ÖLÇÜ SAYFADA TAŞINIR — küresel sabitten okunmaz.
    assert.deepEqual(page.geometry, { widthMm: 100, heightMm: 100, dpi: 203 })
  }
})

test('PG-3: platformda KÜRESEL sayfa ölçüsü sabiti YOK', () => {
  const modelSource = stripComments(
    readFileSync(join(here, 'printing', 'printArtifactModel.ts'), 'utf8'),
  )
  // Model ölçü DEĞERİ taşımaz; yalnız ölçünün ŞEKLİNİ tanımlar.
  assert.equal(/100/.test(modelSource), false, 'modele ölçü sabiti sızdı')
  assert.match(modelSource, /widthMm/)
  assert.match(modelSource, /heightMm/)

  // Bilinmeyen kaynak için ölçü UYDURULMAZ (varsayılan 100×100 YOK).
  assert.equal(geometry.geometryForSource('gelecek_tasiyici'), null)
  assert.equal(geometry.geometryForSource(''), null)
  // Kanıtlanmış kaynak KENDİ ölçüsünü bildirir.
  assert.deepEqual(geometry.geometryForSource('surat_persisted_print_bundle'), {
    widthMm: 100,
    heightMm: 100,
    dpi: 203,
  })
  // Aras/ikas/Ticimax ölçüsü UYDURULMADI.
  const geometrySource = stripComments(
    readFileSync(join(here, 'printing', 'printSourceGeometry.ts'), 'utf8'),
  )
  for (const forbidden of ['aras', 'ikas', 'ticimax']) {
    assert.equal(geometrySource.toLowerCase().includes(forbidden), false)
  }
})

test('PG-4/PRINT-6: ÇOK SAYFA sırası DEĞİŞMEZ (taşıyıcı ilk, detaylar 1..N)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'pg4')
  const seeded = await seedShipment(db, org)

  const resolution = await resolver.resolveCanonicalPrintArtifact(db, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: seeded.packageId,
  })
  const pages = resolution.artifact.pages
  assert.equal(pages[0].kind, 'carrier')
  assert.equal(pages[0].index, 0)
  for (const [position, page] of pages.entries()) {
    assert.equal(page.index, position, 'indeks konumla BİREBİR')
    if (position > 0) assert.equal(page.kind, 'product_detail')
  }
  assert.equal(model.isCanonicalPageOrder(pages), true)

  // ═══ SIRA DENETİMİ SENTETİK ÜÇ SAYFAYLA KANITLANIR ══════════════════
  //
  // (İlk yazımda gerçek artefaktın sayfalarını DÖNDÜRÜP sıra bozulmasını
  //  ölçüyordum. Artefakt TEK sayfalıysa döndürme NO-OP olur ve iddia
  //  hiçbir şey kanıtlamaz — test zayıftı, düzeltildi.)
  const box = { widthMm: 100, heightMm: 100, dpi: 203 }
  const synthetic = [
    { index: 0, kind: 'carrier', contentKind: 'ZPL', content: 'C', sha256: null, geometry: box },
    { index: 1, kind: 'product_detail', contentKind: 'ZPL', content: 'D1', sha256: null, geometry: box },
    { index: 2, kind: 'product_detail', contentKind: 'ZPL', content: 'D2', sha256: null, geometry: box },
  ]
  assert.equal(model.isCanonicalPageOrder(synthetic), true)
  // YENİDEN SIRALAMA yakalanır.
  assert.equal(
    model.isCanonicalPageOrder([synthetic[2], synthetic[0], synthetic[1]]),
    false,
  )
  // SAYFA DÜŞÜRME yakalanır (indeksler konumla uyuşmaz).
  assert.equal(model.isCanonicalPageOrder([synthetic[0], synthetic[2]]), false)
  // ÇOĞALTMA yakalanır (ikinci taşıyıcı sayfa).
  assert.equal(
    model.isCanonicalPageOrder([synthetic[0], { ...synthetic[1], kind: 'carrier' }]),
    false,
  )
  // BOŞ iş geçerli DEĞİLDİR.
  assert.equal(model.isCanonicalPageOrder([]), false)

  // Taşıma sayfaları KALICI SIRADA alır.
  const executor = recordingExecutor()
  await submit(db, org, [{ orderId: seeded.orderId }], executor.execute)
  const sent = executor.calls[0].content
  let cursor = -1
  for (const page of pages) {
    const at = sent.indexOf(page.content)
    assert.ok(at > cursor, 'sayfa sırası taşımada KORUNMALI')
    cursor = at
  }
})

test('PG-5/PRINT-11: HASH UYUŞMAZLIĞI taşımadan ÖNCE fail-closed', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'pg5')
  const seeded = await seedShipment(db, org, {
    // Kalıcı baytlar BOZULUR; özet ESKİ kalır.
    corruptPayload: (payload) => {
      const copy = JSON.parse(JSON.stringify(payload))
      const artifact = copy.printZplArtifact ?? copy.shipment?.printZplArtifact
      if (artifact) artifact.printZpl = `${artifact.printZpl}\n^XA^FDBOZUK^FS^XZ`
      return copy
    },
  })

  const executor = recordingExecutor()
  const result = await submit(db, org, [{ orderId: seeded.orderId }], executor.execute)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.items[0].status, 'FAILED')
  assert.ok(
    ['ARTIFACT_HASH_MISMATCH', 'ARTIFACT_NOT_READY'].includes(result.items[0].failure),
    `beklenmeyen sebep: ${result.items[0].failure}`,
  )
  // ONARIM YOK ve TAŞIMA HİÇ ÇAĞRILMADI.
  assert.equal(executor.calls.length, 0)
})

/* ═══════════════════════════════════════════════════════════════════════
   SUNUCU YETKİLİ ÇÖZÜM + KİRACI İZOLASYONU
   ═══════════════════════════════════════════════════════════════════════ */

test('RAW-2/PRINT-12/PRINT-13: KİMLİK → sunucu çözer, taşıma SUNUCU BAYTLARINI alır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'raw2')
  const seeded = await seedShipment(db, org)

  const resolution = await resolver.resolveCanonicalPrintArtifact(db, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: seeded.packageId,
  })
  const executor = recordingExecutor()
  const result = await submit(db, org, [{ orderId: seeded.orderId }], executor.execute)

  assert.equal(result.status, 'SUBMITTED')
  assert.equal(executor.calls.length, 1)
  // TAŞIMAYA GİDEN BAYTLAR = SUNUCUDA ÇÖZÜLEN KALICI SAYFALAR.
  assert.equal(
    executor.calls[0].content,
    resolution.artifact.pages.map((page) => page.content).join('\n'),
  )
  // KANONİK `printZpl` VARKEN technicalZpl'e DÜŞÜLMEZ: gönderilen içerik
  // kalıcı artefaktın ta kendisidir, ham kaynak kopyası değil.
  assert.equal(resolution.artifact.ownership, 'SERVER_AUTHORITATIVE')
  assert.equal(resolution.artifact.source, 'surat_persisted_print_bundle')
  assert.equal(networkCalls.length, 0)
})

test('PRINT-10/RAW-3: BAŞKA KİRACININ siparişi basılamaz, süreç HİÇ çalışmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'tenant-a')
  const orgB = await makeOrg(db, 'tenant-b')
  const seeded = await seedShipment(db, orgB)

  const executor = recordingExecutor()
  const result = await submit(db, orgA, [{ orderId: seeded.orderId }], executor.execute)
  assert.equal(result.status, 'FAILED')
  // "Var ama senin değil" ile "hiç yok" AYNI cevabı verir.
  assert.equal(result.items[0].failure, 'ORDER_NOT_FOUND')
  assert.equal(executor.calls.length, 0, 'yabancı kiracı için yazıcı komutu ÇALIŞMAZ')

  // Artefakt çözümü de kiracı kapsamlıdır.
  const foreign = await resolver.resolveCanonicalPrintArtifact(db, {
    organizationId: orgA,
    marketplace: 'Trendyol',
    packageId: seeded.packageId,
  })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.failure, 'SHIPMENT_NOT_FOUND')
})

test('RAW-4: HAZIR OLMAYAN artefakt → yazıcı komutu ÇALIŞMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'raw4')
  // Gönderi kaydı YOK: sipariş var ama artefakt yok.
  await db.insert(schema.orders).values({
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: 'PKG-BOS',
    orderNumber: 'ORD-BOS',
    marketplaceStatus: 'Created',
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
  })
  const rows = await db.select().from(schema.orders)
  const orderId = rows.find((row) => row.packageId === 'PKG-BOS').id

  const executor = recordingExecutor()
  const result = await submit(db, org, [{ orderId }], executor.execute)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.items[0].failure, 'SHIPMENT_NOT_FOUND')
  assert.equal(executor.calls.length, 0)
})

/* ═══════════════════════════════════════════════════════════════════════
   YENİDEN BASKI DEĞİŞMEZLİĞİ
   ═══════════════════════════════════════════════════════════════════════ */

test('PRINT-3/4/5/14/15: YENİDEN BASKI aynı artefaktı kullanır, SAĞLAYICIYA ÇAĞRI YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'reprint')
  const seeded = await seedShipment(db, org)
  const before = networkCalls.length

  const first = await resolver.resolveCanonicalPrintArtifact(db, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: seeded.packageId,
  })
  const executorA = recordingExecutor()
  await submit(db, org, [{ orderId: seeded.orderId }], executorA.execute)

  // İKİNCİ baskı (reprint) — farklı taşıma yürütücüsü.
  const executorB = recordingExecutor()
  await submit(db, org, [{ orderId: seeded.orderId }], executorB.execute)
  const second = await resolver.resolveCanonicalPrintArtifact(db, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: seeded.packageId,
  })

  // ARTEFAKT DEĞİŞMEDİ: hash ve sayfalar BİREBİR.
  assert.equal(second.artifact.printZplSha256, first.artifact.printZplSha256)
  assert.equal(second.artifact.printZplSourceSha256, first.artifact.printZplSourceSha256)
  assert.deepEqual(
    second.artifact.pages.map((page) => page.content),
    first.artifact.pages.map((page) => page.content),
  )
  // TAŞIMA DEĞİŞSE DE ARTEFAKT AYNI (PRINT-5).
  assert.equal(executorA.calls[0].content, executorB.calls[0].content)
  // PAZARYERİ/TAŞIYICI ÇAĞRISI SIFIR (PRINT-4, PRINT-14, PRINT-15).
  assert.equal(networkCalls.length, before)
})

/* ═══════════════════════════════════════════════════════════════════════
   TOPLU YÜRÜTME — SESSİZ DÜŞME YOK
   ═══════════════════════════════════════════════════════════════════════ */

test('PRINT-7/PRINT-8/RAW-5: bir kalem bozuksa SESSİZCE DÜŞMEZ → PARTIAL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'batch')
  const good = await seedShipment(db, org, { packageId: 'PKG-OK' })
  const bad = await seedShipment(db, org, {
    packageId: 'PKG-BOZUK',
    corruptPayload: (payload) => {
      const copy = JSON.parse(JSON.stringify(payload))
      const artifact = copy.printZplArtifact ?? copy.shipment?.printZplArtifact
      if (artifact) artifact.printZplSha256 = 'f'.repeat(64)
      return copy
    },
  })

  const executor = recordingExecutor()
  const result = await submit(
    db,
    org,
    [
      { orderId: good.orderId, orderNumber: good.orderNumber },
      { orderId: bad.orderId, orderNumber: bad.orderNumber },
    ],
    executor.execute,
  )

  // MEVCUT KABUL EDİLMİŞ SİPARİŞ-BAZLI SEMANTİK: kısmi başarı, açık rapor.
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.items.length, 2, 'hiçbir kalem LİSTEDEN DÜŞMEZ')
  const okItem = result.items.find((item) => item.orderId === good.orderId)
  const badItem = result.items.find((item) => item.orderId === bad.orderId)
  assert.equal(okItem.status, 'SUBMITTED')
  assert.equal(badItem.status, 'FAILED')
  assert.ok(badItem.failure, 'başarısız kalem SEBEP taşımalı')
  // Bozuk kalem için yazıcı komutu HİÇ çalışmadı.
  assert.equal(executor.calls.length, 1)

  // MANTIKSAL "ETİKET BASILDI" TEK KARARDAN gelir ve YALNIZ başarılıyı içerir.
  const printed = jobService.resolvePrintedOrderIds(result)
  assert.deepEqual(printed, [good.orderId])

  // DETERMİNİSTİK: aynı girdi aynı sonucu verir.
  const again = await submit(
    db,
    org,
    [
      { orderId: good.orderId, orderNumber: good.orderNumber },
      { orderId: bad.orderId, orderNumber: bad.orderNumber },
    ],
    recordingExecutor().execute,
  )
  assert.equal(again.status, 'PARTIAL')
  assert.deepEqual(
    again.items.map((item) => item.status),
    result.items.map((item) => item.status),
  )
})

/* ═══════════════════════════════════════════════════════════════════════
   GÜVEN SINIRI — İSTEMCİ BAYT GÖNDEREMEZ
   ═══════════════════════════════════════════════════════════════════════ */

test('PRINT-9/RAW-1: İSTEMCİ ham ZPL ile taşıyıcı artefaktı TAKLİT EDEMEZ', () => {
  const server = stripComments(readFileSync(join(here, 'index.mjs'), 'utf8'))

  // (a) Kanonik uç YALNIZ kimlik alır ve ham ZPL'i AÇIKÇA reddeder.
  const jobsAt = server.indexOf("app.post('/api/printing/jobs'")
  assert.ok(jobsAt > 0, 'kanonik baskı işi ucu bulunmalı')
  const jobsRoute = server.slice(jobsAt, server.indexOf('\napp.', jobsAt + 10))
  assert.match(jobsRoute, /raw_zpl_not_accepted/)
  for (const forbidden of ['zpl', 'printZpl', 'technicalZpl', 'barcodeRaw', 'labels']) {
    assert.ok(
      jobsRoute.includes(`'${forbidden}'`),
      `yasak alan listesinde eksik: ${forbidden}`,
    )
  }
  // Kiracı YALNIZ auth bağlamından; gövdeden organizationId OKUNMAZ.
  assert.match(jobsRoute, /organizationId: context\.organizationId/)
  assert.equal(/body\.organizationId/.test(jobsRoute), false)

  // (b) ESKİ ham uç ARTIK BASMAZ.
  const legacyAt = server.indexOf("app.post('/api/printing/zebra/raw'")
  assert.ok(legacyAt > 0, 'eski uç kısıtlı uyumlulukla DURMALI')
  const legacyRoute = server.slice(legacyAt, server.indexOf('\napp.', legacyAt + 10))
  assert.match(legacyRoute, /raw_zpl_not_accepted/)
  assert.equal(
    /powershell\.exe/.test(legacyRoute),
    false,
    'eski uç yazıcı komutu ÇALIŞTIRMAMALI',
  )

  // (c) İş servisinin GİRDİSİNDE içerik alanı YOKTUR (yapısal güvence).
  const service = stripComments(
    readFileSync(join(here, 'printing', 'printJobService.ts'), 'utf8'),
  )
  const params = service.slice(
    service.indexOf('export interface SubmitPrintJobParams'),
    service.indexOf('}', service.indexOf('export interface SubmitPrintJobParams')),
  )
  for (const forbidden of ['zpl', 'content', 'labels', 'bytes']) {
    assert.equal(
      params.includes(forbidden),
      false,
      `iş girdisine içerik alanı sızdı: ${forbidden}`,
    )
  }
})

test('PRINT-16/17/19: TAŞIMA katmanında iş kuralı YOK, yollar birbirine SIZMAZ', () => {
  const provider = stripComments(
    readFileSync(join(root, 'src/providers/printing/BrowserDownloadPrintProvider.ts'), 'utf8'),
  )
  // Tarayıcı dalı ham yazıcı ucunu ÇAĞIRMAZ.
  const browserBranch = provider.slice(
    provider.indexOf("if (input.printerSettings.mode === 'browser-print')"),
    provider.indexOf("if (input.printerSettings.mode === 'download')"),
  )
  assert.equal(/\/api\/printing\//.test(browserBranch), false)
  // Ham dal HTML üreticisi/ürün sığdırma ÇAĞIRMAZ.
  const rawBranch = provider.slice(provider.indexOf("'/api/printing/jobs'"))
  for (const leak of [
    'buildCleanLabelDocument',
    'printCleanLabelDocument',
    'resolveProductFit',
    'resolveRouteFit',
    'resolveBrowserPrintJobs',
  ]) {
    assert.equal(rawBranch.includes(leak), false, `ham dala sızdı: ${leak}`)
  }

  // Sunucu taşıma katmanında pazaryeri/taşıyıcı dallanması YOK.
  for (const file of ['printTransport.ts', 'windowsRawTransport.ts']) {
    const source = stripComments(readFileSync(join(here, 'printing', file), 'utf8'))
    for (const forbidden of [
      'Trendyol',
      'trendyol',
      'marketplace',
      'createShipment',
      'billingParty',
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${file} taşıma katmanına iş kuralı sızdı: ${forbidden}`,
      )
    }
  }
})

/* ═══════════════════════════════════════════════════════════════════════
   YETENEK GERÇEĞİ
   ═══════════════════════════════════════════════════════════════════════ */

test('CAP-1/2/3/4: yetenek ÇALIŞMA ZAMANINDAN gelir, yazıcı adından DEĞİL', () => {
  // CAP-3: Windows değilse ham yol YOKTUR.
  const linux = transport.describeServerRawCapability({
    platform: 'linux',
    printerName: 'Zebra-1',
  })
  assert.equal(linux.available, false)
  assert.equal(linux.reason, 'RUNTIME_NOT_WINDOWS')

  // CAP-4: YALNIZ yazıcı adı "bağlı" YAPMAZ.
  const nameOnly = transport.describeServerRawCapability({
    platform: 'linux',
    printerName: 'Her ne ise',
  })
  assert.equal(nameOnly.available, false)
  const windowsNoPrinter = transport.describeServerRawCapability({
    platform: 'win32',
    printerName: '',
  })
  assert.equal(windowsNoPrinter.available, false)
  assert.equal(windowsNoPrinter.reason, 'PRINTER_NOT_SELECTED')
  const windowsReady = transport.describeServerRawCapability({
    platform: 'win32',
    printerName: 'Zebra-1',
  })
  assert.equal(windowsReady.available, true)
  assert.equal(windowsReady.supportsZpl, true)
  assert.equal(windowsReady.supportsMultiPage, true)

  // CAP-1/CAP-2: tarayıcı ve indirme BAĞIMSIZDIR ve istemcide yaşar.
  const browser = transport.describeClientTransport('BROWSER_PRINT', 'browser')
  const download = transport.describeClientTransport('DOWNLOAD', 'browser')
  assert.equal(browser.available, true)
  assert.equal(download.available, true)
  assert.notEqual(browser.supportsHtml, download.supportsHtml)
  assert.equal(
    transport.describeClientTransport('DOWNLOAD', 'server').reason,
    'CLIENT_ONLY_TRANSPORT',
  )
})

/* ═══════════════════════════════════════════════════════════════════════
   HAM TAŞIMA GERÇEĞİ — SAHTE BAŞARI YOK
   ═══════════════════════════════════════════════════════════════════════ */

test('RAW-6/RAW-7: yürütücü YALNIZ sunucu baytlarını alır, ham stderr SIZMAZ', async () => {
  const seen = []
  const executor = rawTransport.createWindowsRawExecutor({
    scriptPath: 'C:/yok/print.ps1',
    platform: 'win32',
    run: async (file, args) => {
      seen.push({ file, args })
      return { stdout: '4711', stderr: '' }
    },
  })
  const outcome = await executor({
    printerName: 'Zebra-1',
    documentName: 'CargoFlow-1',
    content: '^XA^FDSUNUCU^FS^XZ',
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.printJobId, '4711')
  assert.equal(seen[0].file, 'powershell.exe')
  // Yürütücüye giden tek içerik, ÇAĞIRANIN verdiği sunucu baytlarıdır.
  const base64 = seen[0].args[seen[0].args.indexOf('-ZplBase64') + 1]
  assert.equal(Buffer.from(base64, 'base64').toString('utf8'), '^XA^FDSUNUCU^FS^XZ')

  // RAW-7: süreç hatası KARARLI koda düşer; ham metin TAŞINMAZ.
  const failing = rawTransport.createWindowsRawExecutor({
    scriptPath: 'C:/yok/print.ps1',
    platform: 'win32',
    run: async () => {
      const error = new Error(
        'Exception calling "Send": C:\\gizli\\yol\\print.ps1 satır 83',
      )
      throw error
    },
  })
  const failed = await failing({
    printerName: 'Zebra-1',
    documentName: 'd',
    content: '^XA^XZ',
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.failure, 'PRINT_COMMAND_FAILED')
  assert.equal(JSON.stringify(failed).includes('gizli'), false)
  assert.equal(JSON.stringify(failed).includes('satır 83'), false)
})

test('RAW-TRUTH: SESSİZ BAŞARI KAPALI — iş kimliği yoksa BAŞARI YOK', async () => {
  // ÖLÇÜLEN KUSUR D2: PowerShell yazıcı hatasında EXIT 0 dönüyor, sunucu
  // uydurma bir UUID'yi iş kimliği sayıyordu.
  const noJobId = rawTransport.createWindowsRawExecutor({
    scriptPath: 'C:/yok/print.ps1',
    platform: 'win32',
    run: async () => ({ stdout: '   ', stderr: 'Yazıcı adı geçersiz' }),
  })
  const outcome = await noJobId({
    printerName: 'Zebra-1',
    documentName: 'd',
    content: '^XA^XZ',
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failure, 'NO_PRINT_JOB_ID')

  // Betik de artık SIFIR OLMAYAN çıkış kodu döner.
  const script = readFileSync(join(here, 'print-raw-zpl.ps1'), 'utf8')
  assert.match(script, /\$ErrorActionPreference = 'Stop'/)
  assert.match(script, /exit 2/)
  assert.match(script, /exit 3/)

  // Windows olmayan çalışma zamanında yol YOKTUR.
  const linux = rawTransport.createWindowsRawExecutor({
    scriptPath: 'p',
    platform: 'linux',
    run: async () => ({ stdout: '1', stderr: '' }),
  })
  const linuxOutcome = await linux({
    printerName: 'Zebra-1',
    documentName: 'd',
    content: '^XA^XZ',
  })
  assert.equal(linuxOutcome.ok, false)
  assert.equal(linuxOutcome.failure, 'RUNTIME_NOT_SUPPORTED')
})

/* ═══════════════════════════════════════════════════════════════════════
   MEVCUT DAVRANIŞ KORUNDU
   ═══════════════════════════════════════════════════════════════════════ */

test('PRINT-1/PRINT-2: resmî tarayıcı belgesi ve CargoFlow HTML yolu DEĞİŞMEDİ', async () => {
  // PRINT-1: resmî Sürat baskı belgesi AYNI sayfa kutusunu ve AYNI sırayı
  // üretir; görsel yeniden tasarım YOK.
  const suratDocument = await loadFrontend('/src/utils/officialSuratPrintDocument.ts')
  const document = suratDocument.buildOfficialSuratPrintDocument([
    { orderNumber: 'A', imageBase64: 'AAA', mimeType: 'image/png' },
    { orderNumber: 'B', imageBase64: 'BBB', mimeType: 'image/png' },
  ])
  assert.deepEqual(document.pageSizeMm, { widthMm: 100, heightMm: 100 })
  assert.match(document.html, /@page \{ size: 100mm 100mm; margin: 0; \}/)
  assert.ok(document.html.indexOf('data-order="A"') < document.html.indexOf('data-order="B"'))
  assert.equal(document.pages.length, 2)

  // PRINT-2: CargoFlow HTML dalı MEVCUT üreticisini ve MEVCUT karar
  // fonksiyonunu kullanmaya devam eder.
  const provider = stripComments(
    readFileSync(join(root, 'src/providers/printing/BrowserDownloadPrintProvider.ts'), 'utf8'),
  )
  const browserBranch = provider.slice(
    provider.indexOf("if (input.printerSettings.mode === 'browser-print')"),
    provider.indexOf("if (input.printerSettings.mode === 'download')"),
  )
  assert.match(browserBranch, /printCleanLabelDocument/)
  assert.match(browserBranch, /printOfficialSuratLabels/)
  assert.match(browserBranch, /resolveBrowserPrintJobs/)
})

test('PRINT-18/PRINT-20: indirme fiziksel baskı SAYILMAZ, sipariş durumu kararı TEK YERDE', () => {
  const workflow = stripComments(
    readFileSync(join(root, 'src/services/orderWorkflowService.ts'), 'utf8'),
  )
  // İNDİRME: mevcut kabul edilmiş semantik — baskı durumu DEĞİŞMEZ.
  assert.match(workflow, /Etiket baskı durumu değiştirilmedi/)
  // SİPARİŞ DURUMU kararı `jobs[].ok` üzerinden verilir (mevcut davranış).
  assert.match(workflow, /printResult\.jobs\?\.filter\(\(job\) => job\.ok\)/)
  assert.match(workflow, /'LABEL_PRINTED'/)

  // Platform tarafında da TEK indirgeyici vardır.
  const service = stripComments(
    readFileSync(join(here, 'printing', 'printJobService.ts'), 'utf8'),
  )
  assert.match(service, /export function resolvePrintedOrderIds/)
})

test('PRINT-REG: paket tam pakete KAYITLI', () => {
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  assert.ok(files.includes('server/print-platform-flow.test.mjs'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(String(pkg.scripts['test:print-platform']), /print-platform-flow\.test\.mjs/)
})
