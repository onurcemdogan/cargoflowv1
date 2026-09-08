import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ═══ ESKİ ŞABLONDAN OVERLAY'E GÖÇ — MEVCUT KİRACI UYUMLULUĞU ════════════
//
// ═══ NEDEN BU PAKET VAR ══════════════════════════════════════════════════
// Taban katman mimarisi YENİ şablonlar için doğrudur. Ama üretimde ZATEN
// yayınlanmış, etiketin TAMAMINI çizen eski şablonlar var. Bir sürüm
// yükseltmesi onların çıktısını KENDİLİĞİNDEN değiştiremez; öte yandan
// kiracı sonsuza dek eski davranışta da bırakılamaz.
//
// Bu paket güvenli yolu kilitler:
//   · eski şablon OLDUĞU GİBİ korunur (aktif çıktı değişmez),
//   · göç YENİ bir TASLAK üretir, yayınlamaz,
//   · taşıyıcının bastığı her alan taslaktan DÜŞER (çift basım olmaz),
//   · kiracıya ait içerik korunur, gerekirse serbest şeride taşınır,
//   · göç TEKRARLANABİLİR ve öğe ÇOĞALTMAZ.
//
// TAŞIYICI/PAZARYERİ ÇAĞRISI YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

/* ═══ AĞ TUZAĞI ═══════════════════════════════════════════════════════ */
const networkCalls = []
const realFetch = globalThis.fetch
globalThis.fetch = (...args) => {
  networkCalls.push(String(args[0]?.url ?? args[0] ?? ''))
  throw new Error('AĞ ÇAĞRISI YASAK: göç yolu taşıyıcıya ÇIKMAZ.')
}
after(() => {
  globalThis.fetch = realFetch
})

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
  const orgs = []
  for (const name of ['tenant-a', 'tenant-b']) {
    const [org] = await db
      .insert(schema.organizations)
      .values({ name, slug: `${name}-${randomBytes(4).toString('hex')}` })
      .returning()
    orgs.push(org.id)
  }
  return { pglite, db, schema, organizationId: orgs[0], otherOrganizationId: orgs[1] }
}

const CARRIER_ZPL = readFileSync(
  join(root, 'server', 'fixtures', 'surat-real-v2-numeric.zpl'),
  'utf8',
)

let _zones
async function carrierZones() {
  if (_zones) return _zones
  const base = await load('/src/labels/labelBaseLayer.ts')
  _zones = base.deriveCarrierZones(CARRIER_ZPL)
  return _zones
}

/**
 * ÜRETİMDEKİ ESKİ ŞABLONUN GERÇEK ŞEKLİ.
 *
 * `mode` alanı YOKTUR: bu alan mimari değişiklikten SONRA eklendi. Kayıt
 * böyle okunduğunda `standalone` sayılmalıdır — mevcut kiracı verisinin
 * birebir taklidi budur.
 */
const LEGACY_STANDALONE = {
  schemaVersion: 1,
  id: 'tpl_legacy',
  name: 'Eski Tam Etiket',
  elements: [
    { id: 'recipient', type: 'recipientName', x: 4, y: 4, width: 92, height: 7, z: 1, visible: true, fontSize: 13, bold: true },
    { id: 'address', type: 'address', x: 4, y: 17, width: 92, height: 18, z: 3, visible: true, fontSize: 9, wrap: true, maxLines: 4 },
    { id: 'city', type: 'cityDistrict', x: 4, y: 36, width: 92, height: 7, z: 4, visible: true, fontSize: 12 },
    { id: 'barcode', type: 'barcode', x: 4, y: 45, width: 92, height: 18, z: 5, visible: true },
    { id: 'tracking', type: 'trackingText', x: 4, y: 64, width: 92, height: 6, z: 6, visible: true, fontSize: 10 },
    { id: 'qr', type: 'qr', x: 78, y: 71, width: 18, height: 18, z: 8, visible: true },
    { id: 'phone', type: 'phone', x: 4, y: 11.5, width: 92, height: 5, z: 2, visible: true, fontSize: 9 },
    { id: 'cargo-meta', type: 'cargoMeta', x: 4, y: 92, width: 92, height: 5, z: 10, visible: true, fontSize: 8 },
    // ── KİRACIYA AİT içerik: taşıyıcı etiketinde YOKTUR, korunmalı ──
    { id: 'store-note', type: 'staticText', x: 4, y: 30, width: 60, height: 4, z: 11, visible: true, fontSize: 7, text: 'Bizi tercih ettiğiniz için teşekkürler' },
    { id: 'products', type: 'productList', x: 4, y: 77, width: 70, height: 14, z: 9, visible: true, fontSize: 7, wrap: true, maxLines: 4 },
    { id: 'marketplace', type: 'marketplace', x: 4, y: 50, width: 30, height: 4, z: 12, visible: true, fontSize: 6 },
  ],
}

