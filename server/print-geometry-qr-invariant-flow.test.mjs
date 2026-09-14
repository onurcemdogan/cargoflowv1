// BASKI GEOMETRİSİ — QR BOYUTU BİR DEĞİŞMEZDİR.
//
// ═══ ÖLÇÜLEN ÜRETİM KUSURU ═══════════════════════════════════════════════
//
// `LABEL_LAYOUT_PROFILES` hem içerik bütçesini hem QR kenarını taşıyordu ve
// profil ÜRÜN FOOTER'ININ SIĞMASINA göre seçiliyordu. Ölçüldü (saf çözümleyici):
//
//   1–2 kalem → standard      → büyük QR 21.0 mm · küçük QR 12.5 mm
//   3+  kalem → compact-multi → büyük QR 18.0 mm · küçük QR 11.0 mm
//   5   kalem → dense-multi   → büyük QR 15.5 mm · küçük QR  9.5 mm
//
// Yani 4. öncelik (opsiyonel ürün footer'ı) 1. önceliği (QR okunabilirliği)
// küçültüyordu. Bu dosya o küçülmenin GERİ GELMEMESİNİ kilitler.
//
// ═══ ÖLÇÜM GERÇEK RENDER'DAN ═════════════════════════════════════════════
//
// ZPL tarafında iddia GÖZLE değil, yerel zebrash motorunun ÜRETTİĞİ BİTMAP
// üzerinden ölçülür. QR mürekkebi izole etmek için aynı ZPL iki kez render
// edilir (QR komutuyla ve komut çıkarılmış hâliyle); FARK tam olarak QR'dır.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import { decodePngToBitmap } from './labels/pngLandmarks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const V2_ZPL = readFileSync(
  join(here, 'fixtures', 'surat-real-v2-numeric.zpl'),
  'utf8',
)
const V1_ZPL = readFileSync(
  join(here, 'fixtures', 'real-template-masked.zpl'),
  'utf8',
)
const VERIFIED_727 = '7270034422363739'

let _vite
let renderZplToPng
let composeSuratLabel
let resolveLabelLayout
let templateGeometry
let layoutProfile

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
  ;({ resolveLabelLayout } = await _vite.ssrLoadModule(
    '/src/utils/labelLayoutResolver.ts',
  ))
  templateGeometry = await _vite.ssrLoadModule(
    '/src/utils/labelTemplateGeometry.ts',
  )
  layoutProfile = await _vite.ssrLoadModule('/src/utils/labelLayoutProfile.ts')
})
after(async () => {
  if (_vite) await _vite.close()
})

const render = async (zpl) =>
  decodePngToBitmap(
    Buffer.from((await renderZplToPng({ zpl })).pngBase64, 'base64'),
  )

/** İki bitmap arasındaki FARKLI piksellerin sınırlayıcı kutusu. */
function diffBox(a, b) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  let pixels = 0
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (a.dark[y][x] === b.dark[y][x]) continue
      pixels += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (pixels === 0) return null
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    pixels,
  }
}

/** Verilen aktarma metniyle composed etiketin QR mürekkep kutusu. */
async function measureQr(baseZpl, transferText) {
  const zpl = baseZpl.replace(
    /(FT220,705\^A0N,70,50\^FH\\\^FD)[^^]*/,
    (_match, prefix) => prefix + transferText,
  )
  const composed = composeSuratLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  // FAIL-CLOSED BİR SONUÇTUR: composer hiçbir QR adayını güvenli bulmazsa
  // etiketi REDDEDER. Bu bir hata DEĞİL, doğru önceliktir — küçülmüş QR
  // basmaktansa basmamak. Çağıran iki dalı AYIRT edebilsin diye null döner.
  if (!composed.composed) return null
  const stripped = composed.zpl.replace(/\^BQ[^\^]*\^FD[^\^]*\^FS/, '^FS')
  const box = diffBox(await render(composed.zpl), await render(stripped))
  assert.ok(box, `QR mürekkebi bulunamadı (transfer=${transferText})`)
  return box
}

/**
 * RENDERER TOLERANSI.
 *
 * Aynı `^BQ` büyütmesi aynı modül ızgarasını üretir; fark BEKLENMEZ. Tolerans
 * yine de AÇIK yazılır ki "yaklaşık eşit" sessiz bir kabul hâline gelmesin.
 */
