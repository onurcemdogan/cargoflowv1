import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import { decodePngToBitmap, measureInkBox } from './labels/pngLandmarks.mjs'

// SÜRAT ETİKET GEOMETRİ DÜZELTMELERİ — GERÇEK RENDER KANITI.
//
// İki saha şikâyeti bu pakette kök nedeniyle birlikte kilitlenir:
//
//   1) "QR çok küçük, el terminali okumuyor."
//      KÖK NEDEN: taşıyıcı `^BQN,4,4 ` yazıyor. Üçüncü parametre (büyütme)
//      sondaki BOŞLUK yüzünden geçerli bir sayı DEĞİLDİR; ayrıştırıcı
//      varsayılan büyütmeye (1) düşer ve 21 modül 21 dota basılır — modül
//      kenarı 0.125 mm. Bu bir tercih değil, BOZUK BİR TOKEN'dır.
//
//   2) "Soldaki dikey 727 numarası bazen çıkmıyor."
//      KÖK NEDEN: alan `^FT25,706` + `^A0B` ile basılır. Döndürülmüş `^FT`
//      alanı taban çizgisinin SOLUNA uzadığı için sütun x≈5..28'dedir —
//      etiketin EN SOLDAKİ mürekkebi budur. Medya birkaç mm kaydığında ilk
//      kırpılan alan odur.
//
// HİÇBİR İDDİA DİZGİ KARŞILAŞTIRMASINA DAYANMAZ: her ölçü 799×799 gerçek
// zebrash render'ının PİKSELLERİNDEN gelir.

const here = dirname(fileURLToPath(import.meta.url))
const V2_ZPL = readFileSync(
  join(here, 'fixtures', 'surat-real-v2-numeric.zpl'),
  'utf8',
)
const MASKED_ZPL = readFileSync(
  join(here, 'fixtures', 'real-template-masked.zpl'),
  'utf8',
)

let _vite
let renderZplToPng
let composeSuratLabel
let resolveCarrierQrEnlargement
let resolveVerticalReferenceShift
let fieldTextBox
let parseZplDocument
let collectZplFields
let resolveSuratSemanticModel

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ renderZplToPng } = await _vite.ssrLoadModule(
    '/server/labels/zplRenderService.ts',
  ))
  ;({
    composeSuratLabel,
    resolveCarrierQrEnlargement,
    resolveVerticalReferenceShift,
  } = await _vite.ssrLoadModule('/src/utils/suratLabelComposer.ts'))
  ;({ fieldTextBox } = await _vite.ssrLoadModule(
    '/src/utils/zplTextGeometry.ts',
  ))
  ;({ parseZplDocument, collectZplFields } = await _vite.ssrLoadModule(
    '/src/utils/zplCommandModel.ts',
  ))
  ;({ resolveSuratSemanticModel } = await _vite.ssrLoadModule(
    '/src/utils/suratSemanticParser.ts',
  ))
})
after(async () => {
  if (_vite) await _vite.close()
})

async function bitmap(zpl) {
  const result = await renderZplToPng({ zpl })
  return decodePngToBitmap(Buffer.from(result.pngBase64, 'base64'))
}

const box = (bm, x, y, width, height) =>
  measureInkBox(bm, { x, y, width, height })

/**
 * İki render arasında EKLENEN / KALKAN mürekkebin sınır kutusu.
 *
 * Kutu sabitlerine bağlı DEĞİLDİR: neyin değiştiğini render'ın kendisi
 * söyler. Bir düzenlemenin "yalnız şunu değiştirdiği" iddiası ancak bu
 * farkla kanıtlanabilir.
 */
function inkDelta(before, after, predicate = () => true) {
  const collect = (test_) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -1
    let y1 = -1
    let count = 0
    for (let y = 0; y < 799; y += 1) {
      for (let x = 0; x < 799; x += 1) {
        if (!predicate(x, y)) continue
        if (!test_(x, y)) continue
        count += 1
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    return count === 0
      ? null
      : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, ink: count }
  }
  return {
    added: collect((x, y) => after.dark[y][x] && !before.dark[y][x]),
    removed: collect((x, y) => !after.dark[y][x] && before.dark[y][x]),
  }
}

const compose = (zpl, input = {}) => composeSuratLabel(zpl, input)

