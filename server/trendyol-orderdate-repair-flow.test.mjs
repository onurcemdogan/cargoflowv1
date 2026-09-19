// TRENDYOL-ORDERDATE-TZ-002 — GEÇMİŞ `orders.order_date` ONARIMI.
//
// ═══ ÜRETİM DENETİMİ (SALT OKUNUR, 500 SATIR) ════════════════════════════
//
//   DRIFTED_BY_OFFSET = 475   ALREADY_CORRECT = 25
//   RAW_UNAVAILABLE   = 0     RAW_UNPARSEABLE = 0
//
// 25 satırın ZATEN DOĞRU olması, toplu `order_date - interval '3 hours'`
// yaklaşımını KESİN OLARAK dışlar: o satırları 3 saat geriye bozardı ve
// ikinci çalıştırma TÜM tabloyu bir kez daha bozardı. Onarım bu yüzden
// HAM SAĞLAYICI YÜKÜNDEN türetilir ve satır satır sınıflandırılır.
//
// Bu dosya GERÇEK Postgres (PGlite) + GERÇEK migration'lar üzerinde çalışır:
// compare-and-set yüklemi, savepoint yalıtımı, keyset sayfalama ve
// idempotans SQL düzeyinde kanıtlanır — taklit (mock) db ile DEĞİL.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const enc = await import('./orders/orderEncryption.ts')
const repair = await import('./orders/trendyolOrderDateRepair.ts')

// Üretimde gözlenen ham değer (TZ-001 kanıt tablosu).
const RAW = 1789418160000
const OFFSET_MS = 180 * 60_000
/** Kusurlu kayıt: ham epoch DÜZ UTC sanılmış hâli. */
const DRIFTED = new Date(RAW)
/** Doğru kanonik an: ham epoch GMT+3 kabul edilip −3 saat uygulanmış hâli. */
const CORRECT = new Date(RAW - OFFSET_MS)

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
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}

let seq = 0
/**
 * Sipariş satırı ekler. `raw` verilirse ham Trendyol yükü ŞİFRELİ yazılır
 * (onarımın tek doğruluk kaynağı); `raw: null` ile yük yokluğu kurgulanır.
 */
async function insertOrder(db, organizationId, over = {}) {
  seq += 1
  const raw = 'raw' in over ? over.raw : RAW
  const [row] = await db
    .insert(schema.orders)
    .values({
      organizationId,
      marketplace: over.marketplace ?? 'Trendyol',
      packageId: over.packageId ?? `PKG-${seq}`,
      orderNumber: over.orderNumber ?? `ORD-${seq}`,
      marketplaceStatus: over.marketplaceStatus ?? 'Created',
      operationStatus: over.operationStatus ?? null,
      userLabelActivatedAt: over.userLabelActivatedAt ?? null,
      orderDate: over.orderDate ?? DRIFTED,
      rawPayloadEncrypted:
        raw === null ? null : enc.encryptOrderPayload({ orderDate: raw }),
    })
    .returning()
  return row
}

async function readOrder(db, id) {
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id))
  return row
}

async function allOrderDates(db) {
  const rows = await db
    .select({ id: schema.orders.id, orderDate: schema.orders.orderDate })
    .from(schema.orders)
  return new Map(rows.map((r) => [String(r.id), new Date(r.orderDate).toISOString()]))
}

const APPLY = repair.TRENDYOL_ORDERDATE_REPAIR_CONFIRMATION

function applyOpts(organizationId, over = {}) {
  return {
    organizationId,
    confirmation: APPLY,
    batchId: 'batch-test',
    startedAt: '2026-09-15T00:00:00.000Z',
    completedAt: '2026-09-15T00:00:01.000Z',
    ...over,
  }
}

// ── PLANLAYICI (SAF — DB YOK) ───────────────────────────────────────────────

test('TZR-1: DRIFTED satir UPDATE planlar', () => {
  const plan = repair.planOrderDateRepairRow({
    orderId: 'o1',
    organizationId: 'org',
    marketplace: 'Trendyol',
    packageId: 'P1',
    orderNumber: 'N1',
    currentOrderDate: DRIFTED,
    rawOrderDate: RAW,
  })
  assert.equal(plan.classification, 'DRIFTED_BY_OFFSET')
  assert.equal(plan.action, 'UPDATE')
  assert.equal(plan.driftMinutes, 180)
  assert.equal(plan.correctedOrderDate, CORRECT.toISOString())
})

