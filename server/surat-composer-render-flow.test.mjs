import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import { decodePngToBitmap, measureInkBox } from './labels/pngLandmarks.mjs'

// DURUSOFT COMPOSER — GERÇEK RENDER GEOMETRİSİ.
//
// Yerel zebrash motoruyla 799×799 render alınır ve MÜREKKEP KUTULARI ölçülür.
// Dizgi/snapshot testi değildir: her iddia gerçek piksellere dayanır.
//
// ═══ RENDERER SAPMALARI (ölçülmüş, bilinçli olarak assert EDİLMEZ) ════════
//
//  1) zebrash `>:` (Code128 subset C) önekini UYGULAMAZ; her zaman subset B
//     kodlar. Gerçek Zebra subset C kodlar ve barkod DAHA DARDIR. Bu yüzden
//     barkod altı metnin TAM ORTALANMASI burada assert EDİLMEZ — yalnız
//     metnin barkodun güvenli yatay bandında kaldığı ve taşmadığı kanıtlanır.
//     Tam yatay ortalama FİZİKSEL Zebra kabulüyle doğrulanacaktır.
//
//  2) zebrash `^BQ`'yu `^FO y + yürürlükteki ^BY yüksekliği` konumuna koyar.
//     Composer QR'dan hemen önce küçük ve bilinen bir `^BY` yazdığı için fark
//     10 dot ile sınırlıdır; testler QR'ı bu 10 dotluk belirsizliği KAPSAYAN
//     bantta doğrular.
//
//  3) `^A@…TT0003M_` indirilmiş fontu zebrash'te YOK; yedek fontla çizilir.
//     Bold adres bloğu kaynak satırların BAYT KOPYASI olduğu için genişlik
//     karşılaştırmaları iki blok arasında yapılır (mutlak değere bağlı değil).

const here = dirname(fileURLToPath(import.meta.url))
const zpl = readFileSync(
  join(here, 'fixtures', 'real-template-masked.zpl'),
  'utf8',
)
const VERIFIED_727 = '7271234567890'

let _vite
let renderZplToPng
let composeSuratDurusoftLabel
let deriveAugmentedSuratZplWithHashes

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
    // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
    // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
    // "server is being restarted or closed" hatası verir. SSR-only test
    // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
    // tarama tamamen kapatılır.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ renderZplToPng } = await _vite.ssrLoadModule(
    '/server/labels/zplRenderService.ts',
  ))
  ;({ composeSuratDurusoftLabel } = await _vite.ssrLoadModule(
    '/src/utils/suratDurusoftComposer.ts',
  ))
  ;({ deriveAugmentedSuratZplWithHashes } = await _vite.ssrLoadModule(
    '/src/utils/augmentedSuratZpl.ts',
  ))
})
after(async () => {
  if (_vite) await _vite.close()
})

async function render(source) {
  const result = await renderZplToPng({ zpl: source })
  return {
    bitmap: decodePngToBitmap(Buffer.from(result.pngBase64, 'base64')),
    widthPx: result.widthPx,
    heightPx: result.heightPx,
    renderSha256: result.renderSha256,
  }
}

const box = (bitmap, x, y, width, height) =>
  measureInkBox(bitmap, { x, y, width, height })

const right = (b) => b.x + b.width - 1
const bottom = (b) => b.y + b.height - 1

/** İki kutu kesişiyor mu (kapsayıcı sınırlar). */
function overlaps(a, b) {
  return (
    a.x <= right(b) && b.x <= right(a) && a.y <= bottom(b) && b.y <= bottom(a)
  )
}

// Kaynak şablonun DEĞİŞMEMESİ gereken mürekkep işaretleri. Pencereler kutu
// kenar çizgilerini (x=59 / x=773 dikey kuralları) DIŞLAR.
const CARRIER_LANDMARKS = [
  ['code128 gövde', 46, 157, 750, 144],
  ['adres satırı 1', 66, 357, 700, 21],
  ['adres satırı 2', 66, 378, 700, 21],
  // Pencere y=341'den başlar: kaynaktaki DAHİLİ yorum satırı y=340'a kadar
  // uzanıp alıcı adı bandına giriyor. Yorum satırı composed modda bilinçli
  // olarak kaldırıldığı için ölçüme dahil edilmemelidir; y≥341'de iki render
  // birebir aynıdır (ölçüldü).
  ['alıcı adı', 66, 341, 700, 14],
  ['alıcı tel', 100, 452, 300, 22],
  ['il / ilçe', 500, 452, 270, 22],
  ['rota', 170, 590, 420, 46],
  ['aktarma', 170, 638, 420, 70],
  ['DataMatrix', 40, 490, 120, 220],
]

