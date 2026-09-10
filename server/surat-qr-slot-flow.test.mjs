import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import { decodePngToBitmap, measureInkBox } from './labels/pngLandmarks.mjs'

// SAĞ-ALT QR SLOTU — GERÇEK RENDER GEOMETRİSİ.
//
// ═══ KÖK NEDEN ═══════════════════════════════════════════════════════════
// Taşıyıcının QR'ı `^FT` ile konumlanır. `^FT` TABAN ÇİZGİSİDİR: kutu YUKARI
// doğru büyür (render: [y − size − 7×mag, y − 7×mag]). Taşıyıcının etkin
// büyütmesi 1 iken kutu 21 dot olduğu için taban çizgisinin hemen üstünde
// kalıyor ve ayrılmış sağ-alt banda düşüyordu.
//
// Büyütme uygulandığında (21 → 105 dot) kutu YUKARI genişledi ve QR slottan
// çıkıp orta-sağ bölgeye — ödeme/parça satırlarının hizasına — tırmandı.
// Yani sorun büyütmenin kendisinde değil, büyütmenin TABAN ÇİZGİSİ
// KORUNARAK yapılmasındaydı.
//
// ═══ HEDEF NEREDEN GELİYOR ═══════════════════════════════════════════════
// Konum TAHMİN EDİLMEZ. Composer'ın KENDİ ürettiği QR için zaten kabul
// edilmiş slottan (`QR_CANDIDATES` y + `preferredQrLeft`) türetilir; böylece
// taşıyıcının QR'ı ile composer'ın QR'ı AYNI yere düşer.
//
// HİÇBİR İDDİA DİZGİYE DAYANMAZ: her ölçü 799×799 gerçek render'ın
// PİKSELLERİNDEN gelir.

const here = dirname(fileURLToPath(import.meta.url))
const V2_ZPL = readFileSync(
  join(here, 'fixtures', 'surat-real-v2-numeric.zpl'),
  'utf8',
)

let _vite
let renderZplToPng
let composeSuratLabel
let parseZplDocument
let collectZplFields

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ renderZplToPng } = await _vite.ssrLoadModule(
    '/server/labels/zplRenderService.ts',
  ))
  ;({ composeSuratLabel } = await _vite.ssrLoadModule(
    '/src/utils/suratLabelComposer.ts',
  ))
  ;({ parseZplDocument, collectZplFields } = await _vite.ssrLoadModule(
    '/src/utils/zplCommandModel.ts',
  ))
})
after(async () => {
  if (_vite) await _vite.close()
})

async function bitmap(zpl) {
  const result = await renderZplToPng({ zpl })
  return decodePngToBitmap(Buffer.from(result.pngBase64, 'base64'))
}

const composed = () => composeSuratLabel(V2_ZPL, {})

/**
 * QR alanını ZPL'den tamamen çıkarır — bbox'ı pencere seçmeden ölçmek için.
 *
 * Taşıyıcının ham ZPL'i komutlar arasında boşluk taşır (`^FT690,650 ^BQ…`);
 * composer'ın çıktısı taşımaz. Desen İKİSİNİ DE kapsamalıdır.
 */
const QR_FIELD = /\^FT\d+,\d+\s*\^BQ[^^]*\^FD[A-Z]{2},[^^]*\^FS/

/**
 * QR'ın SINIR KUTUSU — QR'sız render'a göre EKLENEN mürekkepten türetilir.
 *
 * Sabit ölçüm penceresi KULLANILMAZ: pencere kenar çizgisi gibi komşu
 * mürekkebi yakalayıp kutuyu sessizce büyütebilirdi.
 */