// ═══ GEO-01..GEO-05: QR BÜYÜTME ═════════════════════════════════════════

test('GEO-01: kaynak QR token bozuk olduğu için 21×21 dot basılıyor', async () => {
  // Şablonun bastığı komut, sondaki boşlukla birlikte.
  assert.match(V2_ZPL, /\^BQN,4,4 /)
  const bm = await bitmap(V2_ZPL)
  // Sağ alt köşede QR'dan başka mürekkep yok: dar pencere.
  const qr = box(bm, 660, 600, 120, 90)
  assert.ok(qr, 'kaynakta QR mürekkebi bulunmalı')
  assert.equal(qr.width, 21, `21 modül × büyütme 1 beklenir: ${qr.width}`)
  assert.equal(qr.height, 21)
})

test('GEO-02: composed QR 105×105 dot — modül kenarı 0.625 mm', async () => {
  const composed = compose(V2_ZPL)
  assert.equal(composed.mode, 'carrier_composed')
  const enlargement = composed.diagnostics.carrierQr
  assert.ok(enlargement, 'QR büyütmesi uygulanmalı')
  assert.equal(enlargement.effectiveMagnification, 1, 'yazıcının GERÇEKTE uyguladığı değer')
  assert.equal(enlargement.magnification, 5)
  assert.equal(enlargement.size, 105)

  const delta = inkDelta(
    await bitmap(V2_ZPL),
    await bitmap(composed.zpl),
    (x, y) => x > 640 && y > 440,
  )
  assert.ok(delta.removed, 'eski küçük QR kalkmalı')
  assert.equal(delta.removed.width, 21, 'kalkan kutu eski QR olmalı')
  assert.equal(delta.removed.height, 21)
  assert.ok(delta.added, 'yeni QR basılmalı')
  assert.equal(delta.added.width, 105, `yeni QR 105 dot olmalı: ${delta.added.width}`)
  assert.equal(delta.added.height, 105)
  // 203 dpi'de 105 dot = 13.1 mm; modül = 105/21 = 5 dot = 0.625 mm.
  assert.equal(delta.added.width / 21, 5)
})

test('GEO-03: büyütülmüş QR sessiz bölgesiyle etiket İÇİNDE', async () => {
  const composed = compose(V2_ZPL)
  const { added } = inkDelta(
    await bitmap(V2_ZPL),
    await bitmap(composed.zpl),
    (x, y) => x > 640 && y > 440,
  )
  const quietZone = 4 * composed.diagnostics.carrierQr.magnification
  assert.ok(
    added.x + added.width - 1 + quietZone <= 798,
    `sağ sessiz bölge taşmamalı: ${added.x + added.width - 1} + ${quietZone}`,
  )
  assert.ok(added.x - quietZone >= 0, 'sol sessiz bölge taşmamalı')
  assert.ok(added.y - quietZone >= 0, 'üst sessiz bölge taşmamalı')
  assert.ok(added.y + added.height - 1 + quietZone <= 798, 'alt sessiz bölge taşmamalı')
})

test('GEO-04: QR yükü ve komşu alanlar DEĞİŞMEZ', async () => {
  const composed = compose(V2_ZPL)
  const readQrData = (zpl) => {
    const commands = parseZplDocument(zpl).commands
    const index = commands.findIndex((command) => command.name === 'BQ')
    return commands.slice(index + 1).find((command) => command.name === 'FD')?.args
  }
  assert.equal(readQrData(composed.zpl), readQrData(V2_ZPL), 'QR gövdesi birebir aynı')

  // Aktarma merkezi bandı: QR'ın SOL komşusu. Tek dot değişmemeli.
  const before = await bitmap(V2_ZPL)
  const after = await bitmap(composed.zpl)
  assert.deepEqual(
    box(after, 170, 638, 420, 70),
    box(before, 170, 638, 420, 70),
    'aktarma metni etkilenmemeli',
  )
})