const RENDER_TOLERANCE_DOTS = 1

const SHORT_TRANSFER = 'IZMIR'
const LONG_TRANSFER = 'DIKILI/CAN BALIKESIR AKTARMA'
const LONGER_TRANSFER = 'KAHRAMANMARAS ELBISTAN AKTARMA MERKEZI'

// ═══ ZPL ŞABLONU — GERÇEK PİKSEL ÖLÇÜMÜ ══════════════════════════════════

/** Kanonik composer QR kenari (dot) = 13.125 mm @ 203 dpi. */
const CANONICAL_COMPOSER_QR_DOTS = 105

// ═══ PRINT-GEOMETRY-002 İLE ÇÖZÜLDÜ ═══════════════════════════════
//
// Bu iki test PRINT-GEOMETRY-001'de kusuru ÖLÇÜP KİLİTLEMİŞTİ (V1: 105→84,
// V2: 126→21). PRINT-GEOMETRY-002 kanonik büyütmeyi sabitleyip metin-önce
// sıralamasını getirince kusur ORTADAN KALKTI ve testler — tam da görevleri
// olduğu gibi — DÜŞTÜ. Artık ÇÖZÜLMÜŞ durumu iddia ederler.
//
// Ayrıntılı ölçümler: `print-geometry-zpl-qr-canonical-flow.test.mjs` (PG2-*).

test('QR-GEOMETRY-1: V1 composer QR uzun aktarma metninde KUCULMEZ', async () => {
  const short = await measureQr(V1_ZPL, SHORT_TRANSFER)
  const mid = await measureQr(V1_ZPL, 'BALIKESIR AKTARMA')
  assert.ok(short && mid, 'iki etiket de uretilmeli')
  assert.equal(short.width, CANONICAL_COMPOSER_QR_DOTS, 'kisa metin: kanonik')
  // ESKIDEN 84 IDI. Artik metin daralir, QR KANONIK kalir.
  assert.equal(mid.width, CANONICAL_COMPOSER_QR_DOTS, 'uzun metin: KANONIK')
  assert.equal(mid.height, CANONICAL_COMPOSER_QR_DOTS)
  for (const box of [short, mid]) {
    assert.ok(box.x >= 0 && box.y >= 0)
    assert.ok(box.x + box.width <= 799 && box.y + box.height <= 799)
  }
  // Sigdiramadigi durumda KUCULTMEZ, REDDEDER.
  assert.equal(await measureQr(V1_ZPL, LONGER_TRANSFER), null)
})

test('QR-GEOMETRY-1b: V2 tasiyici QR uretilebilen etiketlerde KANONIK', async () => {
  const short = await measureQr(V2_ZPL, SHORT_TRANSFER)
  const mid = await measureQr(V2_ZPL, 'BALIKESIR AKTARMA')
  assert.ok(short && mid)
  // ESKIDEN 126 ve 21 IDI. Ikisi de artik KANONIK 105.
  assert.equal(short.width, CANONICAL_COMPOSER_QR_DOTS, 'kisa metin: 126 DEGIL 105')
  assert.equal(mid.width, CANONICAL_COMPOSER_QR_DOTS, 'orta metin: 21 DEGIL 105')
  for (const box of [short, mid]) {
    assert.ok(box.x >= 0 && box.y >= 0)
    assert.ok(box.x + box.width <= 799 && box.y + box.height <= 799)
  }
})

test('QR-GEOMETRY-4: AYNI aktarma metninde QR kenari DETERMINISTIK ve sayfada', async () => {
  // Bu test ICERIKLER ARASI degil, AYNI icerik icin TEKRARLANABILIRLIGI
  // olcer: ayni girdi ayni QR'i uretmeli (reprint ayniligi). Icerikler
  // arasi degisim AYRI ve ACIK kusur testlerinde (1 ve 1b) olculur.
  const boxes = []
  for (let run = 0; run < 2; run += 1) {
    const box = await measureQr(V1_ZPL, SHORT_TRANSFER)
    if (box) boxes.push(box)
  }
  assert.ok(boxes.length >= 2, 'karsilastirmak icin en az iki render gerekir')
  const widths = boxes.map((box) => box.width)
  const heights = boxes.map((box) => box.height)
  assert.equal(
    Math.max(...widths) - Math.min(...widths) <= RENDER_TOLERANCE_DOTS,
    true,
    `ayni girdi farkli QR uretti: ${widths.join(' / ')}`,
  )
  assert.equal(
    Math.max(...heights) - Math.min(...heights) <= RENDER_TOLERANCE_DOTS,
    true,
    `QR yuksekligi icerikle degisti: ${heights.join(' / ')}`,
  )
  // QR sayfa icinde kalir (kirpilma YOK).
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.y >= 0, 'QR sayfa disina tasmaz')
    assert.ok(box.x + box.width <= 799, 'QR sag kenardan tasmaz')
    assert.ok(box.y + box.height <= 799, 'QR alt kenardan tasmaz')
  }
})

