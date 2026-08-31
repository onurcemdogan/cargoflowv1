import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ═══ TABAN KATMAN + OVERLAY — DOĞRU SOYUTLAMA ═══════════════════════════
//
// ═══ NE DEĞİŞTİ ══════════════════════════════════════════════════════════
// Düzenleyici BOŞ bir tuval + serbest barkod alanı gibi çalışıyordu. Bu
// yanlış soyutlamaydı: ürün "sıfırdan etiket tasarım aracı" değil,
// "Sürat'in resmî etiketini TABAN alan, üstüne kontrollü ekleme yapan"
// bir sistemdir.
//
// Artık:
//   TABAN  = taşıyıcı ZPL'inin render edilmiş PNG'si (biz çizmiyoruz)
//   ÜSTÜNE = kiracıya ait overlay öğeleri
//   KİLİT  = taşıyıcı bölgeleri, GERÇEK ZPL koordinatlarından türetilir
//
// ═══ NEDEN PARİTE İNŞA GEREĞİ ════════════════════════════════════════════
// Tuval ve baskı AYNI taban base64'ünü ve AYNI ilkelleri tüketir. İkinci
// bir çizim yolu YOKTUR, dolayısıyla ayrışma da olamaz.
//
// TAŞIYICI/PAZARYERİ ÇAĞRISI YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
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
  const dir = join(root, 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
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
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await load('/server/db/schema.ts')
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'base', slug: `base-${randomBytes(4).toString('hex')}` })
    .returning()
  return { pglite, db, schema, organizationId: org.id }
}

/** Taşıyıcının GERÇEK (maskelenmiş) etiketi — tabanın kaynağı. */
const CARRIER_ZPL = readFileSync(
  join(root, 'server', 'fixtures', 'surat-real-v2-numeric.zpl'),
  'utf8',
)

/** GERÇEK taban katman: taşıyıcı ZPL'i render edilir, bölgeler türetilir. */
let _base
async function baseLayer() {
  if (_base) return _base
  const renderer = await load('/server/labels/zplRenderService.ts')
  const baseModule = await load('/src/labels/labelBaseLayer.ts')
  const geometry = await load('/src/labels/labelGeometry.ts')
  const render = await renderer.renderZplToPng({ zpl: CARRIER_ZPL })
  _base = {
    kind: 'surat_official',
    imageBase64: render.pngBase64,
    // FİZİKSEL ölçü tuval sabitinden gelir (bkz. labelBaseLayer: render
    // servisinin 8 dot/mm yaklaşımı 99.875 mm raporlar, gerçek 100 mm'dir).
    widthMm: geometry.LABEL_CANVAS_WIDTH_MM,
    heightMm: geometry.LABEL_CANVAS_HEIGHT_MM,
    renderSha256: render.renderSha256,
    printZplSha256: render.zplSha256,
    templateFingerprint: baseModule.carrierTemplateFingerprint(CARRIER_ZPL),
    carrierZones: baseModule.deriveCarrierZones(CARRIER_ZPL),
  }
  return _base
}

const LABEL_DATA = {
  recipientName: 'Şükrü Öztürkoğlu',
  address: 'Örnek Mahallesi Örnek Caddesi No: 12/3',
  city: 'İstanbul',
  district: 'Kadıköy',
  recipientPhone: '05380000000',
  orderNumber: 'ORD-1',
  tNo: '11415535074',
  trackingNumber: '11415535074',
  barcodeValue: 'Web00157962154',
  qrPayload: 'Web00157962154',
  items: [],
  marketplaceName: 'Trendyol',
  cargoProviderName: 'Sürat Kargo',
}

/** Kiracı overlay'i: taşıyıcı bölgelerinden UZAK, boş bir şeride yerleşir. */
function overlayDocument(elements) {
  return {
    schemaVersion: 1,
    id: 'tpl-overlay',
    name: 'Mağaza Notu',
    elements,
  }
}

const SAFE_NOTE = {
  id: 'note',
  type: 'staticText',
  text: 'Bizi tercih ettiğiniz için teşekkürler',
  x: 4,
  y: 95.5,
  width: 60,
  height: 3.5,
  z: 10,
  visible: true,
  fontSize: 6,
}

/* ═══ BASE-01..02 — TABAN GERÇEK ETİKETTİR ══════════════════════════ */