test('GEO-05: geometri izin vermiyorsa QR AYNEN korunur', () => {
  // Sağ sütunu dolduran bir işgal kutusu: hiçbir aday sığmaz.
  const fields = collectZplFields(parseZplDocument(V2_ZPL))
  const qrField = fields.find((field) => field.kind === 'qr')
  assert.ok(qrField, 'fixture QR taşımalı')
  const blocked = resolveCarrierQrEnlargement(qrField, [
    { right: 780, top: 0, bottom: 799 },
  ])
  assert.equal(blocked, null, 'sığmıyorsa büyütme YAPILMAZ')
  // Aynı alan, boş işgal listesiyle büyütülebilir olmalı — testin kendisi
  // "her koşulda null" diye yanlış geçmesin.
  assert.ok(resolveCarrierQrEnlargement(qrField, []))
})

test('GEO-06: Version-1 kapasitesini aşan yükte büyütme YAPILMAZ', () => {
  const fields = collectZplFields(parseZplDocument(V2_ZPL))
  const qrField = fields.find((field) => field.kind === 'qr')
  // 21 modül varsayımı yalnız kısa sayısal yük için geçerlidir.
  const longPayload = { ...qrField, data: `QA,${'7'.repeat(40)}` }
  assert.equal(resolveCarrierQrEnlargement(longPayload, []), null)
})

// ═══ GEO-07..GEO-10: SOL DİKEY REFERANS ═════════════════════════════════

test('GEO-07: dikey referans, mürekkebi BOZULMADAN sağa taşınır', async () => {
  const composed = compose(V2_ZPL)
  const shift = composed.diagnostics.orderReferenceShift
  assert.ok(shift, 'kaydırma uygulanmalı')
  assert.ok(shift.x > shift.fromX, 'yalnız SAĞA')

  const before = await bitmap(V2_ZPL)
  const after = await bitmap(composed.zpl)
  // Alanın YALNIZ kendisinin bulunduğu bant (dikey "SURAT KARGO" rayı ve
  // "ALICI" başlığı bu bandın DIŞINDA kalır).
  const window = [0, 540, 58, 166]
  const source = box(before, ...window)
  const moved = box(after, ...window)
  assert.equal(moved.ink, source.ink, 'mürekkep miktarı AYNI — glif bozulmadı')
  assert.equal(moved.width, source.width, 'sütun genişliği AYNI')
  assert.equal(moved.height, source.height, 'sütun yüksekliği AYNI')
  assert.equal(moved.y, source.y, 'dikey konum DEĞİŞMEZ')
  assert.equal(
    moved.x - source.x,
    shift.x - shift.fromX,
    'yatay kayma tam olarak hesaplanan kadar',
  )
})

test('GEO-08: kaydırma sonrası referans, etiketin en soldaki mürekkebi DEĞİL', async () => {
  const composed = compose(V2_ZPL)
  const after = await bitmap(composed.zpl)
  const leftmost = (bm) => {
    for (let x = 0; x < 799; x += 1) {
      let ink = 0
      // Kenar çizgisi satırları sayımı kirletmesin.
      for (let y = 3; y < 796; y += 1) if (bm.dark[y][x]) ink += 1
      if (ink > 3) return x
    }
    return -1
  }
  const before = await bitmap(V2_ZPL)
  const sourceLeft = leftmost(before)
  const composedLeft = leftmost(after)
  assert.equal(sourceLeft, 10, 'kaynakta en sol mürekkep dikey referanstır')
  assert.ok(
    composedLeft > sourceLeft,
    `kırpılma payı artmalı: ${sourceLeft} → ${composedLeft}`,
  )
  // Taşıyıcının KENDİ dikey rayı (SURAT KARGO) x=14'tedir. Referans artık
  // ondan daha dışarıda DEĞİLDİR.
  assert.ok(
    composedLeft >= 14,
    `referans taşıyıcının kendi sol rayından dışarıda kalmamalı: ${composedLeft}`,
  )
})

test('GEO-09: komşu engelliyorsa kaydırma YAPILMAZ', () => {
  const model = resolveSuratSemanticModel(V2_ZPL)
  const reference = model.fields.orderReference.field
  // Dikey "ALICI" başlığı composed çıktıda boşaltılır; boşaltılMAsaydı
  // sütunun sağında engel olurdu ve kaydırma reddedilmeliydi.
  const heading = model.zplFields.find(
    (field) => String(field.data ?? '') === 'ALICI',
  )
  assert.ok(heading, 'fixture dikey ALICI başlığı taşımalı')
  assert.equal(
    resolveVerticalReferenceShift(reference, [heading]),
    null,
    'engel varken kaydırma YOK',
  )
  assert.ok(
    resolveVerticalReferenceShift(reference, []),
    'engel yokken kaydırma VAR — test her koşulda null döndürmüyor',
  )
})