test('QR-GEOMETRY-8: yeni uretilen etiket KANONIK sabit geometriyi tasir', async () => {
  const box = await measureQr(V1_ZPL, 'MALTEPE AKTARMA')
  assert.ok(box, 'bu fixture etiket URETMELI')
  const geometry = templateGeometry.resolveLabelTemplateGeometry(
    'surat_official_zpl',
  )
  const expectedDots = templateGeometry.templateMmToDots(
    geometry,
    geometry.largeQr.sideMm,
  )
  assert.equal(expectedDots, 105)
  assert.equal(box.width, expectedDots)
  assert.equal(box.height, expectedDots)
  // Fiziksel rapor: 105 dot / 8 dpmm = 13.125 mm.
  assert.equal((box.width / 8).toFixed(3), '13.125')
})

// ═══ HTML ŞABLONU — SAF ÇÖZÜMLEYİCİ ÖLÇÜMÜ ═══════════════════════════════

const productItem = (index) => ({
  productName: `Kus ve Cicek Desenli Dekoratif Tepsi Yesil Altin Sarisi ${index}`,
  quantity: 1,
  color: 'Yesil',
  size: 'Tek Ebat',
  sku: `SKU-${index}`,
})

const layoutFor = (items, transfer = 'MALTEPE AKTARMA') =>
  resolveLabelLayout({
    destination: 'IZMIR',
    transfer,
    items: Array.from({ length: items }, (_, index) => productItem(index + 1)),
  })

test('QR-GEOMETRY-2: uzun urun footer QR kenarini DEGISTIRMEZ', () => {
  const one = layoutFor(1)
  const two = layoutFor(2)
  assert.equal(one.ok && two.ok, true)
  assert.equal(one.metrics.largeQrMm, two.metrics.largeQrMm)
  assert.equal(one.metrics.smallQrMm, two.metrics.smallQrMm)
})

test('QR-GEOMETRY-3: 3+ kalemli footer QR kenarini DEGISTIRMEZ', () => {
  // ESKI DAVRANIS: 3 kalemde profil compact-multi'ye dusuyor ve buyuk QR
  // 21.0 → 18.0 mm KUCULUYORDU. Profil hala dusebilir (icerik butcesi
  // yeniden dagitilir) ama QR SABIT kalir.
  const one = layoutFor(1)
  const three = layoutFor(3)
  assert.equal(one.ok && three.ok, true)
  assert.notEqual(one.profile.key, three.profile.key, 'profil yine degisir')
  assert.equal(three.metrics.largeQrMm, one.metrics.largeQrMm, 'QR SABIT')
  assert.equal(three.metrics.smallQrMm, one.metrics.smallQrMm, 'QR SABIT')
  assert.equal(three.metrics.largeQrMm, 21)
  assert.equal(three.metrics.smallQrMm, 12.5)
})

test('QR-GEOMETRY-5: rota metni sigmazsa FONT kuculur, QR KUCULMEZ', () => {
  const short = layoutFor(3, 'MALTEPE AKTARMA')
  const long = layoutFor(3, 'DIKILI/CAN BALIKESIR AKTARMA')
  assert.equal(short.ok && long.ok, true)
  // Metin kademesi DUSER — dogru davranis budur.
  assert.ok(
    long.routeFit.tier.transferPt <= short.routeFit.tier.transferPt,
    'uzun rota metninde punto kuculur veya ayni kalir',
  )
  // QR AYNI kalir.
  assert.equal(long.metrics.largeQrMm, short.metrics.largeQrMm)
  assert.equal(long.metrics.smallQrMm, short.metrics.smallQrMm)
})

