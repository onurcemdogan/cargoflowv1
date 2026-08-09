import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// SUNUCU TARAFI FAIL-OPEN — ADIM 1.
//
// ÜRÜN POLİTİKASI
//   "Yanlış carrier etiketi basma riski varsa BLOCK.
//    Yardımcı/supplemental özellik başarısızsa GEÇERLİ carrier etiketi bas."
//
// AYRIM (bu paketin varlık nedeni)
//   PERSISTENCE fail-open DEĞİLDİR: >2 toplanmış satırda ek sayfa yoksa
//   kalıcı bundle YAZILMAZ (PERSIST-13/17 bunu kilitler ve GEVŞETİLMEZ).
//   SERVING fail-open'dır: aynı durumda ana kargo etiketi, kimliği
//   KANITLANMIŞ taşıyıcı kaynaktan GEÇİCİ olarak servis edilir.
//
// Fixture MASKELİDİR; gerçek müşteri verisi içermez.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const repo = await import('./shipments/printZplRepository.ts')
const fallbackModule = await import('./shipments/carrierSourceFallback.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')

const ZPL = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const NOW = '2026-08-09T00:00:00.000Z'

// Gerçek şablonun semantic slotlarındaki MASKELİ kimlik değerleri.
// Canonical kolonlar bunlarla BİREBİR aynı olmalıdır.
const CANONICAL_TRACKING = '63074185296307'
const CANONICAL_BARCODE = '18529630741'

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
async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}

const KEY = (organizationId) => ({
  organizationId,
  marketplace: 'Trendyol',
  packageId: 'PKG-FAILOPEN',
  provider: 'surat',
})

const payloadOf = (extra = {}) => ({
  technicalZpl: ZPL,
  orderNumber: '1141234567890',
  packageId: 'PKG-FAILOPEN',
  aliciAdi: 'ARIFE BOLSAGAR',
  ...extra,
})

/** Kimlik kolonları VARSAYILAN olarak etiketle UYUMLU seed edilir. */
async function seed(db, organizationId, payload, identity = {}) {
  await db.insert(schema.shipments).values({
    ...KEY(organizationId),
    orderNumber: '1141234567890',
    source: 'local_create',
    status: 'created',
    trackingNumber: CANONICAL_TRACKING,
    barcode: CANONICAL_BARCODE,
    ...identity,
    carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
  })
  return KEY(organizationId)
}
async function readArtifact(db, organizationId) {
  const [row] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  return encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
    ?.printZplArtifact
}

const item = (overrides = {}) => ({
  productName: 'Scuba Secil Detayli Tesettur Elbise',
  quantity: 1,
  color: 'Lacivert',
  size: '40',
  sku: 'SCUBA-SEC01',
  ...overrides,
})
const distinct = (n) =>
  Array.from({ length: n }, (_, index) =>
    item({ productName: `Urun ${index + 1}`, sku: `SKU-${index + 1}` }),
  )
/** Tek ürün bloğu boş sayfaya bile sığmayacak kadar uzun → geometri hatası. */
const monsterItems = (count = 3) =>
  Array.from({ length: count }, (_, index) =>
    item({
      productName: Array.from({ length: 220 }, (_, w) => `Sozcuk${w}`).join(' '),
      sku: `MONSTER-${index + 1}`,
    }),
  )

// ═══ FAILOPEN-SERVER-A: KALICI TAM PAKET HER ZAMAN KAZANIR ═══════════════

test('FAILOPEN-SERVER-A: kalıcı tam paket varken kaynak ZPL KULLANILMAZ', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-a')
  // Kalıcı TAM paket (taşıyıcı + ek sayfalar) ile birlikte kaynak da mevcut.
  const withArtifact = repo.attachPrintZplArtifact(payloadOf(), distinct(8), NOW)
  const key = await seed(db, organizationId, withArtifact)

  const resolution = await repo.resolvePrintableLabelForServing(db, key, {
    loadItems: async () => {
      throw new Error('kalıcı kayıt varken ürün YÜKLENMEMELİ')
    },
    now: NOW,
  })
  assert.equal(resolution.kind, 'artifact', 'fallback KULLANILMAMALI')
  // Kalıcı BAYTLAR kazanır — kaynak technicalZpl değil.
  assert.equal(resolution.model.printZpl, withArtifact.printZplArtifact.printZpl)
  assert.notEqual(resolution.model.printZpl, ZPL, 'kaynak ZPL servis EDİLMEMELİ')
  assert.equal(resolution.model.hydrated, false)
  assert.equal(resolution.model.supplementalStatus, 'ready')
  assert.ok(resolution.model.supplementalLabels.length >= 1)
})