test('TZR-2: ALREADY_CORRECT satir SKIP planlar', () => {
  const plan = repair.planOrderDateRepairRow({
    orderId: 'o1',
    organizationId: 'org',
    marketplace: 'Trendyol',
    packageId: 'P1',
    orderNumber: 'N1',
    currentOrderDate: CORRECT,
    rawOrderDate: RAW,
  })
  assert.equal(plan.classification, 'ALREADY_CORRECT')
  assert.equal(plan.action, 'SKIP_ALREADY_CORRECT')
})

test('TZR-3: RAW_UNAVAILABLE atlanir', () => {
  const plan = repair.planOrderDateRepairRow({
    orderId: 'o1',
    organizationId: 'org',
    marketplace: 'Trendyol',
    packageId: 'P1',
    orderNumber: 'N1',
    currentOrderDate: DRIFTED,
    rawOrderDate: null,
  })
  assert.equal(plan.classification, 'RAW_UNAVAILABLE')
  assert.equal(plan.action, 'SKIP_RAW_UNAVAILABLE')
})

test('TZR-4: RAW_UNPARSEABLE atlanir', () => {
  // Çözülemeyen ham değer.
  const bogus = repair.planOrderDateRepairRow({
    orderId: 'o1',
    organizationId: 'org',
    marketplace: 'Trendyol',
    packageId: 'P1',
    orderNumber: 'N1',
    currentOrderDate: DRIFTED,
    rawOrderDate: 'bu bir tarih degil',
  })
  assert.equal(bogus.classification, 'RAW_UNPARSEABLE')
  assert.equal(bogus.action, 'SKIP_RAW_UNPARSEABLE')

  // BEKLENMEYEN sapma (ör. 120 dk) ASLA yazmaya aday olamaz.
  const odd = repair.planOrderDateRepairRow({
    orderId: 'o2',
    organizationId: 'org',
    marketplace: 'Trendyol',
    packageId: 'P2',
    orderNumber: 'N2',
    currentOrderDate: new Date(RAW - OFFSET_MS + 120 * 60_000),
    rawOrderDate: RAW,
  })
  assert.notEqual(odd.action, 'UPDATE')

  // Sınıflandırıcı ileride genişlerse: BİLİNMEYEN sınıf da yazmaz.
  assert.equal(
    repair.actionForVerdict({
      classification: 'SOMETHING_NEW',
      driftMinutes: 180,
      correctedOrderDate: CORRECT.toISOString(),
    }),
    'SKIP_UNEXPECTED',
  )
  // "DRIFTED" etiketi TEK BAŞINA yetmez: bağımsız doğrulama da tutmalı.
  assert.equal(
    repair.actionForVerdict({
      classification: 'DRIFTED_BY_OFFSET',
      driftMinutes: 90,
      correctedOrderDate: CORRECT.toISOString(),
    }),
    'SKIP_UNEXPECTED',
  )
  assert.equal(
    repair.actionForVerdict({
      classification: 'DRIFTED_BY_OFFSET',
      driftMinutes: 180,
      correctedOrderDate: null,
    }),
    'SKIP_UNEXPECTED',
  )
})

test('TZR-5: duzeltilmis deger HAM YUKTEN gelir, "kayitli - 3 saat"ten DEGIL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-5')

  // Kayıtlı değer ham yükle TUTARSIZ (ör. elle bozulmuş): ham yük OTORİTEDİR.
  // "kayıtlı − 3 saat" kuralı burada 09:00 üretirdi; doğru cevap ham yükten
  // türeyen 17:36'dır. İki kural bu satırda AYRIŞIR.
  const stored = new Date('2026-09-14T12:00:00.000Z')
  const row = await insertOrder(db, org, { orderDate: stored })
  const plan = repair.planOrderDateRepairRow({
    orderId: row.id,
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: row.packageId,
    orderNumber: row.orderNumber,
    currentOrderDate: stored,
    rawOrderDate: RAW,
  })
  assert.equal(plan.correctedOrderDate, CORRECT.toISOString())
  assert.notEqual(
    plan.correctedOrderDate,
    new Date(stored.getTime() - OFFSET_MS).toISOString(),
    '"kayitli - 3 saat" ASLA kullanilmaz',
  )
  // Sapma beklenen imza DEĞİL → yazılmaz.
  assert.notEqual(plan.action, 'UPDATE')
})