test('BASE-01: taban katman BOŞ TUVAL değil, taşıyıcının GERÇEK etiketidir', async () => {
  const base = await baseLayer()
  assert.equal(base.kind, 'surat_official')
  assert.ok(base.imageBase64.length > 1000, 'taban görüntüsü dolu olmalı')
  assert.equal(base.widthMm, 100)
  assert.equal(base.heightMm, 100)
  assert.match(base.renderSha256, /^[0-9a-f]{64}$/)
  // Görüntü taşıyıcı ZPL'inden gelir; CargoFlow onu YENİDEN ÇİZMEZ.
  const renderer = await load('/server/labels/zplRenderService.ts')
  const again = await renderer.renderZplToPng({ zpl: CARRIER_ZPL })
  assert.equal(again.renderSha256, base.renderSha256, 'taban DETERMİNİSTİK')
})

test('BASE-02: taşıyıcı bölgeleri GERÇEK ZPL koordinatlarından türetilir', async () => {
  const base = await baseLayer()
  const byKey = new Map(base.carrierZones.map((z) => [z.key, z]))
  // Kimlik alanları
  for (const key of ['barcodeGraphic', 'qrGraphic', 'dataMatrixGraphic']) {
    const zone = byKey.get(key)
    assert.ok(zone, `${key} bölgesi bulunmalı`)
    assert.equal(zone.zoneClass, 'identity')
    assert.ok(zone.reason.length > 20, 'kilit NEDENİ operatöre açıklanmalı')
  }
  // Operasyon alanları
  for (const key of ['routeCode', 'transferCenter']) {
    assert.equal(byKey.get(key)?.zoneClass, 'operational', key)
  }
  // Bilgi alanları
  for (const key of ['recipient', 'addressLine1', 'cityDistrict']) {
    assert.equal(byKey.get(key)?.zoneClass, 'informational', key)
  }
  // Bölgeler etiket içinde ve makul boyutta
  for (const zone of base.carrierZones) {
    assert.ok(zone.rect.x >= 0 && zone.rect.y >= 0, `${zone.key} negatif konum`)
    assert.ok(zone.rect.width > 0 && zone.rect.height > 0, `${zone.key} boş kutu`)
    assert.ok(zone.rect.x + zone.rect.width <= 101, `${zone.key} taşıyor`)
  }
})

/* ═══ BASE-03 — OVERLAY TABANIN ÜSTÜNE ÇİZİLİR ══════════════════════ */

test('BASE-03: overlay taban katmanla birlikte render edilir', async () => {
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const base = await baseLayer()
  const rendered = renderer.renderLabelDocument(
    overlayDocument([SAFE_NOTE]),
    { data: LABEL_DATA, baseLayer: base },
  )
  assert.equal(rendered.baseLayer?.renderSha256, base.renderSha256)
  assert.equal(rendered.primitives.length, 1)
  assert.deepEqual(rendered.primitives[0].lines, [SAFE_NOTE.text])
  assert.equal(rendered.hasBlockingViolation, false, 'güvenli şerit temiz olmalı')
})

/* ═══ BASE-04..06 — ALAN POLİTİKASI (KİLİTLİ / KORUMALI) ════════════ */

const POLICY_CASES = [
  { key: 'barcodeGraphic', label: 'ana barkod', blocking: true },
  { key: 'qrGraphic', label: 'QR', blocking: true },
  { key: 'transferCenter', label: 'aktarma merkezi', blocking: true },
  { key: 'routeCode', label: 'rota', blocking: true },
  { key: 'recipient', label: 'alıcı adı', blocking: false },
  { key: 'addressLine1', label: 'adres', blocking: false },
]

for (const policy of POLICY_CASES) {
  test(`BASE-04: ${policy.label} üstüne bindirme → ${policy.blocking ? 'ENGELLENİR' : 'UYARI'}`, async () => {
    const renderer = await load('/src/labels/labelDocumentRenderer.ts')
    const base = await baseLayer()
    const zone = base.carrierZones.find((z) => z.key === policy.key)
    assert.ok(zone, `${policy.key} bölgesi bulunmalı`)
    const rendered = renderer.renderLabelDocument(
      overlayDocument([
        {
          ...SAFE_NOTE,
          id: 'intruder',
          x: zone.rect.x,
          y: zone.rect.y,
          width: Math.max(4, zone.rect.width / 2),
          height: Math.max(3, zone.rect.height / 2),
        },
      ]),
      { data: LABEL_DATA, baseLayer: base },
    )
    const violation = rendered.violations.find(
      (v) => v.code === 'CARRIER_ZONE_OVERLAP_GUARD' && v.detail.includes(zone.label),
    )
    assert.ok(violation, `${policy.label} muhafızı tetiklenmeli`)
    assert.equal(violation.blocking, policy.blocking)
    if (policy.blocking) {
      assert.equal(rendered.hasBlockingViolation, true, 'YAYINLANAMAZ olmalı')
    }
  })
}