test('CR-1: composed çıktı 799×799 tek etiket olarak render edilir', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  assert.equal(composed.composed, true, composed.reason ?? '')
  const { widthPx, heightPx } = await render(composed.zpl)
  assert.equal(widthPx, 799)
  assert.equal(heightPx, 799)
})

test('CR-2: taşıyıcı işaretleri compose sonrası AYNI piksellerde', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  const before = (await render(zpl)).bitmap
  const afterBitmap = (await render(composed.zpl)).bitmap
  for (const [name, ...window] of CARRIER_LANDMARKS) {
    const a = box(before, ...window)
    const b = box(afterBitmap, ...window)
    assert.ok(a, `${name}: kaynakta mürekkep olmalı`)
    assert.deepEqual(
      { x: b.x, y: b.y, width: b.width, height: b.height },
      { x: a.x, y: a.y, width: a.width, height: a.height },
      `${name} kayması YOK`,
    )
  }
})

test('CR-3: barkod altı sayı KÜÇÜLÜR ve güvenli bantta kalır', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  // Pencere y=335'te BİTER: y=336'daki alıcı kutusu üst çizgisi her iki
  // render'da da tam genişlikte mürekkep bırakır ve karşılaştırmayı anlamsız
  // kılardı. Dahili yorum satırı gerçekte y=340'a kadar uzanıyor; pencere onu
  // kırptığı için "küçüldü" iddiası TEMKİNLİ tarafta kalır (gerçek fark daha
  // büyüktür).
  const builtIn = box((await render(zpl)).bitmap, 46, 302, 750, 34)
  const custom = box((await render(composed.zpl)).bitmap, 46, 302, 750, 34)
  assert.ok(builtIn && custom, 'iki modda da sayı basılmalı')

  // DuruSoft hedefi: daha küçük ve daha ince.
  assert.ok(
    custom.height < builtIn.height,
    `yükseklik küçülmeli: ${custom.height} < ${builtIn.height}`,
  )
  assert.ok(
    custom.width < builtIn.width,
    `genişlik küçülmeli: ${custom.width} < ${builtIn.width}`,
  )

  // Barkodun yatay bandı içinde ve alıcı kutusunun ÜSTÜNDE.
  const body = box((await render(composed.zpl)).bitmap, 46, 157, 750, 144)
  assert.ok(custom.x >= body.x, 'metin barkodun solundan taşmaz')
  assert.ok(right(custom) <= right(body), 'metin barkodun sağından taşmaz')
  assert.ok(bottom(custom) < 336, 'metin alıcı kutusuna değmez')
  assert.ok(custom.y > 300, 'metin barkodun altında')
})

test('CR-4: bold adres bloğu ayrılmış slotlara yazılır ve TAŞMAZ', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  const bitmap = (await render(composed.zpl)).bitmap
  // 401..452: kaynakta BOŞ olan bold bölge (alıcı kutusu tabanı 476).
  const bold = box(bitmap, 66, 401, 700, 52)
  assert.ok(bold, 'bold adres bloğu basılmalı')
  assert.ok(bold.x >= 63, 'sol kenar slot x’inde başlar')
  assert.ok(right(bold) <= 765, `sağ sınırı aşmaz: ${right(bold)}`)
  assert.ok(bottom(bold) < 476, 'alıcı kutusu tabanını aşmaz')

  // Kaynak adres satırları AYNEN durur (çift blok, tek blok değil).
  const sourceLine = box(bitmap, 66, 357, 700, 21)
  assert.ok(sourceLine, 'normal adres korunur')
  assert.ok(
    !overlaps(sourceLine, bold),
    'bold blok normal adresin üstüne binmez',
  )
  // Bold blok, kaynak satırın BAYT KOPYASI + 1 dot: genişlik farkı küçük olmalı.
  const boldFirst = box(bitmap, 66, 401, 700, 16)
  assert.ok(boldFirst, 'bold ilk satır')
  assert.ok(
    Math.abs(boldFirst.width - sourceLine.width) <= 2,
    `bold satır kaynak satırla aynı genişlikte olmalı: ${boldFirst.width} / ${sourceLine.width}`,
  )
})

