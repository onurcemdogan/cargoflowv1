import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ═══ ETİKET ŞABLONU DÜZENLEYİCİSİ — KABUL PAKETİ ════════════════════════
//
// Bu paket üç şeyi kanıtlar:
//   1. BELGE MODELİ kimliği korur (barkod/QR/takip değeri kiracıdan gelemez)
//      ve okunamayacak/taşan yerleşimi FAIL-CLOSED reddeder.
//   2. ÖNİZLEME İLE BASKI AYNI kaynaktan çıkar (tek renderer).
//   3. KALICILIK taslak/aktif ayrımını, sürüm çakışmasını ve KİRACI
//      İZOLASYONUNU uygular.
//
// ═══ TAŞIYICI SINIRI ════════════════════════════════════════════════════
// Düzenleyicinin HİÇBİR eylemi taşıyıcıya çıkmaz: TEMPLATE_EDITOR_CARRIER_CALLS=0.
// Ham Sürat artefaktı DEĞİŞMEZ, takip numarası/barkod DEĞİŞMEZ. Bu, hem
// yapısal (kaynak taraması) hem davranışsal (DB karşılaştırması) olarak
// doğrulanır.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

function migrationStatements() {
  const dir = join(root, 'drizzle')
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

async function makeDb() {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await load('/server/db/schema.ts')
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'label', slug: `label-${randomBytes(4).toString('hex')}` })
    .returning()
  return { pglite, db, schema, organizationId: org.id }
}

/** Yorumları kaldırır: kaynak taraması KODU ölçmelidir, düzyazıyı değil. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10))
}

/* ═══ EDITOR-01..06 — BELGE MODELİ VE KİMLİK KİLİDİ ═════════════════ */