// ── KAPSAM ─────────────────────────────────────────────────────────────────

test('TZR-6: kiraci izolasyonu — baska organizasyon satiri DEGISMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'tzr-6-a')
  const orgB = await makeOrg(db, 'tzr-6-b')
  const a = await insertOrder(db, orgA)
  const b = await insertOrder(db, orgB)

  const summary = await repair.applyTrendyolOrderDateRepair(db, applyOpts(orgA))
  assert.equal(summary.updated, 1)
  assert.equal(summary.scanned, 1, 'yalniz kendi kiracisini TARAR')

  assert.equal((await readOrder(db, a.id)).orderDate.toISOString(), CORRECT.toISOString())
  assert.equal(
    (await readOrder(db, b.id)).orderDate.toISOString(),
    DRIFTED.toISOString(),
    'diger kiraci DOKUNULMAMIS',
  )
})

test('TZR-7: Trendyol DISI satirlar ASLA secilmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-7')
  const ty = await insertOrder(db, org)
  const hb = await insertOrder(db, org, { marketplace: 'Hepsiburada' })

  const scan = await repair.scanTrendyolOrderDates(db, { organizationId: org })
  assert.equal(scan.tally.scanned, 1, 'yalniz Trendyol taranir')

  const summary = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(summary.updated, 1)
  assert.equal((await readOrder(db, ty.id)).orderDate.toISOString(), CORRECT.toISOString())
  assert.equal(
    (await readOrder(db, hb.id)).orderDate.toISOString(),
    DRIFTED.toISOString(),
    'Hepsiburada satiri DOKUNULMAMIS',
  )
})

// ── DRY-RUN / APPLY KAPILARI ───────────────────────────────────────────────

test('TZR-8: dry-run SIFIR yazma yapar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-8')
  await insertOrder(db, org)
  await insertOrder(db, org)
  await insertOrder(db, org, { orderDate: CORRECT })

  const before = await allOrderDates(db)
  const scan = await repair.scanTrendyolOrderDates(db, { organizationId: org })
  const after = await allOrderDates(db)

  assert.deepEqual(after, before, 'dry-run DB-yi DEGISTIRMEDI')
  assert.equal(scan.tally.scanned, 3)
  assert.equal(scan.tally.update, 2)
  assert.equal(scan.tally.alreadyCorrect, 1)
  // Kiracı kırılımı yalnız uuid taşır; müşteri alanı YOK.
  assert.deepEqual(Object.keys(scan.byOrganization), [org])
  for (const sample of scan.samples) {
    for (const leaked of ['customerFirstName', 'customerPhone', 'shippingAddressEncrypted']) {
      assert.equal(leaked in sample, false, `ornekte PII: ${leaked}`)
    }
  }

  // Kaynakta yazma yolu YOK.
  const cliSource = readFileSync(
    join(here, 'orders', 'trendyolOrderDateRepairCli.ts'),
    'utf8',
  )
  assert.equal(cliSource.includes('.set('), false, 'CLI dogrudan mutasyon icermez')
})

test('TZR-9: APPLY birebir onay dizgisi ISTER', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-9')
  const row = await insertOrder(db, org)

  for (const bad of [undefined, '', 'yes', 'trendyol_orderdate_repair', 'TRENDYOL_ORDERDATE_REPAIR ']) {
    await assert.rejects(
      () =>
        repair.applyTrendyolOrderDateRepair(
          db,
          applyOpts(org, { confirmation: bad }),
        ),
      repair.OrderDateRepairRefusedError,
      `onay "${bad}" KABUL EDILMEMELI`,
    )
  }
  assert.equal(
    (await readOrder(db, row.id)).orderDate.toISOString(),
    DRIFTED.toISOString(),
    'reddedilen apply HICBIR SEY yazmadi',
  )
})

test('TZR-10: --org olmadan APPLY fail-closed', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-10')
  const row = await insertOrder(db, org)

  for (const bad of ['', '   ', null, undefined]) {
    await assert.rejects(
      () =>
        repair.applyTrendyolOrderDateRepair(
          db,
          applyOpts(org, { organizationId: bad }),
        ),
      repair.OrderDateRepairRefusedError,
      'org yoksa apply BASLAMAMALI',
    )
  }
  assert.equal(
    (await readOrder(db, row.id)).orderDate.toISOString(),
    DRIFTED.toISOString(),
  )

  // CLI de aynı kapıyı taşır.
  const cliSource = readFileSync(
    join(here, 'orders', 'trendyolOrderDateRepairCli.ts'),
    'utf8',
  )
  assert.match(cliSource, /APPLY için --org ZORUNLU/)
})