async function seedLegacy(db, schema, organizationId, document = LEGACY_STANDALONE) {
  const repo = await load('/server/labels/labelDocumentRepository.ts')
  // Doğrudan ayar satırına yazılır: ÜRETİMDE mevcut kaydın şekli budur.
  await db.insert(schema.organizationSettings).values({
    organizationId,
    settingsJson: {
      labelDocuments: {
        activeTemplateId: document.id,
        templates: {
          [document.id]: {
            id: document.id,
            name: document.name,
            version: 3,
            updatedAt: '2026-01-01T00:00:00.000Z',
            activatedAt: '2026-01-01T00:00:00.000Z',
            draft: document,
            active: document,
          },
        },
      },
    },
  })
  return repo
}

/* ═══ MIG-01..02 — MEVCUT DURUM KORUNUR ════════════════════════════ */

test('MIG-01: özel şablonu OLMAYAN kiracı → taşıyıcı orijinali', async () => {
  const { pglite, db, organizationId } = await makeDb()
  try {
    const repo = await load('/server/labels/labelDocumentRepository.ts')
    const layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'carrier_original')
    assert.equal(layer.document, null)
  } finally {
    await pglite.close()
  }
})

test('MIG-02: ESKİ standalone şablon AYNEN korunur (aktif çıktı değişmez)', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const repo = await seedLegacy(db, schema, organizationId)
    const layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'active', 'aktif özel şablon KORUNMALI')
    // `mode` alanı olmayan kayıt STANDALONE sayılır: eski davranış sürer.
    assert.equal(layer.document.mode, 'standalone')
    assert.equal(layer.document.elements.length, LEGACY_STANDALONE.elements.length)
    assert.ok(
      layer.document.elements.some((element) => element.type === 'barcode'),
      'eski şablonun kendi barkodu YERİNDE kalmalı',
    )
  } finally {
    await pglite.close()
  }
})

/* ═══ MIG-03..08 — GÖÇ TASLAĞI ═════════════════════════════════════ */

async function runMigration(db, schema, organizationId) {
  const repo = await seedLegacy(db, schema, organizationId)
  const zones = await carrierZones()
  const result = await repo.migrateTemplateToOverlay(
    db,
    organizationId,
    'tpl_legacy',
    zones,
    '2026-08-01T00:00:00.000Z',
    'tpl_migrated',
    'surat-real-v2.bq1.pw799',
  )
  return { repo, result, zones }
}

test('MIG-03: göç YENİ overlay TASLAĞI üretir, yayınlamaz', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const { repo, result } = await runMigration(db, schema, organizationId)
    assert.equal(result.created, true)
    assert.equal(result.record.id, 'tpl_migrated')
    assert.equal(result.record.draft.mode, 'overlay')
    assert.equal(result.record.active, null, 'göç YAYINLAMAZ')
    assert.equal(result.record.migratedFrom, 'tpl_legacy')
    assert.equal(
      result.record.draft.baseTemplateFingerprint,
      'surat-real-v2.bq1.pw799',
    )
    // ÜRETİM ÇIKTISI DEĞİŞMEDİ: aktif hâlâ eski şablon.
    const layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.document.id, 'tpl_legacy')
  } finally {
    await pglite.close()
  }
})