test('EDITOR-01: sistem şablonlarının HEPSİ geçerlidir', async () => {
  const model = await load('/src/labels/labelDocument.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  assert.ok(system.SYSTEM_LABEL_TEMPLATES.length >= 3, 'en az 3 sistem şablonu')
  for (const template of system.SYSTEM_LABEL_TEMPLATES) {
    const validation = model.validateLabelDocument(template)
    assert.equal(
      validation.valid,
      true,
      `${template.id} geçersiz: ${JSON.stringify(validation.errors)}`,
    )
  }
})

test('EDITOR-02: barkod/QR/takip DEĞERİ şablondan YAZILAMAZ', async () => {
  const model = await load('/src/labels/labelDocument.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const base = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  const barcode = base.elements.find((element) => element.type === 'barcode')
  barcode.text = 'SAHTE-BARKOD-123'

  const validation = model.validateLabelDocument(base)
  assert.equal(validation.valid, false, 'kilitli öğeye metin yazımı reddedilmeli')
  assert.ok(
    validation.errors.some(
      (error) => error.code === 'LOCKED_ELEMENT_TEXT_OVERRIDE',
    ),
  )

  // Normalizasyon da SESSİZCE atmalı (kötü niyetli gövde koruması).
  const normalized = model.normalizeLabelDocument(base)
  const normalizedBarcode = normalized.elements.find(
    (element) => element.type === 'barcode',
  )
  assert.equal(
    normalizedBarcode.text,
    undefined,
    'kimlik öğesine metin normalizasyondan GEÇEMEZ',
  )
})

test('EDITOR-03: zorunlu öğe GİZLENEMEZ', async () => {
  const model = await load('/src/labels/labelDocument.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const doc = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  doc.elements.find((element) => element.type === 'address').visible = false
  const validation = model.validateLabelDocument(doc)
  assert.equal(validation.valid, false)
  assert.ok(
    validation.errors.some((error) => error.code === 'REQUIRED_ELEMENT_HIDDEN'),
  )
  // Normalizasyon zorunlu öğeyi GERİ AÇAR.
  const normalized = model.normalizeLabelDocument(doc)
  assert.equal(
    normalized.elements.find((element) => element.type === 'address').visible,
    true,
  )
})

test('EDITOR-04: tuval dışına taşan öğe REDDEDİLİR, normalizasyon KENETLER', async () => {
  const model = await load('/src/labels/labelDocument.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const doc = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  const target = doc.elements.find((element) => element.type === 'recipientName')
  target.x = 95
  target.width = 40
  assert.equal(model.validateLabelDocument(doc).valid, false)
  assert.ok(
    model
      .validateLabelDocument(doc)
      .errors.some((error) => error.code === 'OUT_OF_BOUNDS'),
  )
  const normalized = model.normalizeLabelDocument(doc)
  const clamped = normalized.elements.find(
    (element) => element.type === 'recipientName',
  )
  assert.ok(clamped.x + clamped.width <= 100.001, 'geometri tuvale kenetlenmeli')
})

test('EDITOR-05: okunamayacak kadar küçük barkod REDDEDİLİR', async () => {
  const model = await load('/src/labels/labelDocument.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const doc = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  const barcode = doc.elements.find((element) => element.type === 'barcode')
  barcode.width = 8
  barcode.height = 2
  const validation = model.validateLabelDocument(doc)
  assert.equal(validation.valid, false)
  assert.ok(
    validation.errors.some((error) => error.code === 'BELOW_MIN_SIZE'),
    'asgari okunabilir ölçü dayatılmalı',
  )
})

test('EDITOR-06: bilinmeyen öğe türü KABUL EDİLMEZ (beyaz liste)', async () => {
  const model = await load('/src/labels/labelDocument.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const doc = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  doc.elements.push({
    id: 'evil',
    type: 'process.env.SECRET',
    x: 0, y: 0, width: 10, height: 10, visible: true, z: 99,
  })
  assert.equal(model.validateLabelDocument(doc).valid, false)
  const normalized = model.normalizeLabelDocument(doc)
  assert.equal(
    normalized.elements.some((element) => element.id === 'evil'),
    false,
    'beyaz liste dışı öğe normalizasyondan GEÇEMEZ',
  )
})

/* ═══ EDITOR-07..09 — FİZİKSEL GEOMETRİ ════════════════════════════ */

test('EDITOR-07: 10×10 cm ve 203 dpi dönüşümü TEK yerdedir', async () => {
  const geometry = await load('/src/labels/labelGeometry.ts')
  assert.equal(geometry.LABEL_CANVAS_WIDTH_MM, 100)
  assert.equal(geometry.LABEL_CANVAS_HEIGHT_MM, 100)
  assert.equal(geometry.LABEL_PRINTER_DPI, 203)
  // 100 mm @203dpi = 799 dot (Sürat/Zebra yerleşimiyle uyumlu).
  assert.equal(geometry.mmToDots(100), 799)
  assert.equal(geometry.mmToDots(0), 0)
  // Gidiş-dönüş kayıpsıza yakın olmalı.
  assert.ok(Math.abs(geometry.dotsToMm(geometry.mmToDots(50)) - 50) < 0.1)
})

test('EDITOR-08: YAKINLAŞTIRMA fiziksel geometriyi DEĞİŞTİRMEZ', async () => {
  const geometry = await load('/src/labels/labelGeometry.ts')
  // Aynı piksel hareketi, farklı yakınlaştırmada FARKLI mm verir; ama
  // mm→px→mm gidiş dönüşü her yakınlaştırmada AYNI mm'ye döner.
  for (const zoom of [0.75, 1, 1.5, 2, 3]) {
    const mm = 42.5
    const px = geometry.mmToPx(mm, zoom)
    assert.ok(
      Math.abs(geometry.pxToMm(px, zoom) - mm) < 1e-9,
      `zoom ${zoom} gidiş-dönüş bozuldu`,
    )
  }
})

test('EDITOR-09: ızgara yakalaması ve tuval kenetleme', async () => {
  const geometry = await load('/src/labels/labelGeometry.ts')
  assert.equal(geometry.snapToGrid(3.4, 1), 3)
  assert.equal(geometry.snapToGrid(3.6, 1), 4)
  assert.equal(geometry.snapToGrid(3.6, 0), 3.6, 'ızgara kapalıyken yakalama YOK')
  assert.equal(geometry.clampToCanvas(-5, 20, 'x'), 0)
  assert.equal(geometry.clampToCanvas(95, 20, 'x'), 80)
})

/* ═══ EDITOR-10..14 — ÖNİZLEME / BASKI PARİTESİ VE MUHAFIZLAR ══════ */

async function renderWithPreview(documentOverride) {
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const previewSource = await load('/src/labels/labelPreviewSource.ts')
  const doc = documentOverride ?? system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  const preview = previewSource.buildEditorPreviewSource([])
  return { renderer, doc, preview, rendered: renderer.renderLabelDocument(doc, preview.source) }
}

test('EDITOR-10: ÖNİZLEME ve BASKI aynı ilkellerden üretilir (tek renderer)', async () => {
  const { rendered, doc, preview, renderer } = await renderWithPreview()
  // Aynı girdi → aynı çıktı (deterministik).
  const second = renderer.renderLabelDocument(doc, preview.source)
  assert.deepEqual(
    rendered.primitives,
    second.primitives,
    'renderer deterministik olmalı',
  )

  // Baskı HTML'i AYNI ilkellerden türer ve mm cinsinden konumlar taşır.
  const layer = await load('/src/labels/labelPrintHtml.ts')
  const html = layer.primitivesToPrintHtml(rendered.primitives)
  for (const primitive of rendered.primitives) {
    assert.ok(
      html.includes(`data-element-id="${primitive.elementId}"`),
      `${primitive.elementId} baskı çıktısında yok`,
    )
    assert.ok(
      html.includes(`left:${primitive.rect.x}mm`),
      `${primitive.elementId} baskı konumu mm cinsinden değil`,
    )
  }
})

test('EDITOR-11: baskı HTML yerleşimi TUVAL yerleşimiyle BİREBİR aynıdır', async () => {
  const { rendered } = await renderWithPreview()
  const layer = await load('/src/labels/labelPrintHtml.ts')
  const html = layer.primitivesToPrintHtml(rendered.primitives)
  // Her ilkel için left/top/width/height mm değerleri ilkelin kendisiyle eşleşmeli.
  for (const primitive of rendered.primitives) {
    const expected =
      `left:${primitive.rect.x}mm;top:${primitive.rect.y}mm;` +
      `width:${primitive.rect.width}mm;height:${primitive.rect.height}mm;`
    assert.ok(
      html.includes(expected),
      `${primitive.elementId} için geometri ayrıştı: ${expected}`,
    )
  }
})

test('EDITOR-12: UZUN ADRES taşması SESSİZCE kırpılmaz — açık muhafız', async () => {
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const previewSource = await load('/src/labels/labelPreviewSource.ts')
  const doc = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  // Adres kutusunu daralt: gerçek uzun Türkçe adres SIĞMAZ.
  const address = doc.elements.find((element) => element.type === 'address')
  address.height = 6
  address.maxLines = 1
  const stress = previewSource.buildStressPreviewSource()
  const rendered = renderer.renderLabelDocument(doc, stress.source)
  assert.equal(rendered.printable, false, 'taşan yerleşim basılabilir sayılmamalı')
  assert.ok(
    rendered.violations.some(
      (violation) => violation.code === 'LONG_ADDRESS_OVERFLOW_GUARD',
    ),
    'LONG_ADDRESS_OVERFLOW_GUARD tetiklenmeli',
  )
})

test('EDITOR-13: BARKOD ve QR üzerine binen öğe muhafızı', async () => {
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const previewSource = await load('/src/labels/labelPreviewSource.ts')
  const doc = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  const barcode = doc.elements.find((element) => element.type === 'barcode')
  const qr = doc.elements.find((element) => element.type === 'qr')
  const recipient = doc.elements.find((element) => element.type === 'recipientName')
  // Alıcı adını barkodun ÜSTÜNE taşı.
  recipient.x = barcode.x
  recipient.y = barcode.y
  const preview = previewSource.buildEditorPreviewSource([])
  let rendered = renderer.renderLabelDocument(doc, preview.source)
  assert.ok(
    rendered.violations.some(
      (violation) => violation.code === 'BARCODE_OVERLAP_GUARD',
    ),
    'BARCODE_OVERLAP_GUARD tetiklenmeli',
  )

  // QR için de aynı muhafız.
  recipient.x = qr.x
  recipient.y = qr.y
  recipient.width = qr.width
  recipient.height = qr.height
  rendered = renderer.renderLabelDocument(doc, preview.source)
  assert.ok(
    rendered.violations.some((violation) => violation.code === 'QR_OVERLAP_GUARD'),
    'QR_OVERLAP_GUARD tetiklenmeli',
  )
})

test('EDITOR-14: TÜM sistem şablonları gerçekçi veriyle TEMİZ basılır (negatif kontrol)', async () => {
  // Bu, muhafızların "her zaman kırmızı" olmadığını kanıtlar. Varsayılan bir
  // şablon gerçek bir siparişte ihlal üretiyorsa muhafız gürültüye döner ve
  // operatör onu görmezden gelmeyi öğrenir.
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const previewSource = await load('/src/labels/labelPreviewSource.ts')
  const preview = previewSource.buildEditorPreviewSource([])
  for (const template of system.SYSTEM_LABEL_TEMPLATES) {
    const rendered = renderer.renderLabelDocument(template, preview.source)
    assert.deepEqual(
      rendered.violations,
      [],
      `${template.id} beklenmeyen ihlal: ${JSON.stringify(rendered.violations)}`,
    )
    assert.equal(rendered.printable, true, `${template.id} basılabilir olmalı`)
  }
})

/* ═══ EDITOR-15..18 — GERİ AL / YİNELE ════════════════════════════ */

async function editorState() {
  const state = await load('/src/labels/labelEditorState.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  return {
    state,
    initial: state.createLabelEditorState(
      system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0]),
    ),
  }
}

test('EDITOR-15: ayrık değişiklik TEK geçmiş adımı üretir ve geri alınır', async () => {
  const { state, initial } = await editorState()
  const changed = state.labelEditorReducer(initial, {
    type: 'updateElement',
    elementId: 'address',
    patch: { fontSize: 12 },
  })
  assert.equal(state.canUndo(changed), true)
  assert.equal(
    changed.present.elements.find((element) => element.id === 'address').fontSize,
    12,
  )
  const undone = state.labelEditorReducer(changed, { type: 'undo' })
  assert.equal(
    undone.present.elements.find((element) => element.id === 'address').fontSize,
    9,
    'geri al eski puntoya dönmeli',
  )
  const redone = state.labelEditorReducer(undone, { type: 'redo' })
  assert.equal(
    redone.present.elements.find((element) => element.id === 'address').fontSize,
    12,
    'yinele değişikliği geri getirmeli',
  )
})

test('EDITOR-16: SÜRÜKLEME jesti TEK adım olur (piksel başına geçmiş YOK)', async () => {
  const { state, initial } = await editorState()
  let current = state.labelEditorReducer(initial, { type: 'beginGesture' })
  // 50 ara güncelleme — gerçek bir sürüklemede olduğu gibi.
  for (let step = 1; step <= 50; step += 1) {
    current = state.labelEditorReducer(current, {
      type: 'updateElement',
      elementId: 'address',
      patch: { x: 4 + step * 0.2 },
    })
  }
  assert.equal(current.past.length, 0, 'jest içinde geçmiş adımı üretilmemeli')
  current = state.labelEditorReducer(current, { type: 'endGesture' })
  assert.equal(current.past.length, 1, 'jest TEK adım olmalı')

  const undone = state.labelEditorReducer(current, { type: 'undo' })
  assert.equal(
    undone.present.elements.find((element) => element.id === 'address').x,
    4,
    'tek geri al jestin TAMAMINI geri almalı',
  )
})

test('EDITOR-17: değişiklik üretmeyen jest geçmişe adım EKLEMEZ', async () => {
  const { state, initial } = await editorState()
  let current = state.labelEditorReducer(initial, { type: 'beginGesture' })
  current = state.labelEditorReducer(current, { type: 'endGesture' })
  assert.equal(current.past.length, 0, 'tıkla-bırak adım üretmemeli')
  assert.equal(state.canUndo(current), false)
})

test('EDITOR-18: kirli durum kaydedince temizlenir', async () => {
  const { state, initial } = await editorState()
  assert.equal(state.isDirty(initial), false)
  const changed = state.labelEditorReducer(initial, {
    type: 'updateElement',
    elementId: 'address',
    patch: { bold: true },
  })
  assert.equal(state.isDirty(changed), true)
  const saved = state.labelEditorReducer(changed, { type: 'markSaved' })
  assert.equal(state.isDirty(saved), false)
})

/* ═══ EDITOR-19..26 — KALICILIK, SÜRÜM, KİRACI ════════════════════ */

test('EDITOR-19: kopyalama TASLAK doğurur — YAYINLAMAZ', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const record = await repo.createLabelDocumentFromSystem(
      db, organizationId, 'surat-classic-100x100', 'Depo şablonu',
      '2026-08-01T00:00:00.000Z', 'tpl_1',
    )
    assert.ok(record.draft, 'taslak oluşmalı')
    assert.equal(record.active, null, 'kopyalamak YAYINLAMAZ')
    const state = await repo.loadLabelDocuments(db, organizationId)
    assert.equal(state.activeTemplateId, null, 'aktif şablon değişmemeli')
  } finally {
    await pglite.close()
  }
})

