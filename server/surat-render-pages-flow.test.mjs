import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ÇOK SAYFALI RESMÎ SÜRAT RENDER — AŞAMA 4A.
//
// SÖZLEŞME
//  - Sayfa SIRASINI render servisi ÜRETMEZ: buildPrintableJob'dan gelir
//    (taşıyıcı ilk, ürün detayları 1..N).
//  - Her fiziksel sayfa AYRI render edilir; birleşik ZPL tek büyük PNG gibi
//    render EDİLMEZ.
//  - Girdi KALICI BAYTLARDIR: ürün toplama, sayfalama, composer ve provider
//    çağrısı YOKTUR.
//  - FAIL-OPEN: ek sayfa render edilemezse GEÇERLİ taşıyıcı yine servis
//    edilir — ama eksik sayfa AÇIKÇA raporlanır (sessiz düşürme YOK).
//  - Taşıyıcı render edilemezse basılabilir sonuç YOKTUR.
//
// Gerçek PGlite + gerçek zebrash motoru. Fixture MASKELİDİR.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY ??= 'a'.repeat(64)
process.env.CREDENTIAL_ENCRYPTION_KEY ??= 'b'.repeat(64)

const schema = await import('./db/schema.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')
const renderService = await import('./labels/suratLabelRenderService.ts')
const repo = await import('./shipments/printZplRepository.ts')
const { sha256Hex } = await import('../src/utils/augmentedSuratZpl.ts')
const { SURAT_PERSISTENCE_PROVIDER } = await import('./shipments/suratProvider.ts')

const ZPL = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const NOW = '2026-08-09T00:00:00.000Z'
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
const pools = []
async function makeDb() {
  const pglite = new PGlite()
  pools.push(pglite)
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return drizzle(pglite, { schema })
}
after(async () => {
  for (const pool of pools) await pool.close()
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
const monsterItems = (count = 3) =>
  Array.from({ length: count }, (_, index) =>
    item({
      productName: Array.from({ length: 220 }, (_, w) => `Sozcuk${w}`).join(' '),
      sku: `MONSTER-${index + 1}`,
    }),
  )

const basePayload = () => ({
  technicalZpl: ZPL,
  orderNumber: '1141234567890',
  packageId: 'PKG-RENDER',
  aliciAdi: 'ARIFE BOLSAGAR',
})

/**
 * @param options.artifactItems kalıcı artefakt üretilecek ürünler (null → yok)
 * @param options.lineItems     hydration için sipariş satırları
 * @param options.mutate        kalıcı artefaktı bozmak için kanca
 */
async function seed(db, slug, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  const payload = options.artifactItems
    ? repo.attachPrintZplArtifact(basePayload(), options.artifactItems, NOW)
    : basePayload()
  if (options.mutate) options.mutate(payload.printZplArtifact)
  await db.insert(schema.orders).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: 'PKG-RENDER',
    orderNumber: '1141234567890',
    orderDate: new Date('2026-08-01T00:00:00.000Z'),
    operationStatus: 'LABEL_READY',
  })
  for (const [index, line] of (options.lineItems ?? []).entries()) {
    const [order] = await db
      .select()
      .from(schema.orders)
      .limit(1)
    await db.insert(schema.orderLines).values({
      organizationId: org.id,
      orderId: order.id,
      externalLineId: `L-${index}`,
      productName: line.productName,
      merchantSku: line.sku ?? null,
      quantity: line.quantity ?? 1,
      variantAttributes: [],
    })
  }
  await db.insert(schema.shipments).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: 'PKG-RENDER',
    orderNumber: '1141234567890',
    provider: SURAT_PERSISTENCE_PROVIDER,
    source: 'local_create',
    status: 'VERIFIED',
    trackingNumber: CANONICAL_TRACKING,
    barcode: CANONICAL_BARCODE,
    carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
  })
  return org.id
}

async function render(db, organizationId) {
  return renderService.renderSuratLabel({
    db,
    organizationId,
    marketplaceAccountId: null,
    orderId: 'order-1',
    getOrder: async () => ({
      id: 'order-1',
      marketplace: 'Trendyol',
      packageId: 'PKG-RENDER',
      shipment: { provider: 'surat-kargo' },
    }),
  })
}

/** PNG boyutu — her sayfa TEK 100 × 100 mm fiziksel etiket olmalı. */
function pngSize(imageBase64) {
  const png = Buffer.from(imageBase64, 'base64')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

// ═══ RENDER-PAGES-1: ESKİ TEK SAYFA ══════════════════════════════════════

test('RENDER-PAGES-1: eski tek sayfa artefakt → pages.length = 1', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'render-pages-1', {
    artifactItems: [item()],
  })
  const dto = await render(db, organizationId)
  assert.equal(dto.pages.length, 1)
  assert.equal(dto.pages[0].kind, 'carrier')
  assert.equal(dto.pages[0].page, 1)
  assert.equal(dto.pages[0].totalPages, 1)
  assert.deepEqual(dto.missingPages, [])
  assert.equal(dto.productDetailStatus, 'none')
  assert.equal(dto.printArtifactStatus, 'ready')
})