test('GEO-10: kaydırma taşıyıcı verisini DEĞİŞTİRMEZ', () => {
  const composed = compose(V2_ZPL)
  const source = resolveSuratSemanticModel(V2_ZPL)
  const output = resolveSuratSemanticModel(composed.zpl)
  assert.equal(
    output.fields.orderReference.raw,
    source.fields.orderReference.raw,
    'sipariş referansının gövdesi birebir aynı',
  )
  assert.equal(
    output.fields.orderReference.field.y,
    source.fields.orderReference.field.y,
    'dikey konum korunur',
  )
})

// ═══ GEO-11: DÖNDÜRÜLMÜŞ ALAN GEOMETRİSİ ════════════════════════════════

test('GEO-11: `fieldTextBox` döndürülmüş alanları RENDER ile aynı yere koyar', async () => {
  // Kutu modeli, gerçek mürekkebin bulunduğu dikdörtgeni İÇERMELİDİR.
  // Modelin yönü yanlışsa (eski davranış) sapma bir sütun boyu kadar olur.
  const text = 'Siparis No: 1234'
  for (const orientation of ['N', 'B', 'R', 'I']) {
    for (const anchor of ['FT', 'FO']) {
      const zpl = `^XA^PW799^LL799^${anchor}400,400^A0${orientation},20,28^FD${text}^FS^XZ`
      const ink = measureInkBox(await bitmap(zpl), {
        x: 0,
        y: 0,
        width: 799,
        height: 799,
      })
      const fields = collectZplFields(parseZplDocument(zpl))
      const model = fieldTextBox(fields[0])
      assert.ok(model, `${anchor}/${orientation} kutusu çözülmeli`)
      // Glif, hücre sınırını birkaç dot aşabilir (ölçüldü: ≤5).
      const slack = 5
      const label = `${anchor}/${orientation}`
      assert.ok(
        ink.x >= model.x - slack,
        `${label} sol: mürekkep ${ink.x}, model ${model.x}`,
      )
      assert.ok(
        ink.x + ink.width <= model.x + model.width + slack,
        `${label} sağ: mürekkep ${ink.x + ink.width}, model ${model.x + model.width}`,
      )
      assert.ok(
        ink.y >= model.y - slack,
        `${label} üst: mürekkep ${ink.y}, model ${model.y}`,
      )
      assert.ok(
        ink.y + ink.height <= model.y + model.height + slack,
        `${label} alt: mürekkep ${ink.y + ink.height}, model ${model.y + model.height}`,
      )
    }
  }
})

// ═══ GEO-12..GEO-13: SÖZLEŞME KORUMASI ══════════════════════════════════

test('GEO-12: taşıyıcı komutu SİLİNMEZ, beklenmeyen mutasyon YOK', () => {
  for (const [name, zpl] of [
    ['v2', V2_ZPL],
    ['maskeli', MASKED_ZPL],
  ]) {
    const composed = compose(zpl, { cargoTrackingNumber: '7271234567890' })
    assert.equal(composed.mode, 'carrier_composed', name)
    assert.equal(composed.diagnostics.diff.deletions, 0, `${name}: silme YOK`)
    assert.equal(
      composed.diagnostics.diff.unexpectedMutations,
      0,
      `${name}: beklenmeyen mutasyon YOK`,
    )
  }
})

test('GEO-13: iki geometri düzeltmesi de DETERMİNİSTİK', async () => {
  const first = compose(V2_ZPL)
  const second = compose(V2_ZPL)
  assert.equal(first.zpl, second.zpl, 'aynı girdi → aynı çıktı')
  const a = await renderZplToPng({ zpl: first.zpl })
  const b = await renderZplToPng({ zpl: second.zpl })
  assert.equal(a.renderSha256, b.renderSha256, 'render de deterministik')
})