test('EDITOR-20: TASLAK KAYDI aktif sürümü DEĞİŞTİRMEZ', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const now = '2026-08-01T00:00:00.000Z'
    let record = await repo.createLabelDocumentFromSystem(
      db, organizationId, 'surat-classic-100x100', 'Depo', now, 'tpl_1',
    )
    record = await repo.activateLabelDocument(db, organizationId, 'tpl_1', record.version, now)
    const publishedFont = record.active.elements.find(
      (element) => element.id === 'address',
    ).fontSize

    const edited = {
      ...record.draft,
      elements: record.draft.elements.map((element) =>
        element.id === 'address' ? { ...element, fontSize: 12 } : element,
      ),
    }
    const afterSave = await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_1', edited, record.version, now,
    )
    assert.equal(
      afterSave.draft.elements.find((element) => element.id === 'address').fontSize,
      12,
      'taslak güncellenmeli',
    )
    assert.equal(
      afterSave.active.elements.find((element) => element.id === 'address').fontSize,
      publishedFont,
      'AKTİF sürüm taslak kaydından ETKİLENMEMELİ',
    )
  } finally {
    await pglite.close()
  }
})

test('EDITOR-21: YAYINLAMA açık bir eylemdir ve kalıcıdır', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const now = '2026-08-01T00:00:00.000Z'
    let record = await repo.createLabelDocumentFromSystem(
      db, organizationId, 'minimal-ecommerce', 'Minimal', now, 'tpl_1',
    )
    record = await repo.activateLabelDocument(db, organizationId, 'tpl_1', record.version, now)
    assert.ok(record.active, 'aktif sürüm oluşmalı')

    // Yeni bir okuma (sayfa yenilemesi gibi) aktif şablonu KORUMALI.
    const active = await repo.resolveActiveLabelDocument(db, organizationId)
    assert.ok(active)
    assert.equal(active.id, 'tpl_1')
    const state = await repo.loadLabelDocuments(db, organizationId)
    assert.equal(state.activeTemplateId, 'tpl_1')
  } finally {
    await pglite.close()
  }
})