/* ═══ BASE-07 — PARİTE: TUVAL VE BASKI AYNI TABANI KULLANIR ═════════ */

test('BASE-07: baskı HTML tabanı EN ALTA koyar, ilkelleri ÜSTÜNE', async () => {
  const printHtml = await load('/src/labels/labelPrintHtml.ts')
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const base = await baseLayer()
  const rendered = renderer.renderLabelDocument(
    overlayDocument([SAFE_NOTE]),
    { data: LABEL_DATA, baseLayer: base },
  )
  const html =
    printHtml.baseLayerToPrintHtml(rendered.baseLayer) +
    printHtml.primitivesToPrintHtml(rendered.primitives)

  // Taban AYNI base64 — yeniden çizim YOK.
  assert.ok(html.includes(base.imageBase64.slice(0, 64)), 'taban görüntüsü baskıda')
  assert.match(html, new RegExp(`data-render-sha="${base.renderSha256}"`))
  // Fiziksel ölçü ve katman sırası
  assert.match(html, /class="lp-base"[^>]*width:100mm;height:100mm;z-index:0/)
  assert.ok(
    html.indexOf('class="lp-base"') < html.indexOf('class="lp lp-text"'),
    'taban ilkellerden ÖNCE gelmeli',
  )
  assert.match(html, /class="lp lp-text"[^>]*z-index:1/)
})

/* ═══ BASE-08..11 — SÜRÜMLEME / YAYIN / ROLLBACK / FALLBACK ═════════ */

async function seedTemplate(repo, db, organizationId) {
  const created = await repo.createLabelDocumentFromSystem(
    db, organizationId, 'surat-classic-100x100', 'Overlay', '2026-08-01T00:00:00.000Z', 'tpl_1',
  )
  return created
}

test('BASE-08: yayınla → aktif seçilir; taslak kaydı yayınlamaz', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const created = await seedTemplate(repo, db, organizationId)
    // Taslak kaydı AKTİF sürümü değiştirmez.
    const saved = await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_1', created.draft, created.version, '2026-08-02T00:00:00.000Z',
    )
    assert.equal(saved.active, null, 'kaydetmek YAYINLAMAZ')
    let layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'carrier_original', 'yayın yoksa taşıyıcı etiketi')

    const activated = await repo.activateLabelDocument(
      db, organizationId, 'tpl_1', saved.version, '2026-08-03T00:00:00.000Z',
    )
    assert.ok(activated.active, 'aktif sürüm oluşmalı')
    assert.equal(activated.activatedAt, '2026-08-03T00:00:00.000Z')
    layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'active')
    assert.equal(layer.document.id, 'tpl_1')
  } finally {
    await pglite.close()
  }
})

test('BASE-09: ÖNCEKİ SÜRÜME DÖN tek adımdır ve taslağı korur', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const created = await seedTemplate(repo, db, organizationId)
    const v1 = await repo.activateLabelDocument(
      db, organizationId, 'tpl_1', created.version, '2026-08-03T00:00:00.000Z',
    )
    // İkinci sürüm: bir öğe gizlenir.
    const changed = {
      ...v1.active,
      elements: v1.active.elements.map((e) =>
        e.type === 'cargoMeta' ? { ...e, visible: false } : e,
      ),
    }
    const saved = await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_1', changed, v1.version, '2026-08-04T00:00:00.000Z',
    )
    const v2 = await repo.activateLabelDocument(
      db, organizationId, 'tpl_1', saved.version, '2026-08-05T00:00:00.000Z',
    )
    assert.equal(v2.history.length, 1, 'önceki aktif ARŞİVLENMELİ')

    const rolled = await repo.rollbackLabelDocument(
      db, organizationId, 'tpl_1', v2.version, '2026-08-06T00:00:00.000Z',
    )
    assert.deepEqual(
      rolled.active.elements.find((e) => e.type === 'cargoMeta').visible,
      true,
      'geri dönüş ÖNCEKİ yerleşimi geri getirmeli',
    )
    assert.ok(rolled.draft, 'taslak KORUNMALI')
    const layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'active')
  } finally {
    await pglite.close()
  }
})

test('BASE-10: ORİJİNAL SÜRAT ŞABLONUNA dönüş — şablonlar silinmez', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const created = await seedTemplate(repo, db, organizationId)
    await repo.activateLabelDocument(
      db, organizationId, 'tpl_1', created.version, '2026-08-03T00:00:00.000Z',
    )
    await repo.revertToCarrierOriginal(db, organizationId, '2026-08-07T00:00:00.000Z')
    const layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'carrier_original')
    assert.equal(layer.document, null, 'kiracı katmanı UYGULANMAZ')
    // Şablon KAYBOLMAZ: operatör tekrar yayınlayabilir.
    const state = await repo.loadLabelDocuments(db, organizationId)
    assert.ok(state.templates.tpl_1, 'şablon silinmemeli')
    assert.ok(state.templates.tpl_1.active, 'aktif sürüm kaydı korunmalı')
  } finally {
    await pglite.close()
  }
})

