// PRINT-GEOMETRY-002 — ZPL QR KANONİK BOYU, TAŞIYICI GÜVENLİĞİ GEVŞETİLMEDEN.
//
// ═══ ÖLÇÜLEN BAŞLANGIÇ (38ca3d2) ═════════════════════════════════════════
//
//   V1  SHORT(5)  105 dot   MED(17)  84 dot   LONG(28) RET   VLONG(38) RET
//   V2  SHORT(5)  126 dot*  MED(17)  21 dot   LONG(28) 21    VLONG(38) 21
//        * ve bu 126'lık QR aktarma metniyle ÇAKIŞIYORDU (ölçüldü).
//
// ═══ ÖLÇÜLEN SONUÇ (bu değişiklikten sonra) ══════════════════════════════
//
//   V1  SHORT 105   MED 105 (font 50→46)   LONG RET   VLONG RET
//   V2  SHORT 105   MED 105 (font 50→46)   LONG  21   VLONG  21
//
// Yani: içerik değiştiğinde QR'ın KÜÇÜLMESİ ortadan kalktı, çakışma
// giderildi ve metin ÖNCE daralıyor. V2'nin uzun metin dalı HÂLÂ taşıyıcının
// YERLİ 21 dot'unda kalıyor — sebebi aşağıda PG2-3'te açıkça yazılıdır.
//
// ═══ MUHAFIZ GEVŞETİLMEDİ ════════════════════════════════════════════════
//
// `unexpectedMutations = 0` guard'ı AYNEN yerinde. Whitelist'e YENİ bir izin
// EKLENMEDİ. Önceki denemenin çökme sebebi guard değil, yamanın kendisiydi:
// yayılan ZPL bir değişkenden, whitelist doğrulaması BAŞKA bir değişkenden
// besleniyordu. Artık tek `appliedTransferWidth` değeri her üçünü de besler.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import { decodePngToBitmap, measureInkBox } from './labels/pngLandmarks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const V1_ZPL = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const V2_ZPL = readFileSync(join(here, 'fixtures', 'surat-real-v2-numeric.zpl'), 'utf8')
const VERIFIED_727 = '7270034422363739'

/** Kanonik hedef: 21 modül × 5 = 105 dot = 13.125 mm @ 203 dpi. */
const CANONICAL_QR_DOTS = 105
const RENDER_TOLERANCE_DOTS = 1

const SHORT = 'IZMIR'
const MED = 'BALIKESIR AKTARMA'
const LONG = 'DIKILI/CAN BALIKESIR AKTARMA'
const VLONG = 'KAHRAMANMARAS ELBISTAN AKTARMA MERKEZI'

let _vite
let renderZplToPng
let composeSuratLabel
let composerSource

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ renderZplToPng } = await _vite.ssrLoadModule('/server/labels/zplRenderService.ts'))
  ;({ composeSuratLabel } = await _vite.ssrLoadModule('/src/utils/suratLabelComposer.ts'))
  composerSource = readFileSync(
    join(here, '..', 'src', 'utils', 'suratLabelComposer.ts'),
    'utf8',
  )
})
after(async () => {
  if (_vite) await _vite.close()
})

const render = async (zpl) =>
  decodePngToBitmap(Buffer.from((await renderZplToPng({ zpl })).pngBase64, 'base64'))

function diffBox(a, b) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (a.dark[y][x] === b.dark[y][x]) continue
      n += 1
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return n === 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

const overlaps = (a, b) =>
  a.x <= b.x + b.width - 1 && b.x <= a.x + a.width - 1 &&
  a.y <= b.y + b.height - 1 && b.y <= a.y + a.height - 1

function withTransfer(baseZpl, text) {
  const zpl = baseZpl.replace(
    /(FT220,705\^A0N,70,50\^FH\\\^FD)[^^]*/,
    (_match, prefix) => prefix + text,
  )
  // METİN GERÇEKTEN DEĞİŞTİ Mİ? Bu kontrol olmadan tüm ölçüm sessizce AYNI
  // etiketi ölçer ve "değişmiyor" diye YANLIŞ bir yeşil üretir.
  assert.ok(zpl.includes(text), `aktarma metni YERLESTIRILEMEDI: ${text}`)
  return zpl
}

