import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ═══ RESMİ SÜRAT ETİKETİ — ADRES ÜST ÜSTE BİNME ═════════════════════════
//
// ═══ ÜRETİMDE GÖRÜLEN HATA ═══════════════════════════════════════════════
// Alıcı adres bloğunda kalın satırlar birbirinin üstüne biniyor, adres
// okunamaz hale geliyordu.
//
// ═══ KÖK NEDEN ═══════════════════════════════════════════════════════════
// Taşıyıcının güncel şablonu (v2) adres bloğunu KENDİSİ dolduruyor:
// `^FT63,417` ve `^FT63,433` alanlarında bitmap `A0` (genişlik 25) metin var.
// `resolveSuratSemanticModel` bunu DOĞRU tespit ediyordu
// (`carrierOwnsAddressBlock = true`, `boldAddressSlots = 0`) — ama
// `composeSuratDurusoftLabel` bu sinyali HİÇ OKUMUYORDU. Composer, sabit
// `BOLD_ADDRESS_BASELINES` dizisine koşulsuz yazıyor ve taşıyıcının metninin
// ÜSTÜNE, farklı bir fontla (`A@` genişlik 10) ikinci bir kopya çiziyordu.
// Aynı taban çizgisi + aynı x + farklı font genişliği = okunamayan adres.
//
// Kanıt üretilmiş hâli (düzeltmeden ÖNCE), y=417 taban çizgisinde ÜÇ alan:
//   x=63 A0 w=25 "ORNEK MAHALLESI ..."   ← taşıyıcının kendi metni
//   x=63 A@ w=10 "ORNEK MAHALLESI ..."   ← composer kopyası
//   x=64 A@ w=10 "ORNEK MAHALLESI ..."   ← composer çift vuruşu
//
// ═══ BU PAKET NE KİLİTLER ════════════════════════════════════════════════
// Binme GÖZLE değil ÖLÇÜLEREK doğrulanır: `findZplTextOverlaps` alanların
// işgal kutularını ZPL'den hesaplar. Ölçüm render motorundan BAĞIMSIZDIR.
//
// TAŞIYICI/PAZARYERİ ÇAĞRISI YOKTUR — hepsi depodaki fixture'lar.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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

const fixture = (name) =>
  readFileSync(join(root, 'server', 'fixtures', name), 'utf8')

/** Taşıyıcının adres bloğunu KENDİSİ doldurduğu güncel şablon. */
const V2 = 'surat-real-v2-numeric.zpl'
/** Adres bloğu BOŞ bırakılan şablon — composer devralır. */
const V1 = 'real-template-masked.zpl'

const COMPOSE_INPUT = {
  cargoTrackingNumber: '7270034422363739',
  ozelKargoTakipNo: 'Web00157962154',
}

/** Alıcı adres bandı (dot). Sorunun yaşandığı bölge. */
const ADDRESS_BAND = { top: 340, bottom: 470 }

function inAddressBand(box) {
  return box.y + box.height > ADDRESS_BAND.top && box.y < ADDRESS_BAND.bottom
}

async function compose(name, mutate = (zpl) => zpl) {
  const composer = await load('/src/utils/suratDurusoftComposer.ts')
  const parser = await load('/src/utils/suratSemanticParser.ts')
  const source = mutate(fixture(name))
  return {
    source,
    semantic: parser.resolveSuratSemanticModel(source),
    result: composer.composeSuratDurusoftLabel(source, COMPOSE_INPUT),
  }
}

/* ═══ OVL-01 — KÖK NEDEN SİNYALİ DOĞRU ÜRETİLİYOR ═══════════════════ */

test('OVL-01: v2 şablonunda adres bloğu TAŞIYICIYA aittir (sinyal doğru)', async () => {
  const { semantic } = await compose(V2)
  assert.equal(semantic.supported, true)
  assert.equal(
    semantic.carrierOwnsAddressBlock,
    true,
    'taşıyıcı bloğu dolduruyor; model bunu görmeli',
  )
  assert.equal(
    semantic.boldAddressSlots.length,
    0,
    'devralınacak BOŞ slot kalmamalı',
  )
})

/* ═══ OVL-02 — SİNYAL ARTIK TÜKETİLİYOR ═════════════════════════════ */