test('BASE-11: FALLBACK — bozuk aktif sürüm baskıyı DURDURMAZ', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const created = await seedTemplate(repo, db, organizationId)
    const v1 = await repo.activateLabelDocument(
      db, organizationId, 'tpl_1', created.version, '2026-08-03T00:00:00.000Z',
    )
    const saved = await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_1',
      { ...v1.active, elements: v1.active.elements.map((e) => ({ ...e, z: e.z + 1 })) },
      v1.version, '2026-08-04T00:00:00.000Z',
    )
    await repo.activateLabelDocument(
      db, organizationId, 'tpl_1', saved.version, '2026-08-05T00:00:00.000Z',
    )

    // AKTİF sürümü doğrudan BOZ (depoda geçersiz hale getir).
    const { eq } = await import('drizzle-orm')
    const rows = await db
      .select()
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, organizationId))
    const settings = JSON.parse(JSON.stringify(rows[0].settingsJson))
    settings.labelDocuments.templates.tpl_1.active.elements = [
      { id: 'x', type: 'barcode', x: -50, y: -50, width: 0, height: 0, z: 1, visible: true },
    ]
    await db
      .update(schema.organizationSettings)
      .set({ settingsJson: settings })
      .where(eq(schema.organizationSettings.organizationId, organizationId))

    const layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'previous', 'önceki ÇALIŞAN sürüme düşmeli')
    assert.ok(layer.document, 'baskı belgesiz KALMAMALI')
    assert.ok(layer.reason, 'düşme nedeni bildirilmeli')
  } finally {
    await pglite.close()
  }
})

/* ═══ BASE-12 — KAYIT ══════════════════════════════════════════════ */

test('BASE-12: bu paket KAPILARA bağlı', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(
    pkg.scripts['test:label-editor:acceptance'],
    /label-base-layer-overlay-flow\.test\.mjs/,
  )
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  assert.ok(files.includes('server/label-base-layer-overlay-flow.test.mjs'))
})

/* ═══ BASE-13..15 — BASKI YOLU TABANI GERÇEKTEN KULLANIR ═══════════ */

const PRINT_TNO = '11415535074'
const PRINT_BARCODE = 'Web00157962154'
const PRINTABLE_ORDER = {
  id: 'o-overlay',
  orderNumber: 'ORD-OVERLAY',
  packageId: 'PKG-OVERLAY',
  operationStatus: 'LABEL_READY',
  labelStatus: 'READY',
  customerName: 'Şükrü Öztürkoğlu',
  customerPhone: '5380000000',
  city: 'İSTANBUL',
  district: 'KADIKÖY',
  address: 'ÖRNEK MAHALLESİ ÖRNEK CADDESİ NO 12/3',
  desi: 2,
  desiSource: 'manual_total',
  items: [{ productName: 'Sweatshirt', quantity: 1, sku: 'SKU-1' }],
  shipment: {
    provider: 'surat-kargo',
    trackingNumber: PRINT_TNO,
    tNo: PRINT_TNO,
    kargoTakipNo: PRINT_TNO,
    barcode: PRINT_BARCODE,
    barkodNo: PRINT_BARCODE,
    barcodeValue: PRINT_BARCODE,
    ozelKargoTakipNo: PRINT_BARCODE,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    zplReady: true,
    printEnabled: true,
    barcodeRaw: `^XA^PW799^LL799^FO60,120^BCN,140,Y,N,N^FD${PRINT_BARCODE}^FS^XZ`,
  },
}
const PRINT_TEMPLATE = { id: 't', widthMm: 100, heightMm: 100, fields: [] }

const OVERLAY_DOC = {
  schemaVersion: 1,
  id: 'tpl-overlay',
  name: 'Mağaza Notu',
  mode: 'overlay',
  elements: [SAFE_NOTE],
}