// ═══ FAILOPEN-SERVER-B: TİPLİ EK SAYFA HATASI → GEÇİCİ TAŞIYICI ══════════

test('FAILOPEN-SERVER-B: >2 ürün + geometri hatası + kimlik UYUYOR → taşıyıcı basılır', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-b')
  const key = await seed(db, organizationId, payloadOf())

  const resolution = await repo.resolvePrintableLabelForServing(db, key, {
    items: monsterItems(3),
    now: NOW,
  })
  assert.equal(resolution.kind, 'carrier_fallback')
  assert.equal(resolution.carrierZpl, ZPL, 'doğrulanmış taşıyıcı KAYNAK')
  assert.equal(
    resolution.productDetailFailureReason,
    repo.SUPPLEMENTAL_GEOMETRY_FAILURE,
  )
  // KRİTİK: fallback GEÇİCİDİR — DB'de artefakt YOK.
  assert.equal(
    await readArtifact(db, organizationId),
    undefined,
    'taşıyıcı-only artefakt YAZILMAMALI',
  )
})

// ═══ FAILOPEN-SERVER-C: LEGACY / <=2 — FALLBACK DEĞİL, NORMAL YOL ════════

test('FAILOPEN-SERVER-C: artefakt yok + <=2 ürün → normal hydration, fallback YOK', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-c')
  const key = await seed(db, organizationId, payloadOf())

  const resolution = await repo.resolvePrintableLabelForServing(db, key, {
    items: [item()],
    now: NOW,
  })
  assert.equal(resolution.kind, 'artifact', 'bu bir fallback DEĞİLDİR')
  assert.equal(resolution.model.hydrated, true)
  assert.equal(resolution.model.supplementalStatus, 'none')
  assert.deepEqual(resolution.model.supplementalLabels, [])
  // Tek sayfalık TAM artefakt kalıcı olur (mevcut davranış korunur).
  const stored = await readArtifact(db, organizationId)
  assert.ok(stored, 'normal yolda artefakt YAZILIR')
  assert.equal(stored.supplementalStatus, 'none')
})

// ═══ FAILOPEN-SERVER-D/E: KİMLİK UYUŞMAZLIĞI → BASKI YOK ═════════════════

test('FAILOPEN-SERVER-D: T.No uyuşmuyor → fallback YOK, baskı ENGELLENİR', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-d')
  const key = await seed(db, organizationId, payloadOf(), {
    trackingNumber: '99999999999999',
  })
  await assert.rejects(
    repo.resolvePrintableLabelForServing(db, key, {
      items: monsterItems(3),
      now: NOW,
    }),
    /carrier_identity_mismatch/,
  )
  assert.equal(await readArtifact(db, organizationId), undefined)
})

test('FAILOPEN-SERVER-E: Code128/barkod uyuşmuyor → fallback YOK', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-e')
  const key = await seed(db, organizationId, payloadOf(), {
    barcode: '00000000000',
  })
  await assert.rejects(
    repo.resolvePrintableLabelForServing(db, key, {
      items: monsterItems(3),
      now: NOW,
    }),
    /carrier_identity_mismatch/,
  )
  assert.equal(await readArtifact(db, organizationId), undefined)
})

test('FAILOPEN-SERVER-D/E ek: canonical kimlik YOKSA doğrulanamaz → baskı YOK', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-de-null')
  const key = await seed(db, organizationId, payloadOf(), {
    trackingNumber: null,
    barcode: null,
  })
  await assert.rejects(
    repo.resolvePrintableLabelForServing(db, key, {
      items: monsterItems(3),
      now: NOW,
    }),
    /carrier_identity_unverifiable/,
    '"bilinmiyor" ASLA "uyuyor" sayılmaz',
  )
})