// ── EŞZAMANLILIK ───────────────────────────────────────────────────────────

/**
 * Planlama ile yazma ARASINA canlı senkron yazması sokar: yığın okunduktan
 * sonra, güncelleme yapılmadan hemen önce satır DEĞİŞİR.
 */
function dbWithWriteBetweenReadAndUpdate(db, mutate) {
  let fired = false
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (callback) => {
          if (!fired) {
            fired = true
            await mutate()
          }
          return target.transaction(callback)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('TZR-11: compare-and-set — degisen satir EZILMEZ (conflict)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-11')
  const row = await insertOrder(db, org)

  // Canlı senkronun yazdığı YENİ değer.
  const live = new Date('2026-09-15T08:00:00.000Z')
  const raced = dbWithWriteBetweenReadAndUpdate(db, async () => {
    await db
      .update(schema.orders)
      .set({ orderDate: live })
      .where(eq(schema.orders.id, row.id))
  })

  const summary = await repair.applyTrendyolOrderDateRepair(raced, applyOpts(org))
  assert.equal(summary.updated, 0, 'degisen satir GUNCELLENMEDI')
  assert.equal(summary.conflicts, 1, 'catisma HESABA KATILDI')
  assert.equal(
    (await readOrder(db, row.id)).orderDate.toISOString(),
    live.toISOString(),
    'daha YENI senkron degeri KORUNDU',
  )
})

// ── İDEMPOTANS ─────────────────────────────────────────────────────────────

test('TZR-12: ikinci calistirma SIFIR guncelleme yapar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-12')
  const rows = [await insertOrder(db, org), await insertOrder(db, org)]

  const first = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(first.updated, 2)
  assert.equal(first.alreadyCorrect, 0)

  const second = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(second.updated, 0, 'ikinci calistirma YAZMAZ')
  assert.equal(second.alreadyCorrect, 2, 'artik hepsi ALREADY_CORRECT')
  assert.equal(second.conflicts, 0)

  // Üçüncü çalıştırma da değeri OYNATMAZ (kümülatif kayma YOK).
  await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  for (const row of rows) {
    assert.equal(
      (await readOrder(db, row.id)).orderDate.toISOString(),
      CORRECT.toISOString(),
      'deger SABIT kaldi',
    )
  }
})

// ── SAYFALAMA ──────────────────────────────────────────────────────────────

test('TZR-13: 500+ satir — bosluk YOK, tekrar YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-13')
  const TOTAL = 640
  const ids = []
  for (let i = 0; i < TOTAL; i += 1) {
    const row = await insertOrder(db, org, {
      // Her üçüncü satır ZATEN DOĞRU: onarım seçici olmak ZORUNDA.
      orderDate: i % 3 === 0 ? CORRECT : DRIFTED,
    })
    ids.push(row.id)
  }
  const expectedCorrect = Math.ceil(TOTAL / 3)
  const expectedDrifted = TOTAL - expectedCorrect

  // Küçük yığınlarla tara: tek seferde belleğe ALINMAZ.
  const scan = await repair.scanTrendyolOrderDates(db, {
    organizationId: org,
    batchSize: 100,
    sampleSize: 0,
  })
  assert.equal(scan.tally.scanned, TOTAL, 'HER satir tarandi (bosluk yok)')
  assert.equal(scan.tally.update, expectedDrifted)
  assert.equal(scan.tally.alreadyCorrect, expectedCorrect)
  assert.ok(scan.batches >= 7, `yigin sayisi: ${scan.batches}`)

  const summary = await repair.applyTrendyolOrderDateRepair(
    db,
    applyOpts(org, { batchSize: 100 }),
  )
  assert.equal(summary.scanned, TOTAL)
  assert.equal(summary.updated, expectedDrifted, 'her kusurlu satir TAM BIR KEZ')
  assert.equal(summary.conflicts, 0)
  assert.equal(summary.failed, 0)

  // TEKRAR YOK: hiçbir satır iki kez düzeltilmedi (çift düzeltme −6 saat verirdi).
  const after = await db
    .select({ id: schema.orders.id, orderDate: schema.orders.orderDate })
    .from(schema.orders)
    .where(eq(schema.orders.organizationId, org))
  assert.equal(after.length, TOTAL)
  for (const row of after) {
    assert.equal(
      new Date(row.orderDate).toISOString(),
      CORRECT.toISOString(),
      'her satir TAM OLARAK dogru anda',
    )
  }

  // Devam imleci: kaldığı yerden sürdürme BOŞLUK ÜRETMEZ.
  const firstHalf = await repair.scanTrendyolOrderDates(db, {
    organizationId: org,
    batchSize: 100,
    sampleSize: 0,
  })
  const resumed = await repair.scanTrendyolOrderDates(db, {
    organizationId: org,
    batchSize: 100,
    startAfterId: firstHalf.lastId,
    sampleSize: 0,
  })
  assert.equal(resumed.tally.scanned, 0, 'son id sonrasi satir YOK')
})