// ═══ RENDER-PAGES-2/3/4: TAM PAKET, SIRA ═════════════════════════════════

test('RENDER-PAGES-2/3/4: 8 ürünlü paket → taşıyıcı + N detay, sıra korunur', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'render-pages-2', {
    artifactItems: distinct(8),
  })
  const dto = await render(db, organizationId)

  assert.ok(dto.pages.length >= 2, 'taşıyıcı + en az bir detay')
  // TAŞIYICI HER ZAMAN İLK.
  assert.equal(dto.pages[0].kind, 'carrier')
  assert.equal(dto.pages[0].page, 1)
  // EK SAYFALAR SIRASIYLA.
  const details = dto.pages.slice(1)
  assert.ok(details.every((page) => page.kind === 'product_detail'))
  assert.deepEqual(
    details.map((page) => page.page),
    details.map((_, index) => index + 2),
  )
  for (const page of dto.pages) {
    assert.equal(page.totalPages, dto.pages.length)
  }
  assert.equal(dto.productDetailStatus, 'ready')
  assert.deepEqual(dto.missingPages, [])

  // HER SAYFA AYRI FİZİKSEL ETİKET — birleşik tek büyük PNG DEĞİL.
  for (const page of dto.pages) {
    assert.deepEqual(pngSize(page.imageBase64), { width: 799, height: 799 })
  }
  // Sayfa görüntüleri BİRBİRİNDEN farklı (aynı görüntü tekrarlanmıyor).
  const hashes = new Set(dto.pages.map((page) => page.renderSha256))
  assert.equal(hashes.size, dto.pages.length)
})

// ═══ RENDER-PAGES-5: KALICI BAYTLARDAN RENDER ════════════════════════════

test('RENDER-PAGES-5: her sayfa KENDİ kalıcı baytlarından render edilir', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'render-pages-5', {
    artifactItems: distinct(8),
  })
  const dto = await render(db, organizationId)

  // Kalıcı artefaktı doğrudan okuyup AYNI baytları ayrı ayrı render edersek
  // birebir aynı görüntü hash'lerini elde etmeliyiz.
  const [row] = await db.select().from(schema.shipments)
  const artifact = encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
    .printZplArtifact
  const { renderZplToPng } = await import('./labels/zplRenderService.ts')

  const carrier = await renderZplToPng({ zpl: artifact.printZpl })
  assert.equal(dto.pages[0].renderSha256, carrier.renderSha256)
  for (const [index, label] of artifact.supplementalLabels.entries()) {
    const expected = await renderZplToPng({ zpl: label.zpl })
    assert.equal(dto.pages[index + 1].renderSha256, expected.renderSha256)
  }
  // Geriye uyumlu tek görüntü alanı = TAŞIYICI sayfa.
  assert.equal(dto.imageBase64, dto.pages[0].imageBase64)
  assert.equal(dto.renderSha256, dto.pages[0].renderSha256)
})

// ═══ RENDER-PAGES-6: ÜRETİM YOK ══════════════════════════════════════════

test('RENDER-PAGES-6: render servisi ürün toplama/planlayıcı/composer ÇALIŞTIRMAZ', async () => {
  const source = readFileSync(
    join(here, 'labels', 'suratLabelRenderService.ts'),
    'utf8',
  )
  for (const forbidden of [
    'aggregateProductLineItems',
    'planProductDetailPages',
    'buildProductDetailLabels',
    'composeSuratDurusoftLabel',
    'deriveAugmentedSuratZpl',
    'OrtakBarkodOlustur',
    'compareAndSetArtifact',
  ]) {
    assert.equal(source.includes(forbidden), false, `yasak: ${forbidden}`)
  }
  // Sayfa sırası TEK canonical kurucudan gelir.
  assert.ok(source.includes('buildPrintableJob'))

  // Kalıcı artefakt varken katalog HİÇ okunmaz (tembel yükleyici çağrılmaz).
  const db = await makeDb()
  const organizationId = await seed(db, 'render-pages-6', {
    artifactItems: distinct(8),
  })
  let selectCalls = 0
  const watched = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'select') {
        selectCalls += 1
        return target.select.bind(target)
      }
      if (property === 'update' || property === 'insert') {
        throw new Error('render YAZMA yapmamalı')
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const dto = await render(watched, organizationId)
  assert.ok(dto.pages.length >= 2)
  // Yalnız gönderi satırı okunur; sipariş satırı/katalog sorgusu YOK.
  assert.equal(selectCalls, 1)
})

// ═══ RENDER-PAGES-7: TAŞIYICI FALLBACK ═══════════════════════════════════

