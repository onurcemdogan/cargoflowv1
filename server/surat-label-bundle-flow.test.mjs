import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createServer } from 'vite'

// BASKI PAKETİ (BUNDLE) KALICILIĞI — AŞAMA 2.
//
// SÖZLEŞME
//  - `printZpl` TAŞIYICI etiketidir ve DEĞİŞMEZ; ek sayfalar AYRI
//    `supplementalLabels[]` alanındadır (additive, MIGRATION YOK).
//  - Atomiklik yapıdan gelir: taşıyıcı + ek sayfalar TEK JSON bloğu olarak
//    TEK yazımda kalıcı olur. Yarım bundle yazılamaz.
//  - Immutable reprint: kalıcı bayt aynen döner; toplama, sayfalama ve
//    composer YENİDEN ÇALIŞMAZ.
//  - Eski (yalnız printZpl'li) artefakta reprint'te ek sayfa SENTEZLENMEZ.
//
// Fixture MASKELİDİR; gerçek müşteri verisi içermez.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const repo = await import('./shipments/printZplRepository.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')

const zpl = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const NOW = '2026-08-09T00:00:00.000Z'
const VERIFIED_727 = '7271234567890'

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
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
  packageId: 'PKG-BUNDLE-1',
  provider: 'surat',
})
async function seedShipment(db, organizationId, payload) {
  await db.insert(schema.shipments).values({
    ...KEY(organizationId),
    orderNumber: '1141234567890',
    source: 'local_create',
    status: 'created',
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

const payloadOf = (extra = {}) => ({
  technicalZpl: zpl,
  cargoTrackingNumber: VERIFIED_727,
  ozelKargoTakipNo: VERIFIED_727,
  orderNumber: '1141234567890',
  packageId: 'PKG-BUNDLE-1',
  aliciAdi: 'ARIFE BOLSAGAR',
  ...extra,
})

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

const build = (items, payload = payloadOf()) =>
  repo.attachPrintZplArtifact(payload, items, NOW).printZplArtifact

// ═══ PERSIST-1..2: EŞİK DAVRANIŞI ════════════════════════════════════════

test('PERSIST-1: <=2 toplanmış satır → ek sayfa YOK', async () => {
  for (const items of [[item()], distinct(2), Array.from({ length: 8 }, () => item())]) {
    const artifact = build(items)
    assert.deepEqual(artifact.supplementalLabels, [])
    assert.equal(artifact.supplementalStatus, 'none')
    assert.equal(artifact.bundleVersion, repo.PRINT_BUNDLE_VERSION)
  }
})

test('PERSIST-2: 3+ toplanmış satır → TÜM ek sayfalar kalıcı olur', async () => {
  const artifact = build(distinct(8))
  assert.equal(artifact.supplementalStatus, 'ready')
  assert.ok(artifact.supplementalLabels.length >= 1)
  assert.equal(artifact.productSnapshot.aggregatedLineCount, 8)
  assert.equal(artifact.productSnapshot.totalQuantity, 8)
  // Sayfa BAYTLARI kalıcı — yalnız ürün verisi değil.
  for (const page of artifact.supplementalLabels) {
    assert.equal(page.kind, 'product_detail')
    assert.ok(page.zpl.includes('^XA') && page.zpl.includes('^XZ'))
    assert.ok(page.sha256.length === 64)
  }
})

// ═══ PERSIST-3: ESKİ ARTEFAKT KENDİLİĞİNDEN YÜKSELTİLMEZ ═════════════════

test('PERSIST-3: eski yalnız-printZpl artefaktı reprint’te ek sayfa SENTEZLEMEZ', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'bundle-legacy')
  // Feature ÖNCESİ artefakt: supplementalLabels alanı HİÇ YOK.
  const legacyArtifact = build(distinct(8))
  delete legacyArtifact.supplementalLabels
  delete legacyArtifact.supplementalStatus
  delete legacyArtifact.bundleVersion
  delete legacyArtifact.productSnapshot
  const key = await seedShipment(
    db,
    organizationId,
    { ...payloadOf(), printZplArtifact: legacyArtifact },
  )

  const model = await repo.resolvePersistedPrintableLabel(db, key, {
    loadItems: async () => {
      throw new Error('reprint sırasında ürün satırı OKUNMAMALI')
    },
    now: '2027-01-01T00:00:00.000Z',
  })
  assert.equal(model.hydrated, false)
  assert.equal(model.printZpl, legacyArtifact.printZpl)
  assert.equal(model.supplementalLabels, undefined, 'ek sayfa UYDURULMAZ')
  // DB kaydı da değişmedi.
  const stored = await readArtifact(db, organizationId)
  assert.equal(stored.supplementalLabels, undefined)
})

// ═══ PERSIST-4..5: HASH VE SIRA ══════════════════════════════════════════

test('PERSIST-4: sayfa hash’leri kararlı ve içerikle tutarlı', async () => {
  const { sha256Hex } = await load('/src/utils/augmentedSuratZpl.ts')
  const first = build(distinct(8))
  const second = build(distinct(8))
  assert.equal(first.supplementalLabels.length, second.supplementalLabels.length)
  for (const [index, page] of first.supplementalLabels.entries()) {
    assert.equal(page.sha256, sha256Hex(page.zpl), 'hash içerikle uyumlu')
    assert.equal(page.sha256, second.supplementalLabels[index].sha256, 'kararlı')
    assert.equal(page.zpl, second.supplementalLabels[index].zpl)
  }
})

test('PERSIST-5: sayfa sırası deterministik — boşluk ve tekrar YOK', async () => {
  const artifact = build(distinct(12))
  const pages = artifact.supplementalLabels
  assert.ok(pages.length >= 2)
  const numbers = pages.map((page) => page.page)
  assert.deepEqual(
    numbers,
    Array.from({ length: pages.length }, (_, index) => index + 1),
    'sayfa numaraları 1..N, boşluksuz',
  )
  assert.equal(new Set(numbers).size, numbers.length, 'tekrar YOK')
  for (const page of pages) assert.equal(page.totalPages, pages.length)
  // Dizi sırası ile `page` alanı BİRBİRİNİ doğrular.
  const verdict = repo.verifySupplementalLabels(pages)
  assert.equal(verdict.ok, true, verdict.reason ?? '')
})

// ═══ PERSIST-6 / PRODUCT-11: IMMUTABLE REPRINT ═══════════════════════════

test('PERSIST-6 / PRODUCT-11: kaynak ürün verisi DEĞİŞSE BİLE reprint aynı', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'bundle-immutable')
  const key = await seedShipment(db, organizationId, payloadOf())

  // İLK üretim: gerçek ürün adları.
  const created = await repo.resolvePersistedPrintableLabel(db, key, {
    items: distinct(8),
    now: NOW,
  })
  assert.equal(created.hydrated, true)
  assert.equal(created.supplementalStatus, 'ready')
  const pages = created.supplementalLabels
  assert.ok(pages.length >= 1)
  assert.ok(pages.some((page) => page.zpl.includes('Urun 1')))

  // Kaynak ürün adları SONRADAN değişti — reprint ETKİLENMEMELİ.
  const reprint = await repo.resolvePersistedPrintableLabel(db, key, {
    loadItems: async () => {
      throw new Error('reprint sırasında ürün satırı OKUNMAMALI')
    },
    now: '2027-05-05T00:00:00.000Z',
  })
  assert.equal(reprint.hydrated, false, 'yeniden üretim YOK')
  assert.equal(reprint.printZpl, created.printZpl)
  assert.equal(reprint.printZplSha256, created.printZplSha256)
  assert.equal(reprint.supplementalLabels.length, pages.length)
  for (const [index, page] of pages.entries()) {
    assert.equal(reprint.supplementalLabels[index].zpl, page.zpl, 'bayt bayt')
    assert.equal(reprint.supplementalLabels[index].sha256, page.sha256)
    assert.equal(reprint.supplementalLabels[index].page, page.page)
  }
  assert.ok(
    reprint.supplementalLabels.some((page) => page.zpl.includes('Urun 1')),
    'kalıcı sunum korunur',
  )
})