async function qrBox(zpl) {
  assert.match(zpl, QR_FIELD, 'ZPL bir QR alanı taşımalı')
  const withQr = await bitmap(zpl)
  const withoutQr = await bitmap(zpl.replace(QR_FIELD, ''))
  let left = Infinity
  let top = Infinity
  let right = -1
  let bottom = -1
  let ink = 0
  for (let y = 0; y < 799; y += 1) {
    for (let x = 0; x < 799; x += 1) {
      if (!withQr.dark[y][x] || withoutQr.dark[y][x]) continue
      ink += 1
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  assert.ok(ink > 0, 'QR mürekkebi bulunmalı')
  return {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
    ink,
    bitmap: withQr,
  }
}

/**
 * Kutudan modül matrisi (hücre MERKEZİ örnekleme).
 *
 * `floor` KULLANILIR, `round` DEĞİL: büyütme 1 iken hücre 1 dottur ve
 * `round(sol + 0.5)` merkezi BİR SONRAKİ modüle taşırdı — 21×21 ham QR ile
 * 105×105 büyütülmüş QR karşılaştırması sessizce yanlış çıkardı.
 */
function moduleMatrix(bm, box, count) {
  const cell = box.width / count
  const rows = []
  for (let row = 0; row < count; row += 1) {
    let bits = ''
    for (let column = 0; column < count; column += 1) {
      const x = Math.floor(box.left + (column + 0.5) * cell)
      const y = Math.floor(box.top + (row + 0.5) * cell)
      bits += bm.dark[y][x] ? '1' : '0'
    }
    rows.push(bits)
  }
  return rows.join('|')
}

const qrPayload = (zpl) => {
  const commands = parseZplDocument(zpl).commands
  const index = commands.findIndex((command) => command.name === 'BQ')
  return commands.slice(index + 1).find((command) => command.name === 'FD')?.args
}

// ═══ QR-GEO-1: SLOT ══════════════════════════════════════════════════════

test('QR-GEO-1: QR ayrılmış SAĞ-ALT slotta ve kenar payları güvenli', async () => {
  const result = composed()
  assert.equal(result.mode, 'carrier_composed')
  const box = await qrBox(result.zpl)
  const quietZone = 4 * result.diagnostics.carrierQr.magnification

  // Slot, composer'ın KENDİ QR'ı için kabul edilmiş banttır: `^FO` y'si 596,
  // renderer +10 kaydırır → üst 606; yükseklik 105 → alt 710.
  assert.equal(box.top, 606, `slot üst kenarı: ${box.top}`)
  assert.equal(box.bottom, 710, `slot alt kenarı: ${box.bottom}`)

  // SAĞ yarıda ve ALT yarıda.
  assert.ok(box.left > 799 / 2, `QR sağ yarıda olmalı: left=${box.left}`)
  assert.ok(box.top > 799 / 2, `QR alt yarıda olmalı: top=${box.top}`)

  // Sessiz bölge etiket içinde.
  assert.ok(798 - box.right >= quietZone, `sağ pay ${798 - box.right} < ${quietZone}`)
  assert.ok(798 - box.bottom >= quietZone, `alt pay ${798 - box.bottom} < ${quietZone}`)
  assert.ok(box.left - quietZone >= 0)
  assert.ok(box.top - quietZone >= 0)

  // Sessiz bölgede YABANCI mürekkep yok — hiçbir komşu alana taşmıyor.
  let intruders = 0
  for (let y = box.top - quietZone; y <= box.bottom + quietZone; y += 1) {
    for (let x = box.left - quietZone; x <= box.right + quietZone; x += 1) {
      if (y < 0 || y > 798 || x < 0 || x > 798) continue
      const insideQr =
        x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
      if (insideQr) continue
      if (box.bitmap.dark[y][x]) intruders += 1
    }
  }
  assert.equal(intruders, 0, 'sessiz bölgede komşu mürekkep OLMAMALI')
})

// ═══ QR-GEO-2..4: VERİ VE BOYUT ══════════════════════════════════════════

test('QR-GEO-2: QR yükü taşıyıcınınkiyle BAYT BAYT aynı', () => {
  const result = composed()
  const before = qrPayload(V2_ZPL)
  const after = qrPayload(result.zpl)
  assert.ok(before, 'kaynakta QR yükü bulunmalı')
  assert.equal(after, before)
  assert.equal(
    Buffer.compare(Buffer.from(before, 'utf8'), Buffer.from(after, 'utf8')),
    0,
    'bayt bayt aynı',
  )
})

test('QR-GEO-3: kodlanan MODÜL MATRİSİ taşıyıcınınkiyle aynı', async () => {
  // Cozucu bagimliligi EKLENMEZ: veri esitligi, sembolun modul matrisinin
  // birebir ayni olmasiyla kanitlanir — matris ayniysa kodlanan veri de aynidir.
  const result = composed()
  const rawBox = await qrBox(V2_ZPL)
  const outBox = await qrBox(result.zpl)
  const modules = 21
  assert.equal(rawBox.width, modules * 1, 'kaynak QR büyütme 1 ile basılır')
  assert.equal(outBox.width, modules * result.diagnostics.carrierQr.magnification)
  assert.equal(
    moduleMatrix(outBox.bitmap, outBox, modules),
    moduleMatrix(rawBox.bitmap, rawBox, modules),
    'modül matrisi DEĞİŞMEZ — yalnız ölçek ve konum değişir',
  )
})

test('QR-GEO-4: yerleşim düzeltmesi QR ÖLÇÜSÜNÜ değiştirmez', async () => {
  const result = composed()
  const box = await qrBox(result.zpl)
  const { magnification, size } = result.diagnostics.carrierQr
  assert.equal(box.width, size)
  assert.equal(box.height, size)
  assert.equal(box.width, box.height, 'kare')
  assert.equal(box.width, 21 * magnification)
  // `^BQ` argümanları (model + büyütme) yerleşimden bağımsızdır.
  const outQr = collectZplFields(parseZplDocument(result.zpl)).find(
    (field) => field.kind === 'qr',
  )
  assert.equal(outQr.codeCommand.args, `N,4,${magnification}`)
})

// ═══ QR-GEO-5..11: DOKUNULMAYAN SÖZLEŞMELER ══════════════════════════════
//
// Ölçüt: composed render'ın QR DIŞINDAKİ her pikseli, QR'ı çıkarılmış
// render ile AYNI olmalıdır. Bu, "QR yerleşimi başka hiçbir alanı
// etkilemedi" iddiasının en güçlü biçimidir — tek tek bant saymaz,
// TÜM etiketi kapsar.

test('QR-GEO-5..11: QR dışında TEK PİKSEL değişmez', async () => {
  const result = composed()
  const box = await qrBox(result.zpl)
  const withQr = box.bitmap
  const withoutQr = await bitmap(result.zpl.replace(QR_FIELD, ''))

  let outside = 0
  for (let y = 0; y < 799; y += 1) {
    for (let x = 0; x < 799; x += 1) {
      const insideQr =
        x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
      if (insideQr) continue
      if (withQr.dark[y][x] !== withoutQr.dark[y][x]) outside += 1
    }
  }
  assert.equal(outside, 0, 'QR kutusu DIŞINDA hiçbir piksel QR yüzünden değişmez')
})

test('QR-GEO-5: barkod çubukları ve ^BY/^BC/^FD DEĞİŞMEZ', async () => {
  const result = composed()
  const read = (zpl) => {
    const field = collectZplFields(parseZplDocument(zpl)).find(
      (entry) => entry.kind === 'code128',
    )
    return { x: field.x, y: field.y, data: field.data, by: field.byCommand?.args }
  }
  assert.deepEqual(read(result.zpl), read(V2_ZPL), 'barkod primitifi aynen')

  // Render'daki çubuk bandı da birebir aynı kalır.
  const barBand = (bm) => measureInkBox(bm, { x: 40, y: 160, width: 759, height: 135 })
  assert.deepEqual(
    barBand(await bitmap(result.zpl)),
    barBand(await bitmap(V2_ZPL)),
    'çubuklar aynı piksellerde',
  )
})

test('QR-GEO-6: barkod altı numara ortalaması DEĞİŞMEZ', async () => {
  const result = composed()
  const bm = await bitmap(result.zpl)
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
  const text = measureInkBox(bm, { x: 0, y: 302, width: 799, height: 32 })
  const drift = Math.abs(text.x + text.width / 2 - (first + last) / 2)
  assert.ok(drift <= 2, `metin merkezi ${drift} dot kaymış`)
})

test('QR-GEO-7: dikey 727 referansı DEĞİŞMEZ', async () => {
  const result = composed()
  const shift = result.diagnostics.orderReferenceShift
  assert.equal(shift.fromX, 25)
  assert.equal(shift.x, 39)
  const column = measureInkBox(await bitmap(result.zpl), {
    x: 0,
    y: 540,
    width: 44,
    height: 166,
  })
  assert.equal(column.x, 24, 'mürekkep sol kenarı 24 dot')
})

test('QR-GEO-8..10: telefon / adres / rota-aktarma bantları DEĞİŞMEZ', async () => {
  const result = composed()
  const raw = await bitmap(V2_ZPL)
  const out = await bitmap(result.zpl)
  const bands = [
    ['gönderici telefon', { x: 400, y: 130, width: 399, height: 26 }],
    ['alıcı telefon', { x: 60, y: 440, width: 340, height: 30 }],
    ['adres satırları', { x: 60, y: 350, width: 720, height: 60 }],
    ['rota', { x: 170, y: 590, width: 420, height: 46 }],
    ['aktarma merkezi', { x: 170, y: 638, width: 420, height: 70 }],
  ]
  for (const [name, band] of bands) {
    assert.deepEqual(
      measureInkBox(out, band),
      measureInkBox(raw, band),
      `${name} bandı DEĞİŞMEMELİ`,
    )
  }
})

test('QR-GEO-11: etiket ölçüsü ve whitelist sözleşmesi DEĞİŞMEZ', async () => {
  const result = composed()
  const render = await renderZplToPng({ zpl: result.zpl })
  assert.equal(render.widthPx, 799)
  assert.equal(render.heightPx, 799)
  assert.equal(result.diagnostics.diff.deletions, 0)
  assert.equal(result.diagnostics.diff.unexpectedMutations, 0)
})