test('RENDER-PAGES-7: taşıyıcı fallback → tek taşıyıcı görüntüsü + uyarı', async () => {
  const db = await makeDb()
  // Artefakt YOK + >2 ürün + ek sayfa üretilemiyor → sunucu fallback'i.
  const organizationId = await seed(db, 'render-pages-7', {
    lineItems: monsterItems(3),
  })
  const dto = await render(db, organizationId)
  assert.equal(dto.pages.length, 1)
  assert.equal(dto.pages[0].kind, 'carrier')
  assert.equal(dto.printArtifactStatus, 'fallback_carrier')
  assert.equal(dto.productDetailStatus, 'failed')
  assert.equal(
    dto.productDetailFailureReason,
    repo.SUPPLEMENTAL_GEOMETRY_FAILURE,
  )
  assert.equal(dto.warning, renderService.PRODUCT_DETAIL_UNAVAILABLE_WARNING)
  // Ana etiket YİNE DE kullanılabilir (fail-open).
  assert.deepEqual(pngSize(dto.imageBase64), { width: 799, height: 799 })
})

// ═══ RENDER-PAGES-8: EK SAYFA RENDER EDİLEMEZ ════════════════════════════

test('RENDER-PAGES-8: ek sayfa render edilemezse taşıyıcı kalır, eksik AÇIKÇA raporlanır', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'render-pages-8', {
    artifactItems: distinct(8),
    // İkinci fiziksel sayfa (ilk ürün detayı) render edilemez hale getirilir.
    mutate: (artifact) => {
      artifact.supplementalLabels[0].zpl = '^XA^FDBOZUK-CERCEVE^FS'
    },
  })
  const dto = await render(db, organizationId)
  // TAŞIYICI KULLANILABİLİR.
  assert.equal(dto.pages[0].kind, 'carrier')
  assert.ok(dto.imageBase64.length > 1000)
  // EKSİK SAYFA SESSİZCE DÜŞMEZ.
  assert.equal(dto.missingPages.length, 1)
  assert.equal(dto.missingPages[0].kind, 'product_detail')
  assert.equal(dto.missingPages[0].page, 2)
  assert.ok(
    ['render_failed', 'invalid_page_structure'].includes(
      dto.missingPages[0].reason,
    ),
  )
  assert.equal(dto.productDetailStatus, 'failed')
  assert.equal(dto.warning, renderService.PRODUCT_DETAIL_UNAVAILABLE_WARNING)
  // Kalan sayfalar hâlâ servis edilir (kısmi sonuç AÇIK).
  assert.equal(
    dto.pages.length + dto.missingPages.length,
    dto.pages[0].totalPages,
  )
})

// ═══ RENDER-PAGES-9: TAŞIYICI RENDER EDİLEMEZ ════════════════════════════

test('RENDER-PAGES-9: taşıyıcı render edilemezse basılabilir sonuç YOK', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'render-pages-9', {
    artifactItems: distinct(8),
    mutate: (artifact) => {
      // Tek fiziksel etiket DEĞİL → taşıyıcı geçersiz. Hash'ler tutarlı
      // tutulur ki test gerçekten SAYFA GÜVENLİĞİNİ ölçsün.
      artifact.printZpl = `${ZPL}\n${ZPL}`
      artifact.printZplSha256 = sha256Hex(artifact.printZpl)
      artifact.printZplLength = artifact.printZpl.length
    },
  })
  await assert.rejects(render(db, organizationId), (error) => {
    assert.equal(error.name, 'SuratRenderError')
    assert.ok([409, 502].includes(error.status))
    // Ham ZPL hata mesajına KONMAZ.
    assert.equal(/\^XA|\^FD/.test(String(error.message)), false)
    return true
  })
})

// ═══ RENDER-PAGES-10: GERİYE UYUMLULUK ═══════════════════════════════════

test('RENDER-PAGES-10: mevcut tek görüntü sözleşmesi KORUNUR', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'render-pages-10', {
    artifactItems: distinct(8),
  })
  const dto = await render(db, organizationId)
  // Eski tüketicilerin okuduğu alanlar YERİNDE ve TAŞIYICI sayfayı gösterir.
  assert.equal(dto.mimeType, 'image/png')
  assert.equal(dto.widthPx, 799)
  assert.equal(dto.heightPx, 799)
  assert.equal(dto.widthMm, 99.875)
  assert.equal(dto.heightMm, 99.875)
  assert.equal(dto.imageBase64, dto.pages[0].imageBase64)
  assert.ok(typeof dto.printZplSha256 === 'string' && dto.printZplSha256.length === 64)
  assert.ok(['official_augmented', 'durusoft_composed'].includes(dto.renderContract))
  // Yanıt HAM ZPL taşımaz.
  const serialized = JSON.stringify(dto)
  for (const forbidden of ['^XA', '^FD', 'technicalZpl', 'printZpl"']) {
    assert.equal(serialized.includes(forbidden), false, `sızıntı: ${forbidden}`)
  }
})