test('MIG-04: ESKİ sürüm göçten sonra AYNEN geri alınabilir', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const { repo } = await runMigration(db, schema, organizationId)
    const state = await repo.loadLabelDocuments(db, organizationId)
    const legacy = state.templates.tpl_legacy
    assert.ok(legacy, 'eski kayıt SİLİNMEMELİ')
    assert.deepEqual(
      legacy.active.elements.map((element) => element.id).sort(),
      LEGACY_STANDALONE.elements.map((element) => element.id).sort(),
      'eski şablonun öğeleri DEĞİŞMEMELİ',
    )
    assert.equal(legacy.active.mode, 'standalone')
  } finally {
    await pglite.close()
  }
})

const STRIPPED = [
  { id: 'barcode', label: 'MIG-05 barkod' },
  { id: 'qr', label: 'MIG-06 QR' },
  { id: 'address', label: 'MIG-07 adres' },
  { id: 'recipient', label: 'MIG-07 alıcı adı' },
  { id: 'tracking', label: 'MIG-07 takip' },
  { id: 'city', label: 'MIG-07 il/ilçe' },
  { id: 'phone', label: 'MIG-07 telefon' },
  { id: 'cargo-meta', label: 'MIG-07 desi/paket' },
]

for (const entry of STRIPPED) {
  test(`${entry.label}: taşıyıcıya ait öğe taslaktan DÜŞER`, async () => {
    const { pglite, db, schema, organizationId } = await makeDb()
    try {
      const { result } = await runMigration(db, schema, organizationId)
      assert.equal(
        result.record.draft.elements.some((element) => element.id === entry.id),
        false,
        `${entry.id} overlay'e kopyalanmamalı`,
      )
      const warning = result.warnings.find((item) => item.elementId === entry.id)
      assert.ok(warning, 'düşen öğe SESSİZ kalmamalı')
      assert.equal(warning.code, 'CARRIER_OWNED_DROPPED')
      assert.match(warning.detail, /ZATEN basılıyor/)
    } finally {
      await pglite.close()
    }
  })
}

test('MIG-08: KİRACIYA ait içerik KORUNUR', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const { result, zones } = await runMigration(db, schema, organizationId)
    const ids = result.record.draft.elements.map((element) => element.id)
    for (const kept of ['store-note', 'products', 'marketplace']) {
      assert.ok(ids.includes(kept), `${kept} korunmalı`)
    }
    // Korunan öğeler taşıyıcı bölgelerinin ÜSTÜNDE olamaz.
    const geometry = await load('/src/labels/labelGeometry.ts')
    const base = await load('/src/labels/labelBaseLayer.ts')
    for (const element of result.record.draft.elements) {
      for (const zone of zones) {
        if (!base.zoneBlocksOverlay(zone)) continue
        assert.equal(
          geometry.rectsOverlap(zone.rect, {
            x: element.x, y: element.y, width: element.width, height: element.height,
          }),
          false,
          `${element.id} ${zone.label} bölgesine biniyor`,
        )
      }
    }
    // Metin İÇERİĞİ korunur.
    const note = result.record.draft.elements.find((e) => e.id === 'store-note')
    assert.equal(note.text, 'Bizi tercih ettiğiniz için teşekkürler')
  } finally {
    await pglite.close()
  }
})

/* ═══ MIG-09..12 — YAŞAM DÖNGÜSÜ ═══════════════════════════════════ */

test('MIG-09: göç taslağı YAYINLANINCA birleşik çıktı aktifleşir', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const { repo, result } = await runMigration(db, schema, organizationId)
    const activated = await repo.activateLabelDocument(
      db, organizationId, 'tpl_migrated', result.record.version,
      '2026-08-02T00:00:00.000Z',
    )
    assert.equal(activated.active.mode, 'overlay')
    const layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'active')
    assert.equal(layer.document.id, 'tpl_migrated')
    assert.equal(layer.document.mode, 'overlay')
  } finally {
    await pglite.close()
  }
})