// ═══ GEO-14: TÜRETİLMİŞ ETİKET HÂLÂ ANLAŞILIYOR ═════════════════════════
//
// Geometri normalizasyonu semantic modeli KIRAMAZ. Kırarsa taşıyıcı bölge
// koruması (deriveCarrierZones) metin bölgelerini kaybeder ve overlay
// editörü resmî alanların üstüne yazmaya başlar.
test('GEO-14: composed v2 etiketin semantic modeli ve bölgeleri ÇÖZÜLÜR', async () => {
  const { deriveCarrierZones } = await _vite.ssrLoadModule(
    '/src/labels/labelBaseLayer.ts',
  )
  const composed = compose(V2_ZPL)
  const model = resolveSuratSemanticModel(composed.zpl)
  assert.equal(model.supported, true, model.reason ?? '')
  assert.ok(model.fields.orderReference, 'dikey referans çözülmeli')
  assert.equal(
    model.fields.orderReference.field.x,
    composed.diagnostics.orderReferenceShift.x,
    'model, normalize edilmiş konumu okur',
  )

  const zones = deriveCarrierZones(composed.zpl)
  const reference = zones.find((zone) => zone.key === 'orderReference')
  assert.ok(reference, 'dikey referans bölgesi korunmalı')
  for (const key of ['recipient', 'addressLine1', 'routeCode', 'transferCenter']) {
    assert.ok(
      zones.some((zone) => zone.key === key),
      `taşıyıcı metin bölgesi kaybolmamalı: ${key}`,
    )
  }
})

test('GEO-15: v1 composed etikette kimlik bölgeleri KAYBOLMAZ', async () => {
  // v1 composer, taşıyıcının BOŞ bıraktığı bold adres slotlarını KENDİ
  // kopyasıyla doldurur; bu yüzden türetilmiş v1 çıktısı artık bir KAYNAK
  // şablon şeklinde değildir ve tam metin modeli yeniden çözülemez. Bu
  // bilinçli bir tasarım sonucudur (üretimdeki şablon v2'dir), ama kimlik
  // bölgeleri — barkod, DataMatrix, QR — HER DURUMDA türetilir.
  const { deriveCarrierZones } = await _vite.ssrLoadModule(
    '/src/labels/labelBaseLayer.ts',
  )
  const composed = compose(MASKED_ZPL, { cargoTrackingNumber: '7271234567890' })
  const zones = deriveCarrierZones(composed.zpl)
  for (const key of ['barcodeGraphic', 'dataMatrixGraphic', 'qrGraphic']) {
    assert.ok(
      zones.some((zone) => zone.key === key && zone.zoneClass === 'identity'),
      `kimlik bölgesi türetilmeli: ${key}`,
    )
  }
})

test('GEO-16: koridor, AYNI imzalı ikinci alanda slotu TAHMİN ETMEZ', () => {
  // Farklı fontlu bir komşu slotu ele geçirmemeli…
  const differentFont = V2_ZPL.replace(
    '^FT25,706^A0B,20,28',
    '^FT90,706^A0B,44,44^FDBASKA^FS^FT25,706^A0B,20,28',
  )
  const tolerant = resolveSuratSemanticModel(differentFont)
  assert.equal(tolerant.supported, true, tolerant.reason ?? '')
  assert.equal(tolerant.fields.orderReference.field.x, 25)

  // …ama AYNI imzalı ikinci bir alan varsa slot BELİRSİZDİR: tahmin YOK.
  const sameFont = V2_ZPL.replace(
    '^FT25,706^A0B,20,28',
    '^FT90,706^A0B,20,28^FDBASKA^FS^FT25,706^A0B,20,28',
  )
  const ambiguous = resolveSuratSemanticModel(sameFont)
  assert.equal(ambiguous.supported, false, 'belirsiz slot kabul EDİLMEZ')
  assert.match(ambiguous.reason, /BELİRSİZ/)
})