test('CR-5: QR sağ altta, etiket içinde, quiet-zone korunmuş', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  const { qrBox, qrRenderYOffset } = composed.diagnostics
  assert.ok(qrBox, 'QR üretilmeli')
  const bitmap = (await render(composed.zpl)).bitmap
  const qr = box(bitmap, qrBox.x - 20, qrBox.y - 20, qrBox.size + 60, qrBox.size + 60)
  assert.ok(qr, 'QR mürekkebi ölçülmeli')

  assert.equal(qr.x, qrBox.x, 'X tam ^FO konumunda')
  assert.equal(qr.width, qrBox.size, 'modül boyutu (mag 5 → 105 dot)')
  assert.equal(qr.height, qrBox.size)
  // Y, renderer sapmasını KAPSAYAN bantta.
  assert.ok(
    qr.y >= qrBox.y && qr.y <= qrBox.y + qrRenderYOffset,
    `QR y bandı: ${qr.y} ∈ [${qrBox.y}, ${qrBox.y + qrRenderYOffset}]`,
  )
  // Etiket içinde ve quiet-zone korunmuş.
  assert.ok(right(qr) <= 799 - 16, `sağ quiet-zone: ${right(qr)}`)
  assert.ok(bottom(qr) <= 799 - 16, `alt quiet-zone: ${bottom(qr)}`)
})

test('CR-6: QR hiçbir taşıyıcı öğesiyle ÇAKIŞMAZ', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  const bitmap = (await render(composed.zpl)).bitmap
  const { qrBox, qrRenderYOffset } = composed.diagnostics
  // İki renderer yorumunu da kapsayan EN KÖTÜ DURUM kutusu.
  const worstCase = {
    x: qrBox.x,
    y: qrBox.y,
    width: qrBox.size,
    height: qrBox.size + qrRenderYOffset,
  }
  for (const [name, ...window] of CARRIER_LANDMARKS) {
    const landmark = box(bitmap, ...window)
    assert.ok(
      !overlaps(worstCase, landmark),
      `QR ${name} ile çakışmamalı (${landmark.x}..${right(landmark)} / ${landmark.y}..${bottom(landmark)})`,
    )
  }
  // Dikey ray (sol kenar) ve etiket sınırı.
  const rail = box(bitmap, 0, 200, 48, 560)
  if (rail) assert.ok(!overlaps(worstCase, rail), 'QR dikey rayla çakışmaz')
})

test('CR-7: doğrulanmış değer yoksa QR BASILMAZ', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {})
  assert.equal(composed.composed, true, 'composer yine de çalışır')
  assert.equal(composed.diagnostics.qrBox, null)
  assert.equal(composed.diagnostics.qrRejection, 'no_candidate')
  const bitmap = (await render(composed.zpl)).bitmap
  assert.equal(
    box(bitmap, 600, 560, 199, 200),
    null,
    'sağ alt bölgede mürekkep OLMAMALI',
  )
})