test('EDITOR-22: TASLAK yenilemeden sonra KORUNUR', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const now = '2026-08-01T00:00:00.000Z'
    const created = await repo.createLabelDocumentFromSystem(
      db, organizationId, 'minimal-ecommerce', 'Minimal', now, 'tpl_1',
    )
    const edited = {
      ...created.draft,
      elements: created.draft.elements.map((element) =>
        element.id === 'recipient' ? { ...element, x: 8, y: 14 } : element,
      ),
    }
    await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_1', edited, created.version, now,
    )
    const reloaded = await repo.loadLabelDocuments(db, organizationId)
    const recipient = reloaded.templates.tpl_1.draft.elements.find(
      (element) => element.id === 'recipient',
    )
    assert.equal(recipient.x, 8)
    assert.equal(recipient.y, 14)
  } finally {
    await pglite.close()
  }
})

test('EDITOR-23: SÜRÜM ÇAKIŞMASI sessizce üzerine yazmaz', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const now = '2026-08-01T00:00:00.000Z'
    const created = await repo.createLabelDocumentFromSystem(
      db, organizationId, 'minimal-ecommerce', 'Minimal', now, 'tpl_1',
    )
    // Birinci sekme kaydeder.
    const first = await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_1', created.draft, created.version, now,
    )
    // İkinci sekme ESKİ sürümle kaydetmeye çalışır → REDDEDİLİR.
    await assert.rejects(
      () =>
        repo.saveLabelDocumentDraft(
          db, organizationId, 'tpl_1', created.draft, created.version, now,
        ),
      (error) => error.code === 'VERSION_CONFLICT',
    )
    // Birincinin işi KORUNUR.
    const state = await repo.loadLabelDocuments(db, organizationId)
    assert.equal(state.templates.tpl_1.version, first.version)
  } finally {
    await pglite.close()
  }
})