test('MIG-10: rollback önceki sürüme döner', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const { repo, result } = await runMigration(db, schema, organizationId)
    const v1 = await repo.activateLabelDocument(
      db, organizationId, 'tpl_migrated', result.record.version, '2026-08-02T00:00:00.000Z',
    )
    const changed = {
      ...v1.active,
      elements: v1.active.elements.filter((e) => e.id !== 'marketplace'),
    }
    const saved = await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_migrated', changed, v1.version, '2026-08-03T00:00:00.000Z',
    )
    const v2 = await repo.activateLabelDocument(
      db, organizationId, 'tpl_migrated', saved.version, '2026-08-04T00:00:00.000Z',
    )
    assert.equal(v2.active.elements.some((e) => e.id === 'marketplace'), false)

    const rolled = await repo.rollbackLabelDocument(
      db, organizationId, 'tpl_migrated', v2.version, '2026-08-05T00:00:00.000Z',
    )
    assert.equal(
      rolled.active.elements.some((e) => e.id === 'marketplace'),
      true,
      'v1 geri gelmeli',
    )
  } finally {
    await pglite.close()
  }
})

test('MIG-11: orijinale dönüş SAF taban verir, özel sürümler SİLİNMEZ', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const { repo, result } = await runMigration(db, schema, organizationId)
    await repo.activateLabelDocument(
      db, organizationId, 'tpl_migrated', result.record.version, '2026-08-02T00:00:00.000Z',
    )
    await repo.revertToCarrierOriginal(db, organizationId, '2026-08-03T00:00:00.000Z')
    let layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'carrier_original')
    assert.equal(layer.document, null)

    // ÖZEL ŞABLON TEKRAR ETKİNLEŞTİRİLEBİLİR — sıfırdan kurmak GEREKMEZ.
    const state = await repo.loadLabelDocuments(db, organizationId)
    const record = state.templates.tpl_migrated
    assert.ok(record.active, 'aktif sürüm kaydı korunmalı')
    await repo.activateLabelDocument(
      db, organizationId, 'tpl_migrated', record.version, '2026-08-04T00:00:00.000Z',
    )
    layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'active')
    assert.equal(layer.document.id, 'tpl_migrated')
  } finally {
    await pglite.close()
  }
})

test('MIG-12: BOZUK overlay baskıyı durdurmaz — önceki iyi sürüme düşer', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const { repo, result } = await runMigration(db, schema, organizationId)
    const v1 = await repo.activateLabelDocument(
      db, organizationId, 'tpl_migrated', result.record.version, '2026-08-02T00:00:00.000Z',
    )
    const saved = await repo.saveLabelDocumentDraft(
      db, organizationId, 'tpl_migrated',
      { ...v1.active, elements: v1.active.elements.map((e) => ({ ...e, z: e.z + 1 })) },
      v1.version, '2026-08-03T00:00:00.000Z',
    )
    await repo.activateLabelDocument(
      db, organizationId, 'tpl_migrated', saved.version, '2026-08-04T00:00:00.000Z',
    )

    const { eq } = await import('drizzle-orm')
    const rows = await db
      .select()
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, organizationId))
    const settings = JSON.parse(JSON.stringify(rows[0].settingsJson))
    settings.labelDocuments.templates.tpl_migrated.active.elements = [
      { id: 'x', type: 'barcode', x: -50, y: -50, width: 0, height: 0, z: 1, visible: true },
    ]
    await db
      .update(schema.organizationSettings)
      .set({ settingsJson: settings })
      .where(eq(schema.organizationSettings.organizationId, organizationId))

    const layer = await repo.resolveActiveLabelLayer(db, organizationId)
    assert.equal(layer.tier, 'previous')
    assert.ok(layer.document, 'baskı belgesiz KALMAZ')
    assert.ok(layer.reason, 'düşme nedeni kayda geçmeli')
  } finally {
    await pglite.close()
  }
})

/* ═══ MIG-13..17 — GÜVENLİK VE TEKRARLANABİLİRLİK ══════════════════ */

test('MIG-13: göç sırasında TAŞIYICI ÇAĞRISI = 0', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    await runMigration(db, schema, organizationId)
    assert.deepEqual(networkCalls, [], 'hiçbir ağ çağrısı olmamalı')
  } finally {
    await pglite.close()
  }
})