test('OVL-02: taşıyıcı bloğa sahipken composer bold adres YAZMAZ', async () => {
  const { result } = await compose(V2)
  assert.equal(result.mode, 'durusoft_composed', 'compose yine de çalışmalı')
  assert.equal(
    result.diagnostics.boldAddressLines,
    0,
    'taşıyıcının metnine ikinci kopya EKLENMEZ',
  )

  // Kök nedenin doğrudan kilidi: bold taban çizgilerinde CargoFlow alanı YOK.
  const cmd = await load('/src/utils/zplCommandModel.ts')
  const parserModule = await load('/src/utils/suratSemanticParser.ts')
  const fields = cmd
    .collectZplFields(cmd.parseZplDocument(result.zpl))
    .filter((field) => field.kind === 'text' && String(field.data ?? '').trim())
  for (const baseline of parserModule.BOLD_ADDRESS_BASELINES) {
    const atBaseline = fields.filter((field) => field.y === baseline)
    assert.ok(
      atBaseline.length <= 1,
      `y=${baseline} üzerinde ${atBaseline.length} metin alanı var: ` +
        atBaseline.map((f) => `${f.font?.command}/${JSON.stringify(f.data)}`).join(' | '),
    )
  }
})

/* ═══ OVL-03 — ADRES BANDINDA BİNME YOK ═════════════════════════════ */

test('OVL-03: composed çıktının ADRES BANDINDA hiç binme yok', async () => {
  const geometry = await load('/src/utils/zplTextGeometry.ts')
  const { result } = await compose(V2)
  const overlaps = geometry
    .findZplTextOverlaps(result.zpl)
    .filter((o) => inAddressBand(o.left) && inAddressBand(o.right))
  assert.deepEqual(
    overlaps.map((o) => geometry.describeOverlap(o)),
    [],
    'adres bandı TEMİZ olmalı',
  )
})

/* ═══ OVL-04 — COMPOSE YENİ BİNME EKLEMEZ ═══════════════════════════ */

test('OVL-04: compose, KAYNAĞA göre YENİ binme EKLEMEZ', async () => {
  // Mutlak sayı yerine FARK ölçülür: taşıyıcının kendi şablonundaki
  // (tahmin payından doğan) sabit durumlar CargoFlow'un sorumluluğu
  // değildir; CargoFlow'un EKLEDİĞİ hiçbir binme kabul edilemez.
  const geometry = await load('/src/utils/zplTextGeometry.ts')
  for (const name of [V2, V1]) {
    const { source, result } = await compose(name)
    const key = (o) =>
      `${o.left.text}@${o.left.x},${o.left.y}::${o.right.text}@${o.right.x},${o.right.y}`
    const before = new Set(geometry.findZplTextOverlaps(source).map(key))
    const added = geometry
      .findZplTextOverlaps(result.zpl)
      .filter((o) => !before.has(key(o)))
    assert.deepEqual(
      added.map((o) => geometry.describeOverlap(o)),
      [],
      `${name}: compose YENİ binme eklememeli`,
    )
  }
})

/* ═══ OVL-05 — BOŞ BÖLGE ÖZELLİĞİ KORUNUR ═══════════════════════════ */

test('OVL-05: adres bloğu BOŞSA composer devralmaya DEVAM eder', async () => {
  // Düzeltme "bold adresi tamamen kapat" DEĞİLDİR. Taşıyıcı bölgeyi boş
  // bırakıyorsa (v1) composer adresi oraya yazmayı SÜRDÜRÜR; aksi hâlde
  // hata düzeltilirken bir özellik sessizce kaybolurdu.
  const { semantic, result } = await compose(V1)
  assert.equal(semantic.carrierOwnsAddressBlock, false)
  assert.ok(semantic.boldAddressSlots.length > 0, 'boş slot bulunmalı')
  assert.equal(result.mode, 'durusoft_composed')
  assert.ok(
    result.diagnostics.boldAddressLines > 0,
    'boş bölgede bold adres YAZILMALI',
  )
})

/* ═══ OVL-06..07 — GERÇEK ADRES SENARYOLARI ═════════════════════════ */