// ═══ PERSIST-7..8: TAŞIYICI SÖZLEŞMESİ ═══════════════════════════════════

test('PERSIST-7: taşıyıcı printZpl TEK sayfa sözleşmesini korur', async () => {
  for (const items of [[item()], distinct(3), distinct(8)]) {
    const artifact = build(items)
    assert.equal((artifact.printZpl.match(/\^XA/g) ?? []).length, 1)
    assert.equal((artifact.printZpl.match(/\^XZ/g) ?? []).length, 1)
    assert.equal((artifact.printZpl.match(/\^PW799/g) ?? []).length, 1)
  }
})

test('PERSIST-8: ek sayfalarda taşıyıcı makine kodları YOK', async () => {
  const artifact = build(distinct(8))
  const allPages = artifact.supplementalLabels.map((page) => page.zpl).join('\n')
  assert.equal((allPages.match(/\^BX/g) ?? []).length, 0, 'DataMatrix YOK')
  assert.equal((allPages.match(/\^BQ/g) ?? []).length, 0, 'QR YOK')
  assert.equal(allPages.includes('>:'), false, 'Sürat Code128 YOK')
  // Taşıyıcı T.No gövdesi ek sayfada TEKRAR ETMEZ.
  assert.equal(allPages.includes('63074185296307'), false)
  // Dahili paket referansı VAR.
  assert.ok(allPages.includes('PAKET'))
})