test('EDITOR-24: KİRACI İZOLASYONU — A kiracısı B kiracısının şablonunu göremez/değiştiremez', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const now = '2026-08-01T00:00:00.000Z'
    const [orgB] = await db
      .insert(schema.organizations)
      .values({ name: 'b', slug: `b-${randomBytes(4).toString('hex')}` })
      .returning()

    await repo.createLabelDocumentFromSystem(
      db, organizationId, 'minimal-ecommerce', 'A şablonu', now, 'tpl_a',
    )

    // OKUMA: B kiracısı A'nın şablonunu GÖRMEZ.
    const bState = await repo.loadLabelDocuments(db, orgB.id)
    assert.deepEqual(Object.keys(bState.templates), [])

    // YAZMA: B kiracısı A'nın şablonunu DEĞİŞTİREMEZ.
    await assert.rejects(
      () =>
        repo.saveLabelDocumentDraft(db, orgB.id, 'tpl_a', {}, 1, now),
      (error) => error.code === 'NOT_FOUND',
    )
    // YAYINLAMA: B kiracısı A'nın şablonunu YAYINLAYAMAZ.
    await assert.rejects(
      () => repo.activateLabelDocument(db, orgB.id, 'tpl_a', 1, now),
      (error) => error.code === 'NOT_FOUND',
    )
    // SİLME: B kiracısı A'nın şablonunu SİLEMEZ.
    await assert.rejects(
      () => repo.deleteLabelDocument(db, orgB.id, 'tpl_a', now),
      (error) => error.code === 'NOT_FOUND',
    )
    // A'nın şablonu YERİNDE durmalı.
    const aState = await repo.loadLabelDocuments(db, organizationId)
    assert.ok(aState.templates.tpl_a)
  } finally {
    await pglite.close()
  }
})

test('EDITOR-25: BOZUK şablon gövdesi GÜVENLİ biçimde reddedilir', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const now = '2026-08-01T00:00:00.000Z'
    const created = await repo.createLabelDocumentFromSystem(
      db, organizationId, 'minimal-ecommerce', 'Minimal', now, 'tpl_1',
    )
    // Zorunlu öğeleri olmayan gövde: doğrulama FAIL-CLOSED reddetmeli.
    await assert.rejects(
      () =>
        repo.saveLabelDocumentDraft(
          db, organizationId, 'tpl_1',
          { schemaVersion: 1, id: 'tpl_1', name: 'x', elements: [] },
          created.version, now,
        ),
      (error) => error.code === 'INVALID_DOCUMENT',
    )
    // Kayıtlı taslak BOZULMAMALI.
    const state = await repo.loadLabelDocuments(db, organizationId)
    assert.ok(state.templates.tpl_1.draft.elements.length > 0)
  } finally {
    await pglite.close()
  }
})

test('EDITOR-26: settings_json içindeki DİĞER anahtarlar KORUNUR', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    await db.insert(schema.organizationSettings).values({
      organizationId,
      settingsJson: {
        shipmentDefaults: { defaultUnitDesi: 2 },
        labelTemplate: { version: 3, fields: [] },
      },
    })
    await repo.createLabelDocumentFromSystem(
      db, organizationId, 'minimal-ecommerce', 'Minimal',
      '2026-08-01T00:00:00.000Z', 'tpl_1',
    )
    const rows = await db.select().from(schema.organizationSettings)
    const settings = rows[0].settingsJson
    assert.deepEqual(
      settings.shipmentDefaults,
      { defaultUnitDesi: 2 },
      'desi ayarı KORUNMALI',
    )
    assert.equal(settings.labelTemplate.version, 3, 'eski şablon KORUNMALI')
    assert.ok(settings.labelDocuments, 'yeni anahtar eklenmeli')
  } finally {
    await pglite.close()
  }
})

/* ═══ EDITOR-27..32 — TAŞIYICI SINIRI VE ÖNİZLEME ═════════════════ */

const EDITOR_SOURCES = [
  'src/labels/labelDocument.ts',
  'src/labels/labelGeometry.ts',
  'src/labels/labelDocumentRenderer.ts',
  'src/labels/labelSystemTemplates.ts',
  'src/labels/labelEditorState.ts',
  'src/labels/labelPreviewSource.ts',
  'src/components/labels/LabelCanvas.tsx',
  'src/components/labels/LabelElementInspector.tsx',
  'src/components/labels/LabelPrimitiveLayer.tsx',
  'src/labels/labelPrintHtml.ts',
  'src/labels/labelElementLabels.ts',
  'src/pages/LabelTemplateEditorPage.tsx',
  'src/services/labelDocumentService.ts',
  'server/labels/labelDocumentRepository.ts',
]