// ═══ GEO-17: 727 REFERANSI ÜSTÜ KAPATILAMAZ ═════════════════════════════
//
// "Bazen çıkmıyor" sorununun iki fiziksel nedeni vardır: baskı kenarında
// KIRPILMA (composer normalizasyonu) ve ÜSTÜNÜN KAPATILMASI. İkincisi
// açıkken sorun deterministik olarak çözülmüş sayılamaz.
test('GEO-17: dikey referans BLOKLAYICI taşıyıcı bölgesidir', async () => {
  const { deriveCarrierZones, zoneBlocksOverlay } = await _vite.ssrLoadModule(
    '/src/labels/labelBaseLayer.ts',
  )
  const composed = compose(V2_ZPL)
  const zones = deriveCarrierZones(composed.zpl)
  const reference = zones.find((zone) => zone.key === 'orderReference')
  assert.ok(reference)
  assert.equal(reference.zoneClass, 'identity')
  assert.equal(zoneBlocksOverlay(reference), true, 'overlay bu şeridi ÖRTEMEZ')
})

test('GEO-18: göç, serbest şeridi referans sütununun DIŞINDA arar', async () => {
  const { deriveCarrierZones } = await _vite.ssrLoadModule(
    '/src/labels/labelBaseLayer.ts',
  )
  const { findFreeStrip } = await _vite.ssrLoadModule(
    '/src/labels/labelOverlayMigration.ts',
  )
  const { rectsOverlap } = await _vite.ssrLoadModule(
    '/src/labels/labelGeometry.ts',
  )
  const composed = compose(V2_ZPL)
  const zones = deriveCarrierZones(composed.zpl)
  const reference = zones.find((zone) => zone.key === 'orderReference')
  const strip = findFreeStrip(zones, 6)
  assert.ok(strip, 'serbest şerit bulunmalı')
  assert.equal(
    rectsOverlap(reference.rect, { ...strip, height: 6 }),
    false,
    'şerit referans sütununa girmemeli',
  )
})

// ═══ GEO-19: İNSAN-OKUNUR SATIR BASILAN BARKODA ORTALI ══════════════════
//
// SAHA ŞİKÂYETİ: "barkodun yeri hatalı" — barkodun altındaki numara
// barkodun merkezinden belirgin biçimde solda duruyordu.
//
// KÖK NEDEN: ortalama bloğu ZPL SPESİFİKASYONUNUN modül sayısıyla (`>:`
// subset C) hesaplanıyordu. Basılan şey ise ham ZPL değil, ondan üretilen
// PNG'dir ve render motoru `>:` önekini UYGULAMAZ — kağıttaki barkod subset
// B genişliğindedir. Ölçülen kayma 14 haneli yükte 134 dot (≈17 mm) idi.
//
// Bu test ölçüyü RENDER'DAN alır; hiçbir sabit koordinata dayanmaz.

/** Barkod bandındaki çubukların yatay sınırı (sol kenar rayı hariç). */
function barcodeSpan(bm) {
  let first = -1
  let last = -1
  for (let x = 40; x < 799; x += 1) {
    let ink = 0
    for (let y = 170; y < 290; y += 1) if (bm.dark[y][x]) ink += 1
    if (ink > 110) {
      if (first < 0) first = x
      last = x
    }
  }
  return first < 0 ? null : { first, last, center: (first + last) / 2 }
}

test('GEO-19: barkod altı numara BASILAN barkoda ortalanır', async () => {
  // İki yük uzunluğu: fixture (14 hane) ve sahadaki etiket (11 hane).
  for (const payload of ['01249704068000', '01267226437']) {
    const source = V2_ZPL.replace(
      '^FD>:01249704068000^FS',
      `^FD>:${payload}^FS`,
    )
    const composed = compose(source)
    assert.equal(composed.mode, 'carrier_composed', payload)

    const bm = await bitmap(composed.zpl)
    const bars = barcodeSpan(bm)
    assert.ok(bars, `${payload}: barkod çubukları bulunmalı`)
    const text = box(bm, 0, 302, 799, 32)
    assert.ok(text, `${payload}: insan-okunur metin basılmalı`)

    const textCenter = text.x + text.width / 2
    const drift = Math.abs(textCenter - bars.center)
    // Ortalama TAM olmalı; 2 dot pay yalnız glif kenar yuvarlamasıdır.
    assert.ok(
      drift <= 2,
      `${payload}: metin barkod merkezinden ${drift} dot kaymış ` +
        `(barkod ${bars.first}..${bars.last}, metin ${text.x}..${text.x + text.width - 1})`,
    )
    // Metin barkod bandının DIŞINA taşmaz.
    assert.ok(text.x >= bars.first, `${payload}: metin barkodun solundan taşmış`)
    assert.ok(
      text.x + text.width - 1 <= bars.last,
      `${payload}: metin barkodun sağından taşmış`,
    )
  }
})