test('BASE-13: OVERLAY baskısı taşıyıcı tabanını GERÇEKTEN içerir', async () => {
  const print = await load('/src/utils/browserLabelPrint.ts')
  const base = await baseLayer()
  const result = print.buildCleanLabelDocument(
    [PRINTABLE_ORDER],
    PRINT_TEMPLATE,
    {},
    [],
    OVERLAY_DOC,
    new Map([[PRINTABLE_ORDER.id, base]]),
  )
  assert.equal(result.printable.length, 1)
  assert.deepEqual(result.skipped, [])
  // Taban görüntüsü baskıda, ilkellerin ALTINDA.
  assert.ok(
    result.html.includes(base.imageBase64.slice(0, 64)),
    'baskı HTML taşıyıcı tabanını taşımalı',
  )
  assert.ok(
    result.html.indexOf('class="lp-base"') <
      result.html.indexOf('class="lp lp-text"'),
    'taban ilkellerden ÖNCE gelmeli',
  )
  assert.ok(result.html.includes(SAFE_NOTE.text), 'kiracı eki de basılmalı')
})

test('BASE-14: TABAN YOKSA overlay BASILMAZ — boş etiket üretilmez', async () => {
  // Kritik güvenlik: overlay yalnız kiracı EKLERİNİ taşır. Taban olmadan
  // basmak, üzerinde sadece mağaza notu olan ve kargonun kullanamayacağı
  // BOŞ bir etiket üretirdi. Sessiz boş etiket yerine AÇIK atlama.
  const print = await load('/src/utils/browserLabelPrint.ts')
  assert.throws(
    () =>
      print.buildCleanLabelDocument(
        [PRINTABLE_ORDER],
        PRINT_TEMPLATE,
        {},
        [],
        OVERLAY_DOC,
        new Map(),
      ),
    /Taşıyıcı etiketi|taban katman/i,
    'tek sipariş atlanınca basılacak sayfa kalmaz → açık hata',
  )
})

test('BASE-15: STANDALONE belge tabansız basılmaya DEVAM eder', async () => {
  // Düzeltme standalone yolu ETKİLEMEZ: taban katman kavramı yalnız
  // overlay belgeler içindir.
  const print = await load('/src/utils/browserLabelPrint.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const standalone = system.findSystemTemplate('surat-classic-100x100')
  assert.ok(standalone, 'standalone şablon bulunmalı')
  const result = print.buildCleanLabelDocument(
    [PRINTABLE_ORDER],
    PRINT_TEMPLATE,
    {},
    [],
    standalone,
  )
  assert.equal(result.printable.length, 1)
  assert.deepEqual(result.skipped, [])
  assert.equal(
    result.html.includes('class="lp-base"'),
    false,
    'standalone belgede taban katman OLMAZ',
  )
})

/* ═══ BASE-16..17 — TAŞIYICI ŞABLON KİMLİĞİ ═══════════════════════ */

test('BASE-16: taşıyıcı şablon kimliği taban katmandan ÇÖZÜLÜR', async () => {
  const base = await baseLayer()
  assert.match(
    base.templateFingerprint,
    /^surat-real-v[12]\./,
    'parmak izi semantic modelden gelmeli',
  )
})

test('BASE-17: TAŞIYICI ŞABLONU DEĞİŞTİYSE uyarı çıkar, baskı DURMAZ', async () => {
  // Kiracı yerleşimi taşıyıcının O ANKİ şablonuna göre tasarlanır. Taşıyıcı
  // şablonunu değiştirirse (v1 → v2 geçişinde olduğu gibi) boş sanılan
  // şeritler dolu olabilir. Sessiz kalmak, eski yerleşimin yeni etikette
  // taşıyıcı alanının üstüne düşmesi demekti.
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const base = await baseLayer()

  // (a) AYNI şablon → uyarı YOK.
  const matching = renderer.renderLabelDocument(
    { ...overlayDocument([SAFE_NOTE]), mode: 'overlay', baseTemplateFingerprint: base.templateFingerprint },
    { data: LABEL_DATA, baseLayer: base },
  )
  assert.equal(
    matching.violations.some((v) => v.code === 'CARRIER_TEMPLATE_CHANGED'),
    false,
    'aynı şablonda uyarı olmamalı',
  )

  // (b) FARKLI şablon → uyarı VAR ama ENGELLEYİCİ değil.
  const drifted = renderer.renderLabelDocument(
    { ...overlayDocument([SAFE_NOTE]), mode: 'overlay', baseTemplateFingerprint: 'surat-real-v1.bq0.eski' },
    { data: LABEL_DATA, baseLayer: base },
  )
  const warning = drifted.violations.find(
    (v) => v.code === 'CARRIER_TEMPLATE_CHANGED',
  )
  assert.ok(warning, 'şablon değişikliği BİLDİRİLMELİ')
  assert.equal(warning.blocking, false, 'taşıyıcı etiketi yine doğru basılır')
  assert.match(warning.detail, /surat-real-v1\.bq0\.eski/)
  assert.equal(drifted.hasBlockingViolation, false)
})