test('CR-8: ürün footer’ı QR’ın ALTINA yerleşir, çakışma yok', async () => {
  const derived = deriveAugmentedSuratZplWithHashes(
    zpl,
    [
      {
        productName: 'Scuba Secil Detayli Tesettur Lacivert Elbise',
        quantity: 2,
        color: 'Lacivert',
        size: '40',
        sku: 'SCUBA-SEC01',
      },
    ],
    { compose: { cargoTrackingNumber: VERIFIED_727 } },
  )
  assert.equal(derived.renderContract, 'durusoft_composed')
  assert.equal(derived.augmentationStatus, 'success', 'footer eklenmeli')
  const bitmap = (await render(derived.printZpl)).bitmap

  const footer = box(
    bitmap,
    0,
    derived.metrics.footerTop,
    799,
    799 - derived.metrics.footerTop,
  )
  assert.ok(footer, 'footer mürekkebi olmalı')
  assert.ok(bottom(footer) <= 798, 'footer etiket dışına taşmaz')

  const qrBoxDiag = { x: 645, y: 596, size: 105 }
  const qr = box(bitmap, qrBoxDiag.x - 5, qrBoxDiag.y - 5, qrBoxDiag.size + 25, qrBoxDiag.size + 30)
  assert.ok(qr, 'QR footer eklendikten sonra da basılmalı')
  assert.ok(
    footer.y > bottom(qr),
    `footer QR’ın altında başlamalı: ${footer.y} > ${bottom(qr)}`,
  )
})

test('CR-9: composed render DETERMİNİSTİK (aynı girdi → aynı PNG)', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  const first = await render(composed.zpl)
  const second = await render(composed.zpl)
  assert.equal(first.renderSha256, second.renderSha256)
})

test('CR-10: hiçbir mürekkep 799×799 dışına çıkmaz', async () => {
  const derived = deriveAugmentedSuratZplWithHashes(
    zpl,
    [{ productName: 'Ornek Urun', quantity: 1, sku: 'SKU-1' }],
    { compose: { cargoTrackingNumber: VERIFIED_727 } },
  )
  const { bitmap } = await render(derived.printZpl)
  const all = box(bitmap, 0, 0, 799, 799)
  assert.ok(all.x >= 0 && all.y >= 0)
  assert.ok(right(all) <= 798, `sağ kenar: ${right(all)}`)
  assert.ok(bottom(all) <= 798, `alt kenar: ${bottom(all)}`)
})

test('CR-11: uyarlanabilir QR yerleşimi gerçek render’da ÇAKIŞMAZ', async () => {
  const BS = String.fromCharCode(92)
  const withTransfer = (value) =>
    zpl.replace(
      /\^FT220,705\^A0N,70,50\^FH.\^FD[^^]*\^FS/,
      `^FT220,705^A0N,70,50^FH${BS}^FD${value}^FS`,
    )
  // "IKITELLI AKTARMA" üretimde fallback veren sınıftır; "ERZURUM AKTARMA"
  // ise ölçek küçültmeyi tetikler. İkisi de render’da doğrulanır.
  for (const [name, expectedMagnification] of [
    ['IKITELLI AKTARMA', 5],
    ['ERZURUM AKTARMA', 4],
  ]) {
    const source = withTransfer(name)
    const derived = deriveAugmentedSuratZplWithHashes(
      source,
      [{ productName: 'Ornek Urun', quantity: 2, sku: 'S1' }],
      { compose: { cargoTrackingNumber: VERIFIED_727 } },
    )
    assert.equal(derived.renderContract, 'durusoft_composed', name)
    const composed = composeSuratDurusoftLabel(source, {
      cargoTrackingNumber: VERIFIED_727,
    })
    const { qrBox, qrMagnification, qrRenderYOffset } = composed.diagnostics
    assert.equal(qrMagnification, expectedMagnification, `${name} ölçeği`)

    const bitmap = (await render(derived.printZpl)).bitmap
    const qr = box(bitmap, qrBox.x - 25, qrBox.y - 25, qrBox.size + 60, qrBox.size + 60)
    assert.ok(qr, `${name}: QR mürekkebi`)
    assert.equal(qr.width, qrBox.size, `${name}: modül boyutu`)
    assert.equal(qr.x, qrBox.x, `${name}: X tam ^FO konumunda`)

    // Komşu makine-okunur/metin alanlarıyla ÇAKIŞMA YOK.
    const quiet = 4 * qrMagnification
    // Komşu ölçüm pencereleri QR'ın SOLUNDA biter: QR dış marj simetrisi
    // gereği sola kayabildiği için sabit genişlikli pencereler QR mürekkebini
    // komşunun kutusuna KATIYORDU (yanlış çakışma raporu).
    const widthTo = (from) => Math.max(1, qr.x - from - 1)
    for (const [label, ...window] of [
      ['aktarma', 170, 638, widthTo(170), 70],
      ['rota', 170, 590, widthTo(170), 46],
      ['teslim tipi', 300, 560, widthTo(300), 42],
      ['DataMatrix', 40, 490, 120, 220],
    ]) {
      const neighbour = box(bitmap, ...window)
      if (!neighbour) continue
      assert.ok(!overlaps(qr, neighbour), `${name}: ${label} ile çakışma`)
      if (right(neighbour) < qr.x) {
        assert.ok(
          qr.x - right(neighbour) >= quiet,
          `${name}: ${label} ile quiet-zone (${qr.x - right(neighbour)} < ${quiet})`,
        )
      }
    }
    // Etiket sınırı ve quiet-zone.
    assert.ok(right(qr) + quiet <= 799, `${name}: sağ quiet-zone`)
    assert.ok(bottom(qr) + quiet <= 799, `${name}: alt quiet-zone`)

    // Ürün footer’ı QR’ın ALTINDA, çakışma yok.
    const footer = box(bitmap, 0, derived.metrics.footerTop, 799,
      799 - derived.metrics.footerTop)
    assert.ok(footer, `${name}: footer`)
    assert.ok(!overlaps(qr, footer), `${name}: footer çakışması`)
    assert.ok(bottom(footer) <= 798, `${name}: footer taşması`)

    // Hiçbir mürekkep etiket dışına çıkmaz.
    const all = box(bitmap, 0, 0, 799, 799)
    assert.ok(right(all) <= 798 && bottom(all) <= 798, `${name}: taşma`)
  }
})