test('GEO-20: barkod GÖVDESİ ve konumu composer tarafından DEĞİŞTİRİLMEZ', async () => {
  const composed = compose(V2_ZPL)
  const readCode128 = (zpl) => {
    const fields = collectZplFields(parseZplDocument(zpl))
    const field = fields.find((f) => f.kind === 'code128')
    return {
      x: field.x,
      y: field.y,
      data: field.data,
      by: field.byCommand?.args ?? null,
    }
  }
  const before = readCode128(V2_ZPL)
  const after = readCode128(composed.zpl)
  assert.equal(after.data, before.data, 'barkod gövdesi birebir aynı')
  assert.equal(after.x, before.x, 'barkod x konumu DEĞİŞMEZ')
  assert.equal(after.y, before.y, 'barkod y konumu DEĞİŞMEZ')
  assert.equal(after.by, before.by, '^BY modül genişliği/yüksekliği DEĞİŞMEZ')

  // Çubukların render'daki yeri de birebir aynı kalmalı.
  const spanBefore = barcodeSpan(await bitmap(V2_ZPL))
  const spanAfter = barcodeSpan(await bitmap(composed.zpl))
  assert.deepEqual(spanAfter, spanBefore, 'çubuklar aynı piksellerde')
})

// ═══ GEO-21: ETİKETTEKİ İKİ TELEFON — CARGOFLOW EKLEMİYOR ═══════════════
//
// Etikette iki `TEL:` görünür: üstte GÖNDERİCİ (şube) telefonu, adres
// bloğunda ALICI telefonu. İkisi de TAŞIYICININ kendi alanlarıdır ve farklı
// kişilere aittir. Composer bunlardan hiçbirini eklemez, silmez, taşımaz —
// aksi bir değişiklik "aynı kişi için iki numara" izlenimi yaratırdı.
test('GEO-21: composer telefon alanlarına DOKUNMAZ', async () => {
  const composed = compose(V2_ZPL)
  const model = resolveSuratSemanticModel(V2_ZPL)
  const out = resolveSuratSemanticModel(composed.zpl)

  // İki alan AYRI slotlardır ve gövdeleri korunur.
  assert.ok(model.fields.senderPhone, 'gönderici telefonu slotu')
  assert.ok(model.fields.recipientPhone, 'alıcı telefonu slotu')
  assert.equal(out.fields.senderPhone.raw, model.fields.senderPhone.raw)
  assert.equal(out.fields.recipientPhone.raw, model.fields.recipientPhone.raw)
  assert.notEqual(
    model.fields.senderPhone.field.y,
    model.fields.recipientPhone.field.y,
    'iki telefon AYRI bloklardadır (gönderici üstte, alıcı adres bloğunda)',
  )

  // Render'da da tek dot değişmez.
  const before = await bitmap(V2_ZPL)
  const after = await bitmap(composed.zpl)
  assert.deepEqual(
    box(after, 400, 130, 399, 26),
    box(before, 400, 130, 399, 26),
    'gönderici telefon bandı DEĞİŞMEZ',
  )
  assert.deepEqual(
    box(after, 60, 440, 340, 30),
    box(before, 60, 440, 340, 30),
    'alıcı telefon bandı DEĞİŞMEZ',
  )

  // Composer ZPL'e ÜÇÜNCÜ bir telefon alanı EKLEMEZ.
  //
  // Ölçüt maskeli telefon biçimidir (`055*******`): barkodun insan-okunur
  // satırı gibi uzun sayısal alanlarla karışmaz — o alan maske taşımaz.
  const maskedPhones = (zpl) =>
    collectZplFields(parseZplDocument(zpl))
      .map((f) => String(f.data ?? '').trim())
      .filter((d) => /^[0-9]{3}\*{3,}$/.test(d))
  const before2 = maskedPhones(V2_ZPL)
  const after2 = maskedPhones(composed.zpl)
  assert.deepEqual(after2, before2, 'maskeli telefon alanları AYNEN kalır')
  assert.equal(after2.length, 2, 'gönderici + alıcı: tam olarak iki telefon')
})