// ═══ FAILOPEN-SERVER-F: YAPISAL GEÇERSİZLİK → BASKI YOK ══════════════════

test('FAILOPEN-SERVER-F: kaynak tek fiziksel etiket değilse fallback YOK', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-f')
  // İki etiketlik yük: "taşıyıcı etiket" diye basılamaz.
  const key = await seed(db, organizationId, payloadOf({ technicalZpl: `${ZPL}\n${ZPL}` }))
  await assert.rejects(
    repo.resolvePrintableLabelForServing(db, key, {
      items: monsterItems(3),
      now: NOW,
    }),
    /carrier_structure_invalid/,
  )
  assert.equal(await readArtifact(db, organizationId), undefined)
})

// ═══ FAILOPEN-SERVER-G: BİLİNMEYEN HATA → FAIL-OPEN YOK ══════════════════

test('FAILOPEN-SERVER-G: beklenmeyen hata fail-open TETİKLEMEZ', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-g')
  const key = await seed(db, organizationId, payloadOf())
  // Ürün yükleyicisi patlar. Mesaj tipli sebeple AYNI metni taşısa bile
  // tipli hata DEĞİLDİR → allowlist'ten geçemez.
  await assert.rejects(
    repo.resolvePrintableLabelForServing(db, key, {
      loadItems: async () => {
        throw new Error('supplemental_geometry_failure: taklit mesaj')
      },
      now: NOW,
    }),
    /taklit mesaj/,
    'düz Error fail-open ETMEMELİ',
  )
  assert.equal(await readArtifact(db, organizationId), undefined)
})

test('FAILOPEN-SERVER-G ek: allowlist YALNIZ tipli hatayı tanır', async () => {
  assert.equal(repo.isSupplementalLabelFailure(new Error('x')), false)
  assert.equal(
    repo.isSupplementalLabelFailure(
      new Error(`${repo.SUPPLEMENTAL_GEOMETRY_FAILURE}: taklit`),
    ),
    false,
  )
  assert.equal(
    repo.isSupplementalLabelFailure(
      new repo.SupplementalLabelError(repo.SUPPLEMENTAL_GEOMETRY_FAILURE, 'x'),
    ),
    true,
  )
  assert.equal(
    repo.isSupplementalLabelFailure(
      new repo.SupplementalLabelError(repo.SUPPLEMENTAL_VALIDATION_FAILURE, 'x'),
    ),
    true,
  )
  assert.equal(repo.isSupplementalLabelFailure(null), false)
})

// ═══ FAILOPEN-SERVER-H: BOZUK KALICI ARTEFAKT → KAYNAĞA DÜŞÜLMEZ ═════════

test('FAILOPEN-SERVER-H: bozuk kalıcı artefakt kaynağa DÜŞMEZ', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-h')
  const withArtifact = repo.attachPrintZplArtifact(payloadOf(), distinct(8), NOW)
  // Kalıcı taşıyıcı BOZULUR (hash tutmuyor).
  withArtifact.printZplArtifact.printZplSha256 = 'f'.repeat(64)
  const key = await seed(db, organizationId, withArtifact)

  await assert.rejects(
    repo.resolvePrintableLabelForServing(db, key, {
      items: monsterItems(3),
      now: NOW,
    }),
    new RegExp(repo.PRINT_ZPL_SOURCE_MISMATCH_MESSAGE),
    'immutable artefakt bozulması SESSİZCE telafi edilmez',
  )
})

// ═══ FAILOPEN-SERVER-I: FALLBACK HİÇBİR ŞEY YAZMAZ ═══════════════════════