// ═══ VISUAL-1..4: ORTAK RAY / SİMETRİ ÖLÇÜMLERİ ══════════════════════════
//
// Yalnız "çakışma yok" demek yeterli değil; dengeyi SAYISALLAŞTIRIR.
// Toleranslıdır: font rasterizasyonu ±birkaç dot oynayabilir.
//
// SINIR: DuruSoft referans GÖRSELİ bu doğrulamalarda KULLANILMADI (bu turda
// erişilemedi). Raylar taşıyıcının KENDİ `^GB` çizgilerinden türetilmiştir;
// iddialar "referansa benziyor" değil, "kendi ızgarasına oturuyor" biçimindedir.

const TOL = 4

test('VISUAL-1: composer’ın eklediği alanlar ORTAK RAYLARA oturur', async () => {
  const { SURAT_GRID } = await _vite.ssrLoadModule(
    '/src/utils/suratDurusoftComposer.ts',
  )
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  const bitmap = (await render(composed.zpl)).bitmap

  // Barkod ve altındaki insan-okunur metin AYNI sol raydan başlar.
  const body = box(bitmap, 46, 157, 750, 144)
  const humanText = box(bitmap, 46, 302, 750, 34)
  assert.equal(body.x, SURAT_GRID.contentLeft, 'barkod sol rayda')
  assert.ok(
    humanText.x >= body.x && right(humanText) <= right(body),
    'insan metni barkod bandı içinde',
  )

  // Normal adres ile bold tekrar AYNI sol çapada.
  const normalAddress = box(bitmap, 66, 357, 700, 21)
  const boldAddress = box(bitmap, 66, 401, 700, 16)
  assert.ok(
    Math.abs(boldAddress.x - normalAddress.x) <= 2,
    `bold adres normal adresle aynı sol çapada: ${boldAddress.x} / ${normalAddress.x}`,
  )
})

test('VISUAL-2: alıcı kutusu içeriği kutu raylarının İÇİNDE dengeli', async () => {
  const { SURAT_GRID } = await _vite.ssrLoadModule(
    '/src/utils/suratDurusoftComposer.ts',
  )
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  const bitmap = (await render(composed.zpl)).bitmap
  for (const [name, ...window] of [
    ['alıcı adı', 66, 341, 700, 14],
    ['adres 1', 66, 357, 700, 21],
    ['adres 2', 66, 378, 700, 21],
    ['bold adres', 66, 401, 700, 52],
    ['alıcı tel', 100, 452, 300, 22],
  ]) {
    const entry = box(bitmap, ...window)
    if (!entry) continue
    assert.ok(entry.x > SURAT_GRID.boxLeft, `${name} sol rayın içinde`)
    assert.ok(right(entry) < SURAT_GRID.boxRight, `${name} sağ rayın içinde`)
  }
})