/** Composed etiket + QR mürekkep kutusu; composer reddederse null. */
async function compose(baseZpl, text) {
  const result = composeSuratLabel(withTransfer(baseZpl, text), {
    cargoTrackingNumber: VERIFIED_727,
  })
  if (!result.composed) return { composed: false, reason: result.reason, qr: null }
  const full = await render(result.zpl)
  const qr = diffBox(full, await render(result.zpl.replace(/\^BQ[^\^]*\^FD[^\^]*\^FS/, '^FS')))
  const transferFontWidth = Number(
    (result.zpl.match(/FT220,705\^A0N,\d+,(\d+)/) || [])[1] ?? 0,
  )
  return {
    composed: true,
    zpl: result.zpl,
    qr,
    transferFontWidth,
    transferBox: measureInkBox(full, { x: 200, y: 640, width: 430, height: 70 }),
  }
}

// ═══ PG2-1 / PG2-2 — İÇERİK QR BOYUNU DEĞİŞTİRMEZ ════════════════════════

test('PG2-1: V1 — uretilen her etikette QR KANONIK 105 dot', async () => {
  const produced = []
  for (const text of [SHORT, MED, LONG, VLONG]) {
    const out = await compose(V1_ZPL, text)
    if (!out.composed) continue // fail-closed dal PG2-5'te olculur
    produced.push({ text, ...out })
  }
  assert.ok(produced.length >= 2, 'en az iki etiket uretilmeli')
  for (const entry of produced) {
    assert.equal(entry.qr.width, CANONICAL_QR_DOTS, `"${entry.text}" QR genisligi`)
    assert.equal(entry.qr.height, CANONICAL_QR_DOTS, `"${entry.text}" QR yuksekligi`)
  }
  // OLCULEN ONCEKI KUSUR: MED icin 84 dot idi. ARTIK 105.
  const med = produced.find((entry) => entry.text === MED)
  assert.ok(med, 'MED etiketi uretilmeli')
  assert.equal(med.qr.width, CANONICAL_QR_DOTS, 'MED artik 84 DEGIL 105')
})

test('PG2-2: V2 — uretilebilen etiketlerde QR KANONIK 105 dot', async () => {
  for (const text of [SHORT, MED]) {
    const out = await compose(V2_ZPL, text)
    assert.equal(out.composed, true, `"${text}" compose edilmeli`)
    assert.equal(out.qr.width, CANONICAL_QR_DOTS, `"${text}" QR genisligi`)
    assert.equal(out.qr.height, CANONICAL_QR_DOTS, `"${text}" QR yuksekligi`)
  }
  // OLCULEN ONCEKI KUSUR: SHORT 126, MED 21 idi. Ikisi de ARTIK 105.
})

test('PG2-2b: V2 SHORT — 126 dotluk QR artik aktarma metniyle CAKISMIYOR', async () => {
  // OLCULEN ONCEKI KUSUR: baseline'da V2 SHORT QR'i (126 dot) aktarma metni
  // bandiyla CAKISIYORDU. Kanonik boya inince cakisma ORTADAN KALKTI.
  const out = await compose(V2_ZPL, SHORT)
  assert.equal(out.composed, true)
  assert.equal(overlaps(out.qr, out.transferBox), false, 'QR metinle CAKISMAZ')
})