// ═══ PERSIST-9 / PRODUCT-13: ATOMİKLİK ═══════════════════════════════════

// NOT: bu test YÜKLEYİCİ hatasını zorlar. Ek sayfa ÜRETİMİNİN kendisinin
// başarısız olduğu yol PERSIST-13'te kapsanır. Atomiklik ayrıca YAPISALDIR:
// taşıyıcı + ek sayfalar bellekte üretilip TEK JSON bloğu olarak TEK
// compare-and-set yazımında kalıcı olur; yarım bundle yazan bir kod yolu YOK.
test('PERSIST-9 / PRODUCT-13: artefakt üretimi patlarsa HİÇBİR ŞEY yazılmaz', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'bundle-atomic')
  const key = await seedShipment(db, organizationId, payloadOf())

  // Ürün yükleyicisi patlar → artefakt HİÇ üretilmez.
  await assert.rejects(
    repo.resolvePersistedPrintableLabel(db, key, {
      loadItems: async () => {
        throw new Error('supplemental_validation_failure: sentetik hata')
      },
      now: NOW,
    }),
    /sentetik hata/,
  )
  // DB'de YARIM artefakt YOK.
  const stored = await readArtifact(db, organizationId)
  assert.equal(stored, undefined, 'hiçbir artefakt yazılmamalı')
})

// ═══ PERSIST-10 / PRODUCT-12: EŞZAMANLI IDEMPOTENCY ══════════════════════

test('PERSIST-10 / PRODUCT-12: eşzamanlı iki çağrı TEK mantıksal bundle görür', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'bundle-concurrent')
  const key = await seedShipment(db, organizationId, payloadOf())

  const [first, second] = await Promise.all([
    repo.resolvePersistedPrintableLabel(db, key, { items: distinct(8), now: NOW }),
    repo.resolvePersistedPrintableLabel(db, key, { items: distinct(8), now: NOW }),
  ])
  // Yalnız BİRİ yazar; diğeri kazananın kaydını okur.
  assert.equal(
    [first.hydrated, second.hydrated].filter(Boolean).length,
    1,
    'tam olarak bir hydration kazanır',
  )
  // İkisi de AYNI kalıcı kimliği görür.
  assert.equal(first.printZplSha256, second.printZplSha256)
  assert.equal(
    first.supplementalLabels.length,
    second.supplementalLabels.length,
  )
  for (const [index, page] of first.supplementalLabels.entries()) {
    assert.equal(second.supplementalLabels[index].sha256, page.sha256)
    assert.equal(second.supplementalLabels[index].page, page.page)
  }
  // DB'de TEK artefakt var ve okunanla aynı.
  const stored = await readArtifact(db, organizationId)
  assert.equal(stored.printZplSha256, first.printZplSha256)
  assert.equal(stored.supplementalLabels.length, first.supplementalLabels.length)
})

// ═══ PERSIST-11: KALICILIK YOLUNDA PNG YOK ═══════════════════════════════