test('EDITOR-27: TEMPLATE_EDITOR_CARRIER_CALLS=0 — düzenleyici taşıyıcıya ÇIKMAZ', async () => {
  const forbidden = [
    /OrtakBarkodOlustur/,
    /suratkargo\.com/i,
    /callSuratSoap/,
    /createShipment/i,
    /\/api\/shipments\/surat/,
    /\/api\/orders\/sync/,
    /callTrendyol/i,
  ]
  for (const relative of EDITOR_SOURCES) {
    const source = readFileSync(join(root, relative), 'utf8')
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${relative} yasak taşıyıcı/pazaryeri yolu içeriyor: ${pattern}`,
      )
    }
  }
})

test('EDITOR-28: düzenleyici istemcisi YALNIZ şablon uçlarına gider', async () => {
  // YORUMLAR ÇIKARILIR: bir uç adını AÇIKLAYAN yorum, o uca yapılan bir
  // ÇAĞRI değildir. (Aksi halde test, kodu değil düzyazıyı ölçerdi.)
  const service = stripComments(
    readFileSync(join(root, 'src/services/labelDocumentService.ts'), 'utf8'),
  )
  const urls = [...service.matchAll(/['"`](\/api\/[^'"`$]*)/g)].map((match) => match[1])
  assert.ok(urls.length > 0, 'en az bir uç bulunmalı')
  // AÇIK BEYAZ LİSTE. Sipariş ucu YALNIZ önizleme için TEK kayıt okur
  // (sayfa boyutu 1); yerel, salt okunur ve taşıyıcıya çıkmaz.
  const ALLOWED = ['/api/labels/documents', '/api/orders?page=1&pageSize=1']
  for (const url of urls) {
    assert.ok(
      ALLOWED.some((prefix) => url.startsWith(prefix)),
      `beklenmeyen uç: ${url}`,
    )
  }
  // Taşıyıcı/pazaryeri uçları HİÇBİR koşulda geçemez.
  for (const forbidden of ['/api/orders/sync', '/api/shipments', '/api/trendyol']) {
    assert.equal(
      service.includes(forbidden),
      false,
      `yasak uç: ${forbidden}`,
    )
  }
})

test('EDITOR-29: ÖNİZLEME kalıcı siparişten beslenir, taşıyıcı ÇAĞRILMAZ', async () => {
  const previewSource = await load('/src/labels/labelPreviewSource.ts')
  const order = {
    id: 'o1',
    orderNumber: 'ORD-1',
    marketplace: 'Trendyol',
    customerName: 'Şükrü Öz',
    customerFirstName: 'Şükrü',
    customerLastName: 'Öz',
    address: 'Test Mah. 1 Sok. No 2',
    city: 'İZMİR',
    district: 'BORNOVA',
    items: [
      { productName: 'Ürün A', quantity: 1, sku: 'SKU-1' },
      { productName: 'Ürün B', quantity: 2, sku: 'SKU-2' },
    ],
  }
  const preview = previewSource.buildEditorPreviewSource([order])
  assert.equal(preview.isDemo, false, 'gerçek sipariş varken DEMO kullanılmamalı')
  assert.equal(preview.orderNumber, 'ORD-1')
  assert.equal(preview.source.data.recipientName.length > 0, true)
})

test('EDITOR-30: uygun sipariş YOKSA demo AÇIKÇA işaretlenir', async () => {
  const previewSource = await load('/src/labels/labelPreviewSource.ts')
  const preview = previewSource.buildEditorPreviewSource([])
  assert.equal(preview.isDemo, true)
  assert.match(
    preview.source.data.recipientName,
    /DEMO/,
    'demo veri açıkça DEMO olarak işaretlenmeli',
  )
})

test('EDITOR-31: şablon değişikliği taşıyıcı çağrısı GEREKTİRMEZ (kayıtlı sözleşme)', async () => {
  const tenant = await load('/server/labels/tenantLabelTemplate.ts')
  assert.equal(tenant.templateChangeRequiresCarrierCall(), false)
})

test('EDITOR-32: HAM taşıyıcı artefaktı kaydet/yayınla sonrası DEĞİŞMEZ', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const now = '2026-08-01T00:00:00.000Z'
    // Kayıtlı bir gönderi (ham artefakt) tohumla.
    await db.insert(schema.shipments).values({
      organizationId,
      marketplace: 'Trendyol',
      packageId: 'PKG-1',
      orderNumber: 'ORD-1',
      provider: 'surat',
      source: 'local_create',
      status: 'created',
      trackingNumber: '11419469827',
      carrierPayloadEncrypted: null,
    })
    const before = await db.select().from(schema.shipments)

    const created = await repo.createLabelDocumentFromSystem(
      db, organizationId, 'minimal-ecommerce', 'Minimal', now, 'tpl_1',
    )
    const saved = await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_1', created.draft, created.version, now,
    )
    await repo.activateLabelDocument(db, organizationId, 'tpl_1', saved.version, now)

    const after = await db.select().from(schema.shipments)
    assert.equal(after.length, before.length, 'gönderi satır sayısı DEĞİŞMEMELİ')
    assert.equal(
      after[0].trackingNumber,
      before[0].trackingNumber,
      'TRACKING_CHANGED=NO',
    )
    assert.equal(
      after[0].carrierPayloadEncrypted,
      before[0].carrierPayloadEncrypted,
      'RAW_SURAT_ARTIFACT_CHANGED=NO',
    )
    assert.equal(after[0].status, before[0].status, 'gönderi statüsü DEĞİŞMEMELİ')
  } finally {
    await pglite.close()
  }
})