test('VISUAL-3: alt bölüm [DataMatrix] [orta] [QR] dengesi', async () => {
  const composed = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
  })
  const bitmap = (await render(composed.zpl)).bitmap
  const { qrBox } = composed.diagnostics
  const dataMatrix = box(bitmap, 40, 490, 130, 220)
  const qr = box(bitmap, qrBox.x - 25, qrBox.y - 25, qrBox.size + 60, qrBox.size + 60)
  const centre = box(bitmap, 170, 560, 420, 150)
  assert.ok(dataMatrix && qr && centre, 'üç blok da basılmalı')

  // DIŞ MARJ SİMETRİSİ: QR'ın sağ marjı DataMatrix'in sol marjına eşit
  // (komşu metin QR'ı sağa itmediyse).
  const leftMargin = dataMatrix.x
  const rightMargin = 799 - right(qr)
  assert.ok(
    Math.abs(leftMargin - rightMargin) <= TOL,
    `dış marj simetrisi: sol ${leftMargin} / sağ ${rightMargin}`,
  )
  // Orta blok İKİ KODUN ARASINDA kalır.
  assert.ok(centre.x > right(dataMatrix), 'orta blok DataMatrix’in sağında')
  assert.ok(right(centre) < qr.x, 'orta blok QR’ın solunda')
})

test('VISUAL-4: footer ortak sol aileye yakın ve taşmıyor', async () => {
  const { SURAT_GRID } = await _vite.ssrLoadModule(
    '/src/utils/suratDurusoftComposer.ts',
  )
  const derived = deriveAugmentedSuratZplWithHashes(
    zpl,
    [{ productName: 'Scuba Secil Detayli Tesettur Elbise', quantity: 2, sku: 'S1' }],
    { compose: { cargoTrackingNumber: VERIFIED_727 } },
  )
  const bitmap = (await render(derived.printZpl)).bitmap
  const footer = box(bitmap, 0, derived.metrics.footerTop, 799,
    799 - derived.metrics.footerTop)
  assert.ok(footer, 'footer basılmalı')
  // Footer dikey rayın ALTINDA olduğu için içerik rayının SOLUNU kullanabilir;
  // yine de etiket kenarından güvenli mesafede kalır.
  assert.ok(footer.x >= 8, `footer sol kenar payı: ${footer.x}`)
  assert.ok(footer.x <= SURAT_GRID.contentLeft, 'footer en geniş satırı kullanır')
  assert.ok(right(footer) <= SURAT_GRID.labelEdge - 8, 'footer sağ taşma yok')
  assert.ok(bottom(footer) <= 798, 'footer alt taşma yok')
})

// ═══ VISUAL-* : ÖLÇÜLEN PARITY DEĞERLERİNİN KİLİTLENMESİ ═════════════════
//
// DuruSoft referansıyla karşılaştırmalı ölçüm, dört alanın ZATEN kabul
// edilebilir olduğunu gösterdi; bu yüzden KOORDİNAT DEĞİŞTİRİLMEDİ.
// Aşağıdaki testler o değerleri TOLERANSLI biçimde kilitler: amaç snapshot
// değil, kuralın korunması. Değerler mümkün olduğunca SURAT_GRID ve composer
// teşhis çıktısından TÜRETİLİR, elle yazılmaz.

const TRANSFER_RE = /\^FT220,705\^A0N,70,50\^FH.\^FD[^^]*\^FS/
const withTransferCenter = (value) =>
  zpl.replace(
    TRANSFER_RE,
    `^FT220,705^A0N,70,50^FH${String.fromCharCode(92)}^FD${value}^FS`,
  )

async function composedBitmap(source, items) {
  const derived = deriveAugmentedSuratZplWithHashes(
    source,
    items ?? [{ productName: 'Ornek Urun', quantity: 1, sku: 'S1' }],
    { compose: { cargoTrackingNumber: VERIFIED_727 } },
  )
  assert.equal(derived.renderContract, 'durusoft_composed')
  const composed = composeSuratDurusoftLabel(source, {
    cargoTrackingNumber: VERIFIED_727,
  })
  return {
    bitmap: (await render(derived.printZpl)).bitmap,
    diagnostics: composed.diagnostics,
    metrics: derived.metrics,
  }
}