test('MIG-14: göç HAM taşıyıcı artefaktına DOKUNMAZ', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    await db.insert(schema.shipments).values({
      organizationId,
      marketplace: 'Trendyol',
      packageId: 'PKG-MIG',
      orderNumber: 'ORD-MIG',
      provider: 'surat',
      source: 'local_create',
      status: 'created',
      trackingNumber: '11415535074',
      carrierPayloadEncrypted: 'sabit-sifreli-yuk',
    })
    const before = await db.select().from(schema.shipments)
    await runMigration(db, schema, organizationId)
    const after = await db.select().from(schema.shipments)
    assert.equal(after.length, before.length)
    assert.equal(after[0].carrierPayloadEncrypted, before[0].carrierPayloadEncrypted)
    assert.equal(after[0].trackingNumber, before[0].trackingNumber)
    assert.equal(after[0].status, before[0].status)
  } finally {
    await pglite.close()
  }
})

test('MIG-15: KİRACI İZOLASYONU — göç başka organizasyonu etkilemez', async () => {
  const { pglite, db, schema, organizationId, otherOrganizationId } = await makeDb()
  try {
    const repo = await seedLegacy(db, schema, organizationId)
    await seedLegacy(db, schema, otherOrganizationId, {
      ...LEGACY_STANDALONE,
      id: 'tpl_legacy',
      name: 'B kiracısı şablonu',
    })
    const zones = await carrierZones()
    await repo.migrateTemplateToOverlay(
      db, organizationId, 'tpl_legacy', zones, '2026-08-01T00:00:00.000Z', 'tpl_migrated',
    )
    const other = await repo.loadLabelDocuments(db, otherOrganizationId)
    assert.equal(Object.keys(other.templates).length, 1, 'B kiracısında yeni kayıt OLMAMALI')
    assert.equal(other.templates.tpl_migrated, undefined)
    assert.equal(other.activeTemplateId, 'tpl_legacy')
    // B kiracısının şablonu için göç istenirse A'nınki etkilenmez.
    await repo.migrateTemplateToOverlay(
      db, otherOrganizationId, 'tpl_legacy', zones, '2026-08-01T00:00:00.000Z', 'tpl_b',
    )
    const mine = await repo.loadLabelDocuments(db, organizationId)
    assert.equal(mine.templates.tpl_b, undefined)
  } finally {
    await pglite.close()
  }
})

test('MIG-16/17: göç İDEMPOTENT — tekrar çağrı overlay ÇOĞALTMAZ', async () => {
  const { pglite, db, schema, organizationId } = await makeDb()
  try {
    const { repo, result, zones } = await runMigration(db, schema, organizationId)
    const first = result.record.draft.elements.length
    const again = await repo.migrateTemplateToOverlay(
      db, organizationId, 'tpl_legacy', zones, '2026-08-09T00:00:00.000Z', 'tpl_other',
    )
    assert.equal(again.created, false, 'ikinci göç YENİ kayıt üretmemeli')
    assert.equal(again.record.id, 'tpl_migrated')
    const state = await repo.loadLabelDocuments(db, organizationId)
    assert.equal(state.templates.tpl_other, undefined)
    assert.equal(
      state.templates.tpl_migrated.draft.elements.length,
      first,
      'öğe sayısı DEĞİŞMEMELİ',
    )
    // Saf fonksiyon da idempotent: overlay girdisi yeniden göçürülmez.
    const migration = await load('/src/labels/labelOverlayMigration.ts')
    const twice = migration.migrateStandaloneToOverlay(
      state.templates.tpl_migrated.draft,
      zones,
      { id: 'x' },
    )
    assert.equal(twice.draft.elements.length, first)
    assert.deepEqual(twice.warnings, [])
  } finally {
    await pglite.close()
  }
})

/* ═══ MIG-18 — KAYIT ═══════════════════════════════════════════════ */

test('MIG-18: bu paket KAPILARA bağlı', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(
    pkg.scripts['test:label-editor:acceptance'],
    /label-overlay-migration-flow\.test\.mjs/,
  )
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  assert.ok(files.includes('server/label-overlay-migration-flow.test.mjs'))
})