// ── HATA MUHASEBESİ ────────────────────────────────────────────────────────

/** Belirli sıradaki satır güncellemesini düşürür (savepoint yalıtımı testi). */
function dbWithFailingRow(db, failOnNth) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (callback) =>
          target.transaction(async (tx) => {
            let n = 0
            const proxiedTx = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === 'transaction') {
                  return async (innerCallback) => {
                    n += 1
                    if (n === failOnNth) throw new Error('satir yazimi dustu')
                    return txTarget.transaction(innerCallback)
                  }
                }
                const value = Reflect.get(txTarget, txProp, txReceiver)
                return typeof value === 'function' ? value.bind(txTarget) : value
              },
            })
            return callback(proxiedTx)
          })
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('TZR-14: yigin icindeki satir hatasi SESSIZ GECILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-14')
  await insertOrder(db, org)
  await insertOrder(db, org)
  await insertOrder(db, org)

  const summary = await repair.applyTrendyolOrderDateRepair(
    dbWithFailingRow(db, 2),
    applyOpts(org),
  )
  assert.equal(summary.scanned, 3)
  assert.equal(summary.failed, 1, 'dusen satir RAPORLANDI')
  assert.equal(summary.updated, 2, 'diger satirlar ETKILENMEDI')
  assert.equal(summary.updated + summary.failed + summary.conflicts, 3, 'muhasebe TAM')

  // Düşen satır ESKİ değerinde kalır; sessizce "başarılı" sayılmaz.
  const dates = [...(await allOrderDates(db)).values()]
  assert.equal(dates.filter((d) => d === DRIFTED.toISOString()).length, 1)
  assert.equal(dates.filter((d) => d === CORRECT.toISOString()).length, 2)
})

// ── DOKUNULMAYANLAR ────────────────────────────────────────────────────────

test('TZR-15: mevcut kalici printZpl artefakti BAYT BAYT DEGISMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const shipEnc = await import('./shipments/shipmentEncryption.ts')
  const org = await makeOrg(db, 'tzr-15')
  const order = await insertOrder(db, org, { packageId: 'PKG-ART' })

  // Etiket ESKİ (kusurlu) saatle basılmış ve artefakt KALICILAŞMIŞ.
  const payload = {
    technicalZpl: '^XA^FO10,10^FDESKI^FS^XZ',
    orderDate: DRIFTED.toISOString(),
    printZplArtifact: {
      printZpl: '^XA^FO10,10^FD14.09.2026 23:36^FS^XZ',
      printZplLength: 38,
      printZplSha256: 'deadbeef',
      printZplSourceSha256: 'cafebabe',
      printZplVersion: 'v1',
      printZplCreatedAt: '2026-09-14T22:05:00.000Z',
    },
  }
  const [shipment] = await db
    .insert(schema.shipments)
    .values({
      organizationId: org,
      marketplace: 'Trendyol',
      packageId: 'PKG-ART',
      orderNumber: order.orderNumber,
      provider: 'surat',
      source: 'local_create',
      status: 'CREATED',
      carrierPayloadEncrypted: shipEnc.encryptShipmentPayload(payload),
    })
    .returning()
  const beforeCipher = shipment.carrierPayloadEncrypted

  const summary = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(summary.updated, 1, 'order_date onarildi')

  const [afterShipment] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.id, shipment.id))
  assert.equal(
    afterShipment.carrierPayloadEncrypted,
    beforeCipher,
    'sifreli carrier payload BAYT BAYT AYNI',
  )
  const afterPayload = shipEnc.decryptShipmentPayload(
    afterShipment.carrierPayloadEncrypted,
  )
  assert.equal(
    afterPayload.printZplArtifact.printZpl,
    payload.printZplArtifact.printZpl,
    'kalici printZpl DEGISMEDI (artefakt degismezligi)',
  )
  // Artefaktin ICINDEKI eski saat KASITLI olarak oldugu gibi kalir: bu
  // ticket artefakt yeniden yazmaz (PHASE 11). Rapor edilir, mutasyon YOK.
  assert.match(afterPayload.printZplArtifact.printZpl, /23:36/)
  assert.equal(
    afterPayload.orderDate,
    DRIFTED.toISOString(),
    'payload icindeki TUREV kopya da DOKUNULMAMIS (ayri ticket)',
  )

  // Onarım kaynağında shipments'a yazma YOLU YOKTUR.
  const source = readFileSync(
    join(here, 'orders', 'trendyolOrderDateRepair.ts'),
    'utf8',
  )
  assert.equal(source.includes('shipments'), false, 'onarim shipments tablosuna DOKUNMAZ')
})