test('PERSIST-11: artefakt üretim yolu PNG render ETMEZ', () => {
  const source = readFileSync(
    join(here, 'shipments', 'printZplRepository.ts'),
    'utf8',
  )
  assert.equal(
    /renderZplToPng|zplRenderService|pngBase64/.test(source),
    false,
    'kalıcılık hot path’i PNG üretmemeli',
  )
  const detail = readFileSync(
    join(here, '..', 'src', 'utils', 'suratProductDetailLabel.ts'),
    'utf8',
  )
  assert.equal(/renderZplToPng|pngBase64/.test(detail), false)
})

// ═══ PERSIST-12: DEPOLAMA AYAK İZİ (ölçüm, kapı değil) ═══════════════════

test('PERSIST-12: kalıcı bayt boyutları ölçülür ve raporlanır', () => {
  const rows = []
  for (const [label, items] of [
    ['1 ürün (ek sayfa yok)', [item()]],
    ['3 ürün', distinct(3)],
    ['8 ürün (en kötü)', distinct(8)],
  ]) {
    const artifact = build(items)
    const carrierBytes = Buffer.byteLength(artifact.printZpl, 'utf8')
    const supplementalBytes = (artifact.supplementalLabels ?? []).reduce(
      (total, page) => total + Buffer.byteLength(page.zpl, 'utf8'),
      0,
    )
    rows.push({
      label,
      pages: (artifact.supplementalLabels ?? []).length,
      carrierBytes,
      supplementalBytes,
    })
    // Ek yük taşıyıcı etiketin makul bir katını aşmamalı (şişme bekçisi).
    assert.ok(
      supplementalBytes <= carrierBytes * 6,
      `${label}: ek sayfa yükü aşırı (${supplementalBytes} / ${carrierBytes})`,
    )
  }
  console.info('  [PERSIST-12] kalıcı bayt ayak izi:', JSON.stringify(rows))
})

// ═══ PERSIST-13..17: TAŞIYICI-ONLY BAŞARI YOK ═══════════════════════════
//
// >2 toplanmış görüntü satırında ürün detay sayfası OPERASYONEL OLARAK
// ZORUNLUDUR. Ek sayfa üretilemiyorsa taşıyıcı-only artefaktı "başarılı"
// saymak, 4.000 sipariş/gün çalışan depoda ürün bilgisini SESSİZCE
// kaybettirir. Bu yüzden: ya TAM bundle, ya AÇIK HATA.

/** Tek bir ürün bloğu boş sayfaya bile sığmayacak kadar uzun. */
const monsterItems = (count = 3) =>
  Array.from({ length: count }, (_, index) =>
    item({
      productName: Array.from({ length: 220 }, (_, w) => `Sozcuk${w}`).join(' '),
      sku: `MONSTER-${index + 1}`,
    }),
  )

test('PERSIST-13: >2 ürün + geometri hatası → AÇIK HATA, artefakt YAZILMAZ', async () => {
  // Saf üretim düzeyinde: taşıyıcı-only artefakt DÖNMEZ, hata fırlatır.
  assert.throws(
    () => build(monsterItems(3)),
    /supplemental_geometry_failure/,
    'taşıyıcı-only başarı OLMAMALI',
  )

  // Kalıcılık düzeyinde: hiçbir şey yazılmaz.
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'bundle-geometry-fail')
  const key = await seedShipment(db, organizationId, payloadOf())
  await assert.rejects(
    repo.resolvePersistedPrintableLabel(db, key, {
      items: monsterItems(3),
      now: NOW,
    }),
    /supplemental_geometry_failure/,
  )
  const stored = await readArtifact(db, organizationId)
  assert.equal(stored, undefined, 'taşıyıcı-only artefakt bile yazılmamalı')
})

test('PERSIST-14: <=2 ürün + ek sayfa yok → GEÇERLİ başarı', async () => {
  for (const items of [[item()], distinct(2), Array.from({ length: 8 }, () => item())]) {
    const artifact = build(items)
    assert.equal(artifact.supplementalStatus, 'none')
    assert.deepEqual(artifact.supplementalLabels, [])
    assert.ok(artifact.productSnapshot.aggregatedLineCount <= 2)
    // Merkezi invariant bunu GEÇERLİ sayar.
    const verdict = repo.verifyBundleInvariants(artifact)
    assert.equal(verdict.ok, true, verdict.reason ?? '')
  }
})