test('VISUAL-BARCODE: küçük metin subset-C merkezine oturur, boşluklar güvenli', async () => {
  const { bitmap, diagnostics } = await composedBitmap(zpl)
  const body = box(bitmap, 46, 157, 750, 144)
  const text = box(bitmap, 46, 302, 750, 34)
  assert.ok(body && text)

  // Merkez, GERÇEK YAZICI (subset C) genişliğinden TÜRETİLİR — renderer'ın
  // subset-B genişliğinden değil. Teorik merkez = barkod sol + genişlik/2.
  const theoreticalCentre = body.x + diagnostics.barcodeWidth / 2
  const renderedCentre = text.x + text.width / 2
  assert.ok(
    Math.abs(renderedCentre - theoreticalCentre) <= 2,
    `metin merkezi ±2 dot: ${renderedCentre} / ${theoreticalCentre}`,
  )
  // Dahili yorum satırından belirgin küçük ve barkod bandı içinde.
  assert.ok(text.height <= 20, `metin yüksekliği: ${text.height}`)
  assert.ok(text.x >= body.x && right(text) <= right(body))
  // Boşluklar: barkod tabanı → metin, metin → alıcı kutusu üst çizgisi.
  assert.ok(text.y - bottom(body) >= 4, 'barkod-metin boşluğu')
  assert.ok(336 - bottom(text) >= 8, 'metin-alıcı kutusu boşluğu')
})

test('VISUAL-ADDRESS: bold blok normal adresle aynı çapada ve kutu içinde', async () => {
  const { bitmap } = await composedBitmap(zpl)
  const normal1 = box(bitmap, 66, 357, 700, 21)
  const normal2 = box(bitmap, 66, 378, 700, 21)
  const bold1 = box(bitmap, 66, 401, 700, 16)
  const bold2 = box(bitmap, 66, 417, 700, 16)
  const phone = box(bitmap, 100, 452, 300, 22)
  assert.ok(normal1 && normal2 && bold1 && bold2 && phone)

  // AYNI SOL ÇAPA — bold, kaynak satırın bayt kopyası olduğu için birebir.
  assert.equal(bold1.x, normal1.x, 'bold 1 sol çapa')
  assert.equal(bold2.x, normal2.x, 'bold 2 sol çapa')
  // Çift vuruş yalnız +1 dot genişletir.
  assert.ok(Math.abs(bold1.width - normal1.width) <= 2)
  assert.ok(Math.abs(bold2.width - normal2.width) <= 2)
  // Doğal devam: normal bloğun hemen altında, aşırı boşluk yok.
  const gap = bold1.y - bottom(normal2)
  assert.ok(gap > 0 && gap <= 16, `normal-bold boşluğu: ${gap}`)
  // TEL satırına ve kutu tabanına taşmaz.
  assert.ok(bottom(bold2) < phone.y, 'bold blok TEL satırına taşmaz')
  assert.ok(bottom(bold2) < 476, 'bold blok kutu tabanını aşmaz')
})

test('VISUAL-BOTTOM: DataMatrix / routing / QR dış marj dengesi', async () => {
  const { bitmap, diagnostics } = await composedBitmap(zpl)
  const dataMatrix = box(bitmap, 40, 490, 130, 220)
  const routing = box(bitmap, 170, 560, 420, 150)
  const qr = box(
    bitmap,
    diagnostics.qrBox.x - 25,
    diagnostics.qrBox.y - 25,
    diagnostics.qrBox.size + 60,
    diagnostics.qrBox.size + 60,
  )
  assert.ok(dataMatrix && routing && qr)

  const leftMargin = dataMatrix.x
  const rightMargin = 799 - right(qr)
  assert.ok(
    Math.abs(leftMargin - rightMargin) <= 5,
    `dış marj simetrisi: sol ${leftMargin} / sağ ${rightMargin}`,
  )
  // ÜÇ KOLON gerçekten ayrık.
  assert.ok(routing.x > right(dataMatrix), 'orta blok DataMatrix sağında')
  assert.ok(right(routing) < qr.x, 'orta blok QR solunda')
  assert.ok(!overlaps(dataMatrix, qr))
  assert.ok(!overlaps(routing, qr))
  assert.ok(!overlaps(dataMatrix, routing))
})