test('TZR-16: yasam dongusu ve kullanici aktivasyonu DEGISMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-16')
  const activatedAt = new Date('2026-09-14T19:00:00.000Z')
  const row = await insertOrder(db, org, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Shipped',
    userLabelActivatedAt: activatedAt,
  })
  const before = await readOrder(db, row.id)

  const summary = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(summary.updated, 1)
  const after = await readOrder(db, row.id)

  // YALNIZ order_date degisti.
  assert.equal(after.orderDate.toISOString(), CORRECT.toISOString())
  for (const field of [
    'operationStatus',
    'marketplaceStatus',
    'userLabelActivatedAt',
    'lastOperationalActivityAt',
    'firstSeenAt',
    'lastSeenAt',
    'createdAt',
    'updatedAt',
    'archivedAt',
    'salesDisposition',
    'rawPayloadEncrypted',
  ]) {
    assert.deepEqual(
      after[field] instanceof Date ? after[field].toISOString() : after[field],
      before[field] instanceof Date ? before[field].toISOString() : before[field],
      `DEGISMEMELIYDI: ${field}`,
    )
  }

  // Onarım çekirdeği yaşam döngüsü kolonlarına ASLA yazmaz.
  const source = readFileSync(
    join(here, 'orders', 'trendyolOrderDateRepair.ts'),
    'utf8',
  )
  for (const forbidden of [
    'userLabelActivatedAt',
    'operationStatus',
    'lastOperationalActivityAt',
  ]) {
    assert.equal(
      new RegExp(`\\.set\\([^)]*${forbidden}`).test(source),
      false,
      `onarim ${forbidden} yazmamali`,
    )
  }
})

// ── BELİRSİZ SATIRLAR (AMBIGUOUS) — TZ-002 GÜÇLENDİRMESİ ───────────────────

test('TZR-17: OFSETSIZ ham dizgi AMBIGUOUStur ve ASLA onarilmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-17')
  // Eski yol bu dizgiyi SUNUCU YERELINDE cozerdi; hangi anin yazildigi
  // geriye donuk KANITLANAMAZ → otomatik onarim disi.
  const naive = await insertOrder(db, org, { raw: '2026-09-14 20:36:00' })
  const drifted = await insertOrder(db, org)

  const scan = await repair.scanTrendyolOrderDates(db, { organizationId: org })
  assert.equal(scan.tally.ambiguous, 1)
  assert.equal(scan.tally.update, 1)

  const summary = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(summary.updated, 1, 'yalniz KANITLI kaymis satir')
  assert.equal(summary.ambiguous, 1)
  assert.equal(
    (await readOrder(db, naive.id)).orderDate.toISOString(),
    DRIFTED.toISOString(),
    'belirsiz satir DOKUNULMAMIS',
  )
  assert.equal((await readOrder(db, drifted.id)).orderDate.toISOString(), CORRECT.toISOString())
})

test('TZR-18: ACIKLANAMAYAN sapma AMBIGUOUStur, "okunamadi" DEGIL', () => {
  const plan = repair.planOrderDateRepairRow({
    orderId: 'o1',
    organizationId: 'org',
    marketplace: 'Trendyol',
    packageId: 'P1',
    orderNumber: 'N1',
    currentOrderDate: new Date(RAW - OFFSET_MS + 120 * 60_000),
    rawOrderDate: RAW,
  })
  assert.equal(plan.classification, 'AMBIGUOUS')
  assert.equal(plan.action, 'SKIP_AMBIGUOUS')
  // Ham deger COZULEBILDI: "unparseable" demek YANLIS olurdu.
  assert.equal(plan.correctedOrderDate, CORRECT.toISOString())
})