/* ═══ EDITOR-33..34 — KAYIT VE ERİŞİM ════════════════════════════ */

test('EDITOR-33: kabul paketi ve komut KAYITLI', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(
    pkg.scripts['test:label-editor:acceptance'],
    'test:label-editor:acceptance komutu tanımlı olmalı',
  )
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/label-editor-acceptance-flow.test.mjs'))
})

test('EDITOR-34: uçlar AUTH kapısının arkasında ve rota lazy', async () => {
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  const authList = server.slice(
    server.indexOf('const TENANT_AUTH_PATHS'),
    server.indexOf('const TENANT_INJECT_PATHS'),
  )
  assert.match(authList, /'\/api\/labels\/documents'/)
  for (const route of [
    "app.get('/api/labels/documents'",
    "app.post('/api/labels/documents'",
    "app.put('/api/labels/documents/:id/draft'",
    "app.post('/api/labels/documents/:id/activate'",
  ]) {
    assert.ok(server.includes(route), `${route} kayıtlı değil`)
  }
  // Düzenleyici rotası TEMBEL yüklenir: ilk yüke girmez.
  const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8')
  assert.match(app, /const LabelTemplateEditorPage = lazy\(/)
})

/* ═══ EDITOR-35..38 — YAYINLANAN YERLEŞİM GERÇEKTEN BASILIR ═══════════ */

test('EDITOR-35: baskı sayfası, tuvalin kullandığı AYNI ilkellerden üretilir', async () => {
  const printer = await load('/src/utils/browserLabelPrint.ts')
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const previewSource = await load('/src/labels/labelPreviewSource.ts')

  const doc = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  const preview = previewSource.buildEditorPreviewSource([])
  const html = printer.renderDocumentLabelHtml(doc, preview.source)
  const rendered = renderer.renderLabelDocument(doc, preview.source)

  assert.ok(html.length > 0, 'baskı sayfası üretilmeli')
  for (const primitive of rendered.primitives) {
    const expected =
      `left:${primitive.rect.x}mm;top:${primitive.rect.y}mm;` +
      `width:${primitive.rect.width}mm;height:${primitive.rect.height}mm;`
    assert.ok(
      html.includes(expected),
      `${primitive.elementId} baskıda tuvalden FARKLI konumda: ${expected}`,
    )
  }
})

test('EDITOR-36: KİMLİK değerleri etiket verisinden gelir, şablondan DEĞİL', async () => {
  const printer = await load('/src/utils/browserLabelPrint.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const previewSource = await load('/src/labels/labelPreviewSource.ts')

  const doc = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  // Kötü niyetli/bozuk bir şablon kimlik öğesine metin yazmaya çalışsın.
  doc.elements.find((element) => element.type === 'barcode').text = 'SAHTE-123'
  doc.elements.find((element) => element.type === 'qr').text = 'SAHTE-QR'

  const preview = previewSource.buildEditorPreviewSource([])
  const html = printer.renderDocumentLabelHtml(doc, preview.source)
  assert.equal(
    html.includes('SAHTE-123'),
    false,
    'şablon barkod DEĞERİNİ yazamaz',
  )
  assert.equal(html.includes('SAHTE-QR'), false, 'şablon QR yükünü yazamaz')
  assert.ok(
    html.includes(`data-barcode-value="${preview.source.data.barcodeValue}"`),
    'barkod değeri etiket verisinden gelmeli',
  )
})

test('EDITOR-37: YAYINLANMIŞ belge YOKSA yerleşik yerleşim korunur', async () => {
  // Sürüm yükseltmesi hiçbir kiracının etiketini KENDİLİĞİNDEN değiştirmez.
  const source = readFileSync(join(root, 'src/utils/browserLabelPrint.ts'), 'utf8')
  assert.match(
    source,
    /labelDocument[\s\S]{0,20}\?[\s\S]{0,20}renderDocumentLabelHtml\(/,
    'belge varsa belge yolu kullanılmalı',
  )
  assert.match(
    source,
    /:\s*renderPrintableLabelHtml\(printData\)/,
    'belge yoksa yerleşik yerleşim kullanılmalı',
  )
})

test('EDITOR-38: yayınlanan belge baskı yoluna UÇTAN UCA bağlanır', async () => {
  const provider = readFileSync(
    join(root, 'src/providers/printing/BrowserDownloadPrintProvider.ts'), 'utf8',
  )
  assert.match(provider, /input\.labelDocument/, 'sağlayıcı belgeyi iletmeli')

  const service = readFileSync(
    join(root, 'src/services/orderWorkflowService.ts'), 'utf8',
  )
  assert.match(service, /labelDocument: options\.labelDocument/)

  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  const passes = app.match(/labelDocument: activeLabelDocument \?\? undefined/g)
  assert.ok(
    passes && passes.length >= 2,
    `App her iki baskı yolunda belgeyi geçmeli (bulunan: ${passes?.length ?? 0})`,
  )
  // Düzenleyici yayınladığında baskı yolu ANINDA güncellenir.
  assert.match(app, /onActiveDocumentChange=\{handleActiveLabelDocumentChange\}/)

  // Resmî Sürat ZPL yolu bu belgeden ETKİLENMEZ (gövdesini taşıyıcı basar).
  assert.match(
    provider,
    /input\.labelPrintTemplate === 'surat_official_zpl'/,
  )
})

/* ═══ EDITOR-39..42 — ENGELLEYİCİ İHLAL YAYINLAMAYI DURDURUR ═════════ */

test('EDITOR-39: kimlik üstüne binme ENGELLEYİCİ, içerik taşması UYARIDIR', async () => {
  // ═══ NEDEN AYRIM ═══════════════════════════════════════════════════
  // Barkodun üstüne bir metin bindiyse etiket HANGİ sipariş basılırsa
  // basılsın bozuktur → yayınlama DURDURULUR. Uzun bir adres tek bir uç
  // siparişte taşıyorsa yerleşimin kendisi bozuk değildir → UYARI verilir,
  // ama tek aykırı kayıt tüm şablonu kilitlemez.
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const previewSource = await load('/src/labels/labelPreviewSource.ts')

  // (a) Kimlik üstüne binme → ENGELLEYİCİ
  const overlap = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  const barcode = overlap.elements.find((element) => element.type === 'barcode')
  const recipient = overlap.elements.find(
    (element) => element.type === 'recipientName',
  )
  recipient.x = barcode.x
  recipient.y = barcode.y
  const overlapRendered = renderer.renderLabelDocument(
    overlap,
    previewSource.buildEditorPreviewSource([]).source,
  )
  assert.equal(overlapRendered.hasBlockingViolation, true)
  assert.ok(
    overlapRendered.violations
      .filter((violation) => violation.code === 'BARCODE_OVERLAP_GUARD')
      .every((violation) => violation.blocking === true),
  )

  // (b) İçerik taşması → UYARI (yayınlamayı engellemez)
  const overflow = system.cloneDocument(system.SYSTEM_LABEL_TEMPLATES[0])
  const address = overflow.elements.find((element) => element.type === 'address')
  address.maxLines = 1
  const overflowRendered = renderer.renderLabelDocument(
    overflow,
    previewSource.buildStressPreviewSource().source,
  )
  assert.equal(overflowRendered.printable, false, 'uyarı da bir ihlaldir')
  assert.ok(
    overflowRendered.violations.some(
      (violation) => violation.code === 'LONG_ADDRESS_OVERFLOW_GUARD',
    ),
  )
  assert.equal(
    overflowRendered.hasBlockingViolation,
    false,
    'veriye bağlı taşma yayınlamayı ENGELLEMEZ',
  )
})

test('EDITOR-40: temiz yerleşimde engelleyici ihlal YOKTUR (negatif kontrol)', async () => {
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const system = await load('/src/labels/labelSystemTemplates.ts')
  const previewSource = await load('/src/labels/labelPreviewSource.ts')
  const preview = previewSource.buildEditorPreviewSource([])
  for (const template of system.SYSTEM_LABEL_TEMPLATES) {
    const rendered = renderer.renderLabelDocument(template, preview.source)
    assert.equal(
      rendered.hasBlockingViolation,
      false,
      `${template.id} engelleyici ihlal üretmemeli`,
    )
  }
})

test('EDITOR-41: YAYINLA düğmesi engelleyici ihlalde KAPALIDIR', async () => {
  const page = readFileSync(
    join(root, 'src/pages/LabelTemplateEditorPage.tsx'), 'utf8',
  )
  const at = page.indexOf("data-testid=\"editor-activate\"")
  assert.notEqual(at, -1, 'yayınla düğmesi bulunamadı')
  const block = page.slice(at, at + 500)
  assert.match(block, /rendered\?\.hasBlockingViolation === true/)
  // Taslak kaydetmek ENGELLENMEZ: yarım kalmış iş kaybolmamalıdır.
  const saveAt = page.indexOf("data-testid=\"editor-save-draft\"")
  const saveBlock = page.slice(saveAt, saveAt + 260)
  assert.doesNotMatch(saveBlock, /hasBlockingViolation/)
})

test('EDITOR-42: düzenleyici, havuz boşken ÖNİZLEME SİPARİŞİNİ kendisi çeker', async () => {
  // Doğrudan düzenleyiciye gelen operatör uydurma DEMO veriyle yerleşim
  // yapmak zorunda kalmamalıdır. Çekilen şey TEK kayıttır (tam koleksiyon
  // DEĞİL) ve mevcut `/api/orders` sözleşmesini kullanır.
  const service = readFileSync(
    join(root, 'src/services/labelDocumentService.ts'), 'utf8',
  )
  assert.match(service, /\/api\/orders\?page=1&pageSize=1/)
  const page = readFileSync(
    join(root, 'src/pages/LabelTemplateEditorPage.tsx'), 'utf8',
  )
  assert.match(page, /fetchPreviewOrder\(\)/)
  assert.match(page, /orders\.length > 0 \? orders : fetchedPreviewOrder/)
})