test('FAILOPEN-SERVER-I: fallback yolunda YAZMA çağrısı YOK', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-i')
  const key = await seed(db, organizationId, payloadOf())

  // Yazma yüzeyleri sayılır: compare-and-set `db.update` kullanır.
  let updateCalls = 0
  let insertCalls = 0
  const watched = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'update') {
        updateCalls += 1
        return target.update.bind(target)
      }
      if (property === 'insert') {
        insertCalls += 1
        return target.insert.bind(target)
      }
      return Reflect.get(target, property, receiver)
    },
  })

  const resolution = await repo.resolvePrintableLabelForServing(watched, key, {
    items: monsterItems(4),
    now: NOW,
  })
  assert.equal(resolution.kind, 'carrier_fallback')
  assert.equal(updateCalls, 0, 'compareAndSetArtifact ÇAĞRILMAMALI')
  assert.equal(insertCalls, 0)
  assert.equal(await readArtifact(db, organizationId), undefined)
})

// ═══ FAILOPEN-SERVER-J: >2 BAŞARILI → TAM PAKET, FALLBACK YOK ════════════

test('FAILOPEN-SERVER-J: >2 ürün + ek sayfalar üretilebiliyorsa TAM paket', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-j')
  const key = await seed(db, organizationId, payloadOf())

  const resolution = await repo.resolvePrintableLabelForServing(db, key, {
    items: distinct(8),
    now: NOW,
  })
  assert.equal(resolution.kind, 'artifact', 'fallback KULLANILMAMALI')
  assert.equal(resolution.model.supplementalStatus, 'ready')
  assert.ok(resolution.model.supplementalLabels.length >= 1)
  const stored = await readArtifact(db, organizationId)
  assert.equal(stored.supplementalStatus, 'ready')
  assert.equal(stored.supplementalLabels.length, resolution.model.supplementalLabels.length)
})

// ═══ TAŞIYICI DOĞRULAYICI — BİRİM SÖZLEŞMESİ ═════════════════════════════

test('FAILOPEN-CARRIER-1: doğrulayıcı yalnız TAM eşleşmeyi kabul eder', async () => {
  const { validateCarrierSourceZpl, normalizeCarrierCode } = fallbackModule
  const identity = {
    trackingNumber: CANONICAL_TRACKING,
    barcode: CANONICAL_BARCODE,
  }
  assert.deepEqual(validateCarrierSourceZpl(ZPL, identity), { ok: true })

  // `>:` subset-C anahtarı VERİ DEĞİLDİR; ayrılır.
  assert.equal(normalizeCarrierCode('>:18529630741'), '18529630741')
  assert.equal(normalizeCarrierCode('  18529630741  '), '18529630741')
  assert.equal(normalizeCarrierCode(null), '')

  // Kısmi eşleşme KABUL EDİLMEZ (fuzzy matching YOK).
  for (const bad of ['1852963074', '185296307410', ' 1852963074 1']) {
    assert.deepEqual(
      validateCarrierSourceZpl(ZPL, { ...identity, barcode: bad }),
      { ok: false, reason: 'carrier_identity_mismatch' },
      bad,
    )
  }
  assert.deepEqual(validateCarrierSourceZpl('', identity), {
    ok: false,
    reason: 'carrier_source_missing',
  })
  assert.deepEqual(validateCarrierSourceZpl(ZPL, {}), {
    ok: false,
    reason: 'carrier_identity_unverifiable',
  })
})

// ═══ SERVING DTO — ÜRETİM YOLU ═══════════════════════════════════════════
//
// Yardımcı doğru / kablolama yanlış hatasını önlemek için fail-open, ÇAĞIRAN
// servisin döndürdüğü DTO üzerinden de doğrulanır.

const orderService = await import('./orders/orderPersistenceService.ts')
const shipmentService = await import('./shipments/shipmentPersistenceService.ts')