test('QR-GEOMETRY-INVARIANT: hicbir profil QR kenarini TASIMAZ', () => {
  for (const profile of layoutProfile.LABEL_LAYOUT_PROFILES) {
    assert.equal('largeQrMm' in profile, false)
    assert.equal('smallQrMm' in profile, false)
    // Teslimat satiri buyuk QR'i TASIYABILMELIDIR; eskiden bu satir QR ile
    // BIRLIKTE kuculuyordu ve kuculmenin GERCEK sebebi buydu.
    assert.ok(
      profile.deliveryRowMm >= layoutProfile.LABEL_QR_SIDES_MM.largeQrMm,
      `${profile.key}: teslimat satiri QR'dan kucuk OLAMAZ`,
    )
  }
})

// ═══ ŞABLON KAYDI VE SAĞLAYICI SAHİPLİĞİ ═════════════════════════════════

test('QR-GEOMETRY-6: desteklenmeyen sablon icin GUVENLI yeniden yazim YOK', () => {
  assert.equal(
    templateGeometry.resolveLabelTemplateGeometry('bilinmeyen_sablon'),
    null,
  )
  // Bilinmeyende geometri mutasyonu YASAK (fail-safe).
  assert.equal(
    templateGeometry.mayMutateTemplateGeometry('bilinmeyen_sablon'),
    false,
  )
  assert.equal(templateGeometry.mayMutateTemplateGeometry(null), false)
  assert.equal(templateGeometry.mayMutateTemplateGeometry(undefined), false)
})

test('QR-GEOMETRY-PROVIDER: saglayiciya ait ZPL YENIDEN YAZILMAZ', () => {
  for (const key of [
    'trendyol_common_label',
    'hepsiburada_mutual_barcode',
    'aras_native',
  ]) {
    const geometry = templateGeometry.resolveLabelTemplateGeometry(key)
    assert.ok(geometry, key)
    assert.equal(geometry.mayMutateGeometry, false, `${key}: mutasyon YASAK`)
    assert.equal(templateGeometry.isProviderOwnedTemplate(key), true)
    // Urun footer'i saglayici etiketine EKLENMEZ.
    assert.equal(geometry.productFooterEligible, false)
  }
})

test('QR-GEOMETRY-PAGE: sayfa olcusu SABLONA ozeldir, global DEGIL', () => {
  const surat = templateGeometry.resolveLabelTemplateGeometry(
    'surat_official_zpl',
  )
  const html = templateGeometry.resolveLabelTemplateGeometry('cargoflow_html')
  assert.equal(surat.pageWidthMm, 100)
  assert.equal(surat.pageHeightMm, 100)
  assert.equal(html.pageWidthMm, 100)
  assert.equal(html.pageHeightMm, 100)
  // Saglayici sablonlarinda olcu UYDURULMAZ: kanit yoksa null.
  for (const key of [
    'trendyol_common_label',
    'hepsiburada_mutual_barcode',
    'aras_native',
  ]) {
    const geometry = templateGeometry.resolveLabelTemplateGeometry(key)
    assert.equal(geometry.pageWidthMm, null, `${key}: olcu UYDURULMAZ`)
    assert.equal(geometry.pageHeightMm, null, `${key}: olcu UYDURULMAZ`)
    assert.equal(geometry.dotsPerMm, null, `${key}: DPI UYDURULMAZ`)
  }
})

// ═══ KAYITLI ARTEFAKT DEĞİŞMEZLİĞİ ═══════════════════════════════════════

test('QR-GEOMETRY-7: kayitli printZpl GERIYE DONUK DEGISTIRILMEZ', async () => {
  const repository = readFileSync(
    join(here, 'shipments', 'printZplRepository.ts'),
    'utf8',
  )
  // Kayitli artefakt AYNEN kullanilir; hash uyusmazliginda SESSIZCE
  // yeniden uretilmez, ACIK hata verilir.
  assert.match(repository, /printZplSourceSha256/)
  assert.match(repository, /compare-and-set|compareAndSet/i)
  // Geometri surumu YENI artefaktlara uygulanir; bu dosya kayitli olanlari
  // toplu guncelleyen bir yol ICERMEZ.
  assert.equal(
    /update\([^)]*\)\s*\.set\(\{[^}]*printZpl[^}]*\}\)\s*$/m.test(repository),
    false,
  )
})