test('VISUAL-FOOTER: footer ortak sol rayda, taşma ve kırpma yok', async () => {
  const { SURAT_GRID } = await _vite.ssrLoadModule(
    '/src/utils/suratDurusoftComposer.ts',
  )
  const { bitmap, metrics } = await composedBitmap(zpl, [
    {
      productName: 'Scuba Secil Detayli Tesettur Lacivert Elbise',
      quantity: 1,
      color: 'Lacivert',
      size: '40',
      sku: 'SCUBA-SEC01',
    },
  ])
  const footer = box(bitmap, 0, metrics.footerTop, 799, 799 - metrics.footerTop)
  assert.ok(footer)
  // Dikey rayın ALTINDA olduğu için içerik rayının solunu kullanabilir.
  assert.ok(footer.x <= 20, `footer sol: ${footer.x}`)
  assert.ok(footer.x >= 8, 'etiket kenarından güvenli mesafe')
  assert.ok(footer.x <= SURAT_GRID.contentLeft)
  assert.ok(right(footer) <= SURAT_GRID.labelEdge - 8, 'sağ taşma yok')
  assert.ok(bottom(footer) <= 798, 'alt taşma yok')
  // Alt bölümle güvenli boşluk.
  assert.ok(metrics.footerTop > metrics.contentBottom, 'footer içeriğin altında')
  assert.ok(metrics.footerTop - metrics.contentBottom >= 4, 'güvenli boşluk')
})

test('VISUAL-TOP: üst blok ortak raylarda', async () => {
  const { SURAT_GRID } = await _vite.ssrLoadModule(
    '/src/utils/suratDurusoftComposer.ts',
  )
  const { bitmap } = await composedBitmap(zpl)
  const sube = box(bitmap, 46, 56, 300, 30)
  const tNo = box(bitmap, 440, 56, 340, 30)
  assert.ok(sube && tNo)
  // Şube sol içerik rayında başlar, T.No üst kutunun sağ rayında biter.
  assert.ok(
    Math.abs(sube.x - SURAT_GRID.contentLeft) <= 3,
    `Şube sol ray: ${sube.x}`,
  )
  assert.ok(right(tNo) <= SURAT_GRID.contentRight, 'T.No sağ rayı aşmaz')
  assert.ok(right(tNo) >= 750, `T.No sağa yaslı: ${right(tNo)}`)
  // AYNI BASELINE AİLESİ — üst kenarlar birkaç dot içinde.
  assert.ok(Math.abs(sube.y - tNo.y) <= 3, 'ortak üst baseline')
  assert.ok(!overlaps(sube, tNo), 'Şube ve T.No çakışmaz')
})

test('VISUAL-QR-POLICY: ölçek sınıf bazında deterministik', async () => {
  // POLİTİKA: common sınıflar mag5 (fiziksel olarak doğrulanmış), geometri
  // kısıtlı sınıflar mag4, gerçekten sığmayan ad fallback.
  // Sırf görsel parity için mag5 mag4'e ÇEKİLMEZ (readability > parity).
  const expected = [
    ['GEBZE AKTARMA', 5],
    ['IKITELLI AKTARMA', 5],
    ['ERZURUM AKTARMA', 4],
    ['DIYARBAKIR AKTARMA', 4],
    ['ISTANBUL ANADOLU AKTARMA MERKEZI', null],
  ]
  for (const [name, magnification] of expected) {
    const result = composeSuratDurusoftLabel(withTransferCenter(name), {
      cargoTrackingNumber: VERIFIED_727,
    })
    if (magnification === null) {
      assert.equal(result.composed, false, name)
      assert.equal(result.mode, 'fallback_geometry_failure', name)
      continue
    }
    assert.equal(result.composed, true, `${name}: ${result.reason ?? ''}`)
    assert.equal(result.diagnostics.qrMagnification, magnification, name)
  }
})