const ADDRESS_SCENARIOS = [
  {
    label: 'ekran görüntüsündeki gerçek adres',
    line1: 'ORTACAMI MAH ORTACAMI MAHALLESI AKIK SOKAK JEOSIT',
    line2: 'APARTMANI 6-8 KAT 1 DAIRE 6',
  },
  {
    label: 'çok uzun tek satır',
    line1:
      'CUMHURIYET MAHALLESI SEHIT PIYADE ONBASI MEHMET AKIF ERSOY CADDESI NO 274/B',
    line2: 'GULBAHCE KONAKLARI A5 BLOK KAT 12 DAIRE 47 KAPI KODU 4821',
  },
  {
    label: 'kısa adres',
    line1: 'ATATURK CAD NO 5',
    line2: 'D 3',
  },
]

for (const scenario of ADDRESS_SCENARIOS) {
  test(`OVL-06: adres bandı temiz — ${scenario.label}`, async () => {
    const geometry = await load('/src/utils/zplTextGeometry.ts')
    const { result } = await compose(V2, (zpl) =>
      zpl
        .split('^FDORNEK MAHALLESI ORNEK CADDESI ORNEK SOKAK NUMARA X^FS')
        .join(`^FD${scenario.line1}^FS`)
        .split('^FD33^FS')
        .join(`^FD${scenario.line2}^FS`),
    )
    assert.equal(result.mode, 'durusoft_composed')
    const overlaps = geometry
      .findZplTextOverlaps(result.zpl)
      .filter((o) => inAddressBand(o.left) && inAddressBand(o.right))
    assert.deepEqual(
      overlaps.map((o) => geometry.describeOverlap(o)),
      [],
      `${scenario.label}: adres bandı temiz olmalı`,
    )
  })
}

/* ═══ OVL-08 — GERÇEK RENDER: MÜREKKEP BANTLARI AYRIK ═══════════════ */

test('OVL-08: GERÇEK render — adres satırları ayrı mürekkep bantları', async () => {
  // Geometri ölçümü ZPL'den gelir; bu test aynı sonucu PİKSEL üstünde
  // doğrular. İki adres satırının mürekkebi arasında BOŞ satır olmalı;
  // bitişik/örtüşen bantlar üst üste binmenin piksel imzasıdır.
  const renderer = await load('/server/labels/zplRenderService.ts')
  const { decodePngToBitmap } = await import('./labels/pngLandmarks.mjs')
  const { result } = await compose(V2, (zpl) =>
    zpl
      .split('^FDORNEK MAHALLESI ORNEK CADDESI ORNEK SOKAK NUMARA X^FS')
      .join('^FDORTACAMI MAH ORTACAMI MAHALLESI AKIK SOKAK JEOSIT^FS')
      .split('^FD33^FS')
      .join('^FDAPARTMANI 6-8 KAT 1 DAIRE 6^FS'),
  )
  const png = await renderer.renderZplToPng({ zpl: result.zpl })
  const bitmap = decodePngToBitmap(Buffer.from(png.pngBase64, 'base64'))

  const X0 = 60
  const X1 = 780
  // Bandın neredeyse tamamında koyu olan sütunlar KENARLIKTIR, metin değil.
  const columnDark = new Map()
  for (let x = X0; x <= X1; x += 1) {
    let dark = 0
    for (let y = ADDRESS_BAND.top; y <= ADDRESS_BAND.bottom; y += 1) {
      if (bitmap.dark[y]?.[x]) dark += 1
    }
    columnDark.set(x, dark)
  }
  const span = ADDRESS_BAND.bottom - ADDRESS_BAND.top
  const isBorder = (x) => (columnDark.get(x) ?? 0) > span * 0.8

  const bands = []
  let current = null
  for (let y = ADDRESS_BAND.top; y <= ADDRESS_BAND.bottom; y += 1) {
    let ink = 0
    for (let x = X0; x <= X1; x += 1) {
      if (!isBorder(x) && bitmap.dark[y]?.[x]) ink += 1
    }
    if (ink > 2) {
      if (current) current.bottom = y
      else current = { top: y, bottom: y }
    } else if (current) {
      bands.push(current)
      current = null
    }
  }
  if (current) bands.push(current)

  assert.ok(bands.length >= 4, `adres bandında en az 4 metin satırı beklenir (${bands.length})`)
  for (let index = 1; index < bands.length; index += 1) {
    const gap = bands[index].top - bands[index - 1].bottom - 1
    assert.ok(
      gap >= 1,
      `bant ${index - 1} (${bands[index - 1].top}..${bands[index - 1].bottom}) ile ` +
        `bant ${index} (${bands[index].top}..${bands[index].bottom}) BİTİŞİK — üst üste binme`,
    )
  }
})