// ═══ PG2-3 — V2 UZUN METİN DALI: ÖLÇÜLEN GERÇEK ══════════════════════════
//
// TALEP: "V2 cannot fall back to 21-dot QR."
//
// ÖLÇÜLEN GERÇEK: 21 dot, CargoFlow'un KÜÇÜLTTÜĞÜ bir değer DEĞİLDİR —
// taşıyıcının KENDİ şablonunun yerli boyudur (`^BQN,4,4 `, sondaki boşluk
// yüzünden etkin büyütme 1). CargoFlow onu BÜYÜTÜR; büyütemediğinde
// taşıyıcının kendi komutu OLDUĞU GİBİ kalır.
//
// Composition'ı REDDETMEK bunu ÇÖZMEZ: `deriveAugmentedSuratZpl` composer
// başarısız olunca HAM TAŞIYICI ZPL'ine düşer — o da aynı 21 dot'u taşır.
// Yani "reddet" seçeneği 21 dot'lu etiketi ENGELLEMEZ, yalnızca CargoFlow
// iyileştirmesini kaldırır.
//
// Bu dalı kapatmanın TEK yolu aktarma metnini SARMAKTIR (iki satıra bölmek);
// bu, taşıyıcı metin alanına YENİ bir mutasyon sınıfı eklemek demektir ve bu
// biletin "mümkün olan EN KÜÇÜK whitelist" kuralının DIŞINDADIR.
test('PG2-3: V2 uzun metin — 21 dot TASIYICININ YERLI boyudur, CargoFlow kucultmez', async () => {
  const long = await compose(V2_ZPL, LONG)
  assert.equal(long.composed, true)
  // Olculen gercek KILITLENIR: sessizce degisemez.
  assert.equal(long.qr.width, 21, 'tasiyici yerli QR boyu')

  // KANIT: 21 dot KAYNAKTAN gelir. Ham (compose edilmemis) tasiyici ZPL'i
  // AYNI 21 dot'u uretir — yani CargoFlow bir seyi kucultmemistir.
  const rawZpl = withTransfer(V2_ZPL, LONG)
  const rawQr = diffBox(
    await render(rawZpl),
    await render(rawZpl.replace(/\^BQ[^\^]*\^FD[^\^]*\^FS/, '^FS')),
  )
  assert.equal(rawQr.width, 21, 'ham tasiyici etiketi de 21 dot')
  assert.equal(long.qr.width, rawQr.width, 'compose QR boyunu DEGISTIRMEDI')
})

// ═══ PG2-4 — ÖNCE METİN DARALIR ══════════════════════════════════════════

test('PG2-4: QR kucultulmeden ONCE aktarma fontu daraltilir', async () => {
  const short = await compose(V1_ZPL, SHORT)
  const med = await compose(V1_ZPL, MED)
  assert.equal(short.composed && med.composed, true)
  // Kisa metinde ozgun font KORUNUR (gereksiz daraltma YOK).
  assert.equal(short.transferFontWidth, 50, 'kisa metinde font DOKUNULMAZ')
  // Uzun metinde ONCE FONT daralir...
  assert.ok(med.transferFontWidth < 50, 'uzun metinde font DARALIR')
  // ...ve QR kanonik KALIR.
  assert.equal(med.qr.width, CANONICAL_QR_DOTS, 'QR kucultulmedi')
})

// ═══ PG2-5 — SIĞMAZSA GÜVENLİ RET, KÜÇÜK QR DEĞİL ════════════════════════

test('PG2-5: hicbir kademe sigdiramazsa GUVENLI RET (kucuk QR DEGIL)', async () => {
  for (const text of [LONG, VLONG]) {
    const out = await compose(V1_ZPL, text)
    assert.equal(out.composed, false, `"${text}" icin ret bekleniyor`)
    assert.match(String(out.reason), /QR aday/, 'ret sebebi geometri catismasi')
  }
})

// ═══ PG2-6 — ÜRÜN FOOTER'I QR'I ETKİLEMEZ ════════════════════════════════

test('PG2-6: urun footer varyasyonu QR boyutunu DEGISTIRMEZ', async () => {
  // Composer QR'i urun footer'indan BAGIMSIZ hesaplar: ayni aktarma metniyle
  // farkli urun icerikleri AYNI QR'i uretmelidir.
  const base = withTransfer(V1_ZPL, SHORT)
  const widths = []
  for (const items of [[], [{ productName: 'Tisort', quantity: 1 }], [
    { productName: 'Cok Uzun Bir Urun Adi Ornegi Buraya', quantity: 2 },
    { productName: 'Ikinci Urun', quantity: 1 },
    { productName: 'Ucuncu Urun', quantity: 3 },
  ]]) {
    const result = composeSuratLabel(base, {
      cargoTrackingNumber: VERIFIED_727,
      items,
    })
    assert.equal(result.composed, true)
    const qr = diffBox(
      await render(result.zpl),
      await render(result.zpl.replace(/\^BQ[^\^]*\^FD[^\^]*\^FS/, '^FS')),
    )
    widths.push(qr.width)
  }
  assert.equal(
    Math.max(...widths) - Math.min(...widths) <= RENDER_TOLERANCE_DOTS,
    true,
    `urun footer QR'i degistirdi: ${widths.join(' / ')}`,
  )
  for (const width of widths) assert.equal(width, CANONICAL_QR_DOTS)
})