async function seedOrderForService(db, organizationId, lines) {
  const [order] = await db
    .insert(schema.orders)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      packageId: 'PKG-SERVICE',
      orderNumber: '1141234567890',
      operationStatus: 'LABEL_READY',
      orderDate: new Date('2026-08-01T00:00:00.000Z'),
    })
    .returning()
  for (const [index, line] of lines.entries()) {
    await db.insert(schema.orderLines).values({
      organizationId,
      orderId: order.id,
      externalLineId: `L-${index}`,
      productName: line.productName,
      merchantSku: line.sku ?? null,
      quantity: line.quantity ?? 1,
      variantAttributes: [],
    })
  }
  await shipmentService.writeOperationRecord(db, organizationId, {
    organizationId,
    marketplace: 'Trendyol',
    packageId: 'PKG-SERVICE',
    orderNumber: '1141234567890',
    provider: 'surat-kargo',
    status: 'succeeded',
    technicalZpl: ZPL,
    carrierTrackingNumber: CANONICAL_TRACKING,
    carrierBarcodeNumber: CANONICAL_BARCODE,
    shipment: {
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      barcodeRaw: ZPL,
    },
  })
  return order
}

test('FAILOPEN-DTO-1: ek sayfa çöktü + kimlik kanıtlandı → DTO taşıyıcıyı AÇAR', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-dto-1')
  const order = await seedOrderForService(db, organizationId, monsterItems(3))

  const result = await orderService.resolvePersistedLabel(db, organizationId, order.id)
  assert.equal(result.print.carrierPrintReady, true, 'ana etiket BASILABİLİR')
  assert.equal(result.print.printReady, true)
  assert.equal(result.print.printArtifactStatus, 'fallback_carrier')
  assert.equal(result.print.productDetailStatus, 'failed')
  assert.equal(
    result.print.productDetailFailureReason,
    repo.SUPPLEMENTAL_GEOMETRY_FAILURE,
  )
  assert.equal(result.print.labelPageCount, 1)
  assert.equal(result.print.productDetailPageCount, 0)
  assert.deepEqual(result.print.supplementalLabels, [])
  assert.equal(result.zpl, ZPL, 'doğrulanmış taşıyıcı kaynak servis edilir')
  assert.equal(result.source, 'shipment.carrierSourceFallback')
  // Fail-open GEÇİCİDİR.
  const [row] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  assert.equal(
    encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
      ?.printZplArtifact,
    undefined,
    'DTO yolunda da artefakt YAZILMAZ',
  )
})

test('FAILOPEN-DTO-2: kimlik uyuşmuyorsa DTO baskıyı KAPATIR', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-dto-2')
  const order = await seedOrderForService(db, organizationId, monsterItems(3))
  // Canonical kimlik etiketle çelişecek şekilde değiştirilir.
  await db
    .update(schema.shipments)
    .set({ trackingNumber: '99999999999999' })
    .where(eq(schema.shipments.organizationId, organizationId))

  const result = await orderService.resolvePersistedLabel(db, organizationId, order.id)
  assert.equal(result.print.carrierPrintReady, false, 'yanlış etiket riski → BLOCK')
  assert.equal(result.print.printReady, false)
  assert.equal(result.print.printArtifactStatus, 'failed')
  assert.equal(result.zpl, null, 'kaynağa DÜŞÜLMEZ')
})

test('FAILOPEN-DTO-3: normal tam paket DTO alanları (regresyon)', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'failopen-dto-3')
  const order = await seedOrderForService(db, organizationId, distinct(8))

  const result = await orderService.resolvePersistedLabel(db, organizationId, order.id)
  assert.equal(result.print.carrierPrintReady, true)
  assert.equal(result.print.printArtifactStatus, 'ready')
  assert.equal(result.print.productDetailStatus, 'ready')
  assert.ok(result.print.productDetailPageCount >= 1)
  assert.equal(
    result.print.labelPageCount,
    result.print.productDetailPageCount + 1,
  )
})

test('FAILOPEN-CARRIER-2: tanınmayan şablonda kimlik okunamaz → fallback YOK', async () => {
  const { validateCarrierSourceZpl } = fallbackModule
  // Slot koordinatları farklı: kimlik KANITLANAMAZ. Bilinçli fail-closed.
  const foreign = '^XA^FO60,20^A0N,28,28^FDT.No: 63074185296307^FS^XZ'
  assert.deepEqual(
    validateCarrierSourceZpl(foreign, {
      trackingNumber: CANONICAL_TRACKING,
      barcode: CANONICAL_BARCODE,
    }),
    { ok: false, reason: 'carrier_identity_unverifiable' },
  )
})