test('PERSIST-15: >2 ürün + boş supplementalLabels → invariant REDDEDER', () => {
  const artifact = build(distinct(8))
  assert.equal(repo.verifyBundleInvariants(artifact).ok, true, 'sağlam artefakt')

  // Elle bozulmuş artefakt: eşik üstü ama ek sayfa yok.
  const stripped = {
    ...artifact,
    supplementalLabels: [],
    supplementalStatus: 'geometry_failure',
  }
  const verdict = repo.verifyBundleInvariants(stripped)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /ek sayfa ZORUNLU/)

  // Durum 'ready' yazsa bile sayfa yoksa yine reddedilir.
  const lying = { ...artifact, supplementalLabels: [], supplementalStatus: 'ready' }
  assert.equal(repo.verifyBundleInvariants(lying).ok, false)
})

test('PERSIST-16: mevcut geçerli artefakt, başarısız yeniden üretimde DEĞİŞMEZ', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'bundle-existing-safe')
  // Önce GEÇERLİ bundle oluştur.
  const key = await seedShipment(db, organizationId, payloadOf())
  const created = await repo.resolvePersistedPrintableLabel(db, key, {
    items: distinct(8),
    now: NOW,
  })
  assert.equal(created.hydrated, true)
  const before = await readArtifact(db, organizationId)

  // Sonra üretimi patlatacak girdiyle tekrar çağır: kalıcı kayıt VARDIR,
  // bu yüzden hydration HİÇ denenmez ve baytlar aynen döner.
  const reprint = await repo.resolvePersistedPrintableLabel(db, key, {
    items: monsterItems(3),
    now: '2027-09-09T00:00:00.000Z',
  })
  assert.equal(reprint.hydrated, false)
  assert.equal(reprint.printZpl, created.printZpl)
  assert.equal(
    reprint.supplementalLabels.length,
    created.supplementalLabels.length,
  )
  const after = await readArtifact(db, organizationId)
  assert.equal(after.printZplSha256, before.printZplSha256, 'DB baytları aynı')
  assert.equal(
    after.supplementalLabels.length,
    before.supplementalLabels.length,
  )
})

test('PERSIST-17: geometri hatası ASLA hydrated/başarılı sonuç döndürmez', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'bundle-no-success')
  const key = await seedShipment(db, organizationId, payloadOf())
  let resolved = null
  try {
    resolved = await repo.resolvePersistedPrintableLabel(db, key, {
      items: monsterItems(4),
      now: NOW,
    })
  } catch (error) {
    assert.match(String(error?.message ?? ''), /supplemental_geometry_failure/)
  }
  assert.equal(resolved, null, 'başarılı model DÖNMEMELİ')
  assert.equal(await readArtifact(db, organizationId), undefined)
})

test('PERSIST-18: eşzamanlı başarı + hata → kazanan korunur, kısmi yazım YOK', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'bundle-concurrent-fail')
  const key = await seedShipment(db, organizationId, payloadOf())

  // A tam bundle üretir; B geometri hatası yaşar.
  const results = await Promise.allSettled([
    repo.resolvePersistedPrintableLabel(db, key, { items: distinct(8), now: NOW }),
    repo.resolvePersistedPrintableLabel(db, key, { items: monsterItems(3), now: NOW }),
  ])
  const fulfilled = results.filter((entry) => entry.status === 'fulfilled')
  const rejected = results.filter((entry) => entry.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'yalnız tam bundle başarılı olur')
  assert.equal(rejected.length, 1)
  assert.match(
    String(rejected[0].reason?.message ?? ''),
    /supplemental_geometry_failure/,
  )

  // DB'de KAZANANIN tam bundle'ı var; taşıyıcı-only veya kısmi kayıt YOK.
  const stored = await readArtifact(db, organizationId)
  assert.equal(stored.supplementalStatus, 'ready')
  assert.ok(stored.supplementalLabels.length >= 1)
  assert.equal(stored.printZplSha256, fulfilled[0].value.printZplSha256)
  assert.equal(repo.verifyBundleInvariants(stored).ok, true)
})