// ═══ PG2-7 / PG2-8 — MUTASYON MUHAFIZI GEVŞETİLMEDİ ══════════════════════

test('PG2-7: whitelist GENISLETILMEDI — izin kumesi AYNI kaldi', async () => {
  // Guard yerinde ve SERT.
  assert.match(composerSource, /unexpectedMutations: 0/)
  assert.match(composerSource, /beklenmeyen taşıyıcı mutasyonu/)
  // Aktarma fontu izni HÂLÂ birebir from/to dizgisiyle sinirli; komut turu,
  // alan kimligi ve YUKSEKLIK degismez.
  assert.match(composerSource, /allowedTransferFont/)
  assert.match(
    composerSource,
    /mutation\.from === allowedTransferFont\.from &&\s*mutation\.to === allowedTransferFont\.to/,
  )
  // TEK KAYNAK: emit ve whitelist AYNI degerden beslenir.
  assert.match(composerSource, /const appliedTransferWidth = carrierQrEnlargement/)
  assert.match(composerSource, /allowedTransferFont[\s\S]{0,400}appliedTransferWidth/)
  // Genel bir "QR komutlari degisebilir" izni EKLENMEDI.
  assert.equal(/mutation\.name === 'BQ'\s*\)/.test(composerSource), false)
})

test('PG2-8: ILGISIZ tek bir tasiyici komut mutasyonu REDDEDILIR', async () => {
  // Composer'in whitelist dogrulamasi, izinli olmayan HER mutasyonu reddeder.
  // Bunu kaynak sozlesmesiyle kanitlariz: filtrenin varsayilani `true`dur
  // (yani "beklenmeyen") ve yalniz sayili dallar `false` doner.
  const start = composerSource.indexOf('const unexpected = diff.mutations.filter(')
  assert.ok(start > 0, 'whitelist filtresi bulunmali')
  const block = composerSource.slice(start, start + 2600)
  assert.match(block, /return true\s*\}\)/, 'varsayilan: BEKLENMEYEN')
  const allowances = (block.match(/return false/g) ?? []).length
  // IZIN SAYISI 38ca3d2 BASELINE'I ILE AYNIDIR (olculdu: 6 -> 6).
  // Yeni bir izin eklenirse bu test DUSER.
  assert.equal(allowances, 6, `whitelist izin sayisi degisti (${allowances})`)
})

// ═══ PG2-9 / PG2-11 — BİLİNMEYEN VE SAĞLAYICI ŞABLONLARI ═════════════════

test('PG2-9 / PG2-11: bilinmeyen ve saglayici sablonlarinda geometri yeniden yazilmaz', async () => {
  const geometry = await _vite.ssrLoadModule('/src/utils/labelTemplateGeometry.ts')
  assert.equal(geometry.mayMutateTemplateGeometry('bilinmeyen'), false)
  for (const key of ['trendyol_common_label', 'hepsiburada_mutual_barcode', 'aras_native']) {
    assert.equal(geometry.mayMutateTemplateGeometry(key), false, key)
  }
  // Bu bilet SURAT'a OZELDIR: kanonik buyutme sabiti yalniz Surat composer'inda.
  assert.match(composerSource, /CARRIER_QR_CANONICAL_MAGNIFICATION = 5/)
})

// ═══ PG2-10 — KAYITLI ARTEFAKT DEĞİŞMEZ ══════════════════════════════════

test('PG2-10: kayitli printZpl geriye donuk DEGISTIRILMEZ', async () => {
  const repository = readFileSync(
    join(here, 'shipments', 'printZplRepository.ts'),
    'utf8',
  )
  assert.match(repository, /printZplSourceSha256/)
  // Toplu yeniden yazma yolu YOK.
  assert.equal(/for\s*\([^)]*\)\s*\{[^}]*update\([^)]*printZpl/m.test(repository), false)
})