test('TZR-19: APPLY her yazilan satir icin ESKI+YENI deger kaniti uretir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-19')
  const row = await insertOrder(db, org, { packageId: 'PKG-EV', orderNumber: 'ORD-EV' })
  await insertOrder(db, org, { orderDate: CORRECT })

  const summary = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(summary.updated, 1)
  assert.equal(summary.evidence.length, 1, 'YALNIZ yazilan satir kanitlanir')
  const [evidence] = summary.evidence
  assert.equal(evidence.orderId, row.id)
  assert.equal(evidence.packageId, 'PKG-EV')
  assert.equal(evidence.orderNumber, 'ORD-EV')
  assert.equal(evidence.oldOrderDate, DRIFTED.toISOString())
  assert.equal(evidence.newOrderDate, CORRECT.toISOString())
  assert.equal(evidence.driftMinutes, 180)
  assert.equal(evidence.classification, 'DRIFTED_BY_OFFSET')
  assert.equal(evidence.reason, 'TRENDYOL_ORDERDATE_GMT3_DOUBLE_CONVERSION')
  assert.ok(Date.parse(evidence.repairedAt) > 0, 'onarim zaman damgasi')
  // GERI ALINABILIRLIK: kanittan eski degere donulebilir.
  assert.equal(
    new Date(Date.parse(evidence.newOrderDate) + 180 * 60_000).toISOString(),
    evidence.oldOrderDate,
  )
  // PII YOK.
  for (const leaked of ['customerFirstName', 'customerPhone', 'customerEmail', 'rawPayloadEncrypted']) {
    assert.equal(leaked in evidence, false, `kanitta PII: ${leaked}`)
  }
})

test('TZR-20: KARISIK veri — yalniz kanitli kaymis satir yazilir, ikinci kosu 0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tzr-20')
  const drifted = [await insertOrder(db, org), await insertOrder(db, org)]
  const alreadyCorrect = await insertOrder(db, org, { orderDate: CORRECT })
  const ambiguousNaive = await insertOrder(db, org, { raw: '2026-09-14 20:36:00' })
  const ambiguousOdd = await insertOrder(db, org, {
    orderDate: new Date(RAW - OFFSET_MS + 120 * 60_000),
  })
  const rawMissing = await insertOrder(db, org, { raw: null })
  const unparseable = await insertOrder(db, org, { raw: 'bu bir tarih degil' })

  const before = await allOrderDates(db)
  const summary = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(summary.scanned, 7)
  assert.equal(summary.updated, 2)
  assert.equal(summary.alreadyCorrect, 1)
  assert.equal(summary.ambiguous, 2)
  assert.equal(summary.rawUnavailable, 1)
  assert.equal(summary.rawUnparseable, 1)
  assert.equal(summary.conflicts, 0)
  assert.equal(summary.failed, 0)

  // DOKUNULMAYANLAR baytina kadar ayni.
  const after = await allOrderDates(db)
  for (const row of [alreadyCorrect, ambiguousNaive, ambiguousOdd, rawMissing, unparseable]) {
    assert.equal(after.get(row.id), before.get(row.id), `DEGISMEMELIYDI: ${row.packageId}`)
  }
  for (const row of drifted) {
    assert.equal(after.get(row.id), CORRECT.toISOString())
  }

  // IDEMPOTANS: ikinci kosu HICBIR SEY yazmaz.
  const second = await repair.applyTrendyolOrderDateRepair(db, applyOpts(org))
  assert.equal(second.updated, 0)
  assert.equal(second.evidence.length, 0)
  assert.deepEqual(await allOrderDates(db), after, 'ikinci kosu DB-yi DEGISTIRMEDI')
})

// ── KAPSAM ANALİZİ: "TARİHSEL KESME" Mİ, "BİÇİM FARKI" MI ──────────────────

test('TZR-21: KAPSAM — doğru satirlar OFSETLI ham bicimden geliyorsa FORMAT_DEPENDENT', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const range = await import('./orders/trendyolOrderDateRangeAudit.ts')
  const org = await makeOrg(db, 'tzr-21')

  // Kaymış satırlar: SAYISAL ham değer.
  for (let i = 0; i < 3; i += 1) await insertOrder(db, org)
  // "Zaten doğru" satırlar: OFSETLI DIZGI — kusurdan hic etkilenmemisler.
  for (let i = 0; i < 2; i += 1) {
    await insertOrder(db, org, { raw: CORRECT.toISOString(), orderDate: CORRECT })
  }

  const result = await range.auditTrendyolOrderDateRange(db, { organizationId: org })
  assert.equal(result.totals.total, 5)
  assert.equal(result.totals.drifted, 3)
  assert.equal(result.totals.correct, 2)
  assert.equal(result.byRawShape.EPOCH_MS.drifted, 3)
  assert.equal(result.byRawShape.OFFSET_STRING.correct, 2)
  assert.equal(
    result.byRawShape.EPOCH_MS.correct,
    0,
    'SAYISAL ham degerden gelen HICBIR satir dogru degil → kusur HALA CANLI',
  )
  assert.equal(
    range.interpretRangeAudit(result),
    'FORMAT_DEPENDENT',
    '"yeni siparisler duzeldi" cikarimi bu veriyle DESTEKLENMEZ',
  )
})

test('TZR-22: KAPSAM — gercek tarih kesmesi varsa HISTORICAL_CUTOFF ve sinirlar raporlanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const range = await import('./orders/trendyolOrderDateRangeAudit.ts')
  const org = await makeOrg(db, 'tzr-22')

  // ESKI satirlar kaymis (sayisal ham deger, kusurlu kayit).
  const oldRaws = [RAW, RAW + 86_400_000, RAW + 2 * 86_400_000]
  for (const raw of oldRaws) {
    await insertOrder(db, org, { raw, orderDate: new Date(raw) })
  }
  // YENI satirlar duzgun yazilmis (sayisal ham deger AMA dogru kanonik an).
  const newRaws = [RAW + 30 * 86_400_000, RAW + 31 * 86_400_000]
  for (const raw of newRaws) {
    await insertOrder(db, org, { raw, orderDate: new Date(raw - OFFSET_MS) })
  }

  const result = await range.auditTrendyolOrderDateRange(db, { organizationId: org })
  assert.equal(result.totals.drifted, 3)
  assert.equal(result.totals.correct, 2)
  assert.equal(result.byRawShape.EPOCH_MS.correct, 2, 'sayisal ham degerde de DOGRU satir var')
  assert.equal(range.interpretRangeAudit(result), 'HISTORICAL_CUTOFF')

  // SINIRLAR ORNEKLEMDEN DEGIL TAM TARAMADAN gelir.
  assert.equal(result.earliestDrifted.storedOrderDate, new Date(oldRaws[0]).toISOString())
  assert.equal(result.latestDrifted.storedOrderDate, new Date(oldRaws[2]).toISOString())
  assert.equal(
    result.earliestCorrect.storedOrderDate,
    new Date(newRaws[0] - OFFSET_MS).toISOString(),
  )
  assert.ok(
    Date.parse(result.latestDrifted.storedOrderDate) <
      Date.parse(result.earliestCorrect.storedOrderDate),
    'kesme tarihi KANITLI',
  )
  // Ay/gun kirilimi kayitli (kusurlu) degere gore kovalanir.
  assert.ok(Object.keys(result.byMonth).length >= 1)
  assert.ok(Object.keys(result.byCalendarDate).length >= 2)
})

test('TZR-23: kapsam analizi SALT OKUNURDUR ve Trendyol DISI satiri saymaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const range = await import('./orders/trendyolOrderDateRangeAudit.ts')
  const org = await makeOrg(db, 'tzr-23')
  await insertOrder(db, org)
  await insertOrder(db, org, { marketplace: 'Hepsiburada' })

  const before = await allOrderDates(db)
  const result = await range.auditTrendyolOrderDateRange(db, { organizationId: org })
  assert.deepEqual(await allOrderDates(db), before, 'analiz DB-yi DEGISTIRMEDI')
  assert.equal(result.totals.total, 1, 'yalniz Trendyol')
  assert.deepEqual(Object.keys(result.byMarketplace), ['Trendyol'])

  const source = readFileSync(join(here, 'orders', 'trendyolOrderDateRangeAudit.ts'), 'utf8')
  for (const mutation of ['.update(', '.insert(', '.delete(', '.set(']) {
    assert.equal(source.includes(mutation), false, `analiz aracinda mutasyon: ${mutation}`)
  }
})
