import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import { decodePngToBitmap } from './labels/pngLandmarks.mjs'

// ═══ ETİKETTE SİPARİŞ TARİH-SAATİ ═══════════════════════════════════════
//
// ═══ HANGİ ZAMAN ═════════════════════════════════════════════════════════
// PAZARYERİNDE SİPARİŞİN OLUŞTUĞU an. Baskı anı DEĞİL, CargoFlow'un paketi
// ilk gördüğü an (`first_seen_at`) DEĞİL, tarayıcının yazdırma üstbilgisi
// HİÇ DEĞİL.
//
// Kanonik zincir:
//   `item.orderDate` (Trendyol, epoch ms)
//     → `toIsoDate` → UTC an (`...Z`, offset-aware)
//     → `orders.order_date timestamp WITH TIME ZONE`
//     → payload `orderDate` → composer → etiket
//
// ═══ YERLEŞİM TAHMİN DEĞİL, ÖLÇÜM ════════════════════════════════════════
// Gerçek taşıyıcı fixture'ının 799 × 799 render'ında satır bazında mürekkep
// sayıldı. TAMAMEN boş yatay bantlar:
//
//   y   0.. 56   57 dot   ← ÜST BANT (seçilen)
//   y 300..305    6 dot   (metin için ince)
//   y 321..335   15 dot   (metin için ince)
//   y 706..798   93 dot   ← ürün footer'ı buraya ekleniyor; DOLU
//
// ═══ HİÇBİR İDDİA DİZGİYE DAYANMAZ ═══════════════════════════════════════
// Çakışma ve regresyon kanıtı, tarihli ve tarihsiz iki gerçek render'ın
// PİKSEL FARKINDAN gelir.

const here = dirname(fileURLToPath(import.meta.url))
const V2_ZPL = readFileSync(
  join(here, 'fixtures', 'surat-real-v2-numeric.zpl'),
  'utf8',
)

/** Sipariş anı: 2026-09-12 18:28 UTC → Europe/Istanbul 21:28 (+03). */
const ORDER_INSTANT = '2026-09-12T18:28:00.000Z'
const EXPECTED_TEXT = '12.09.2026 21:28'

/** Ölçülen üst bandın alt sınırı — ilk taşıyıcı mürekkebi y = 57. */
const TOP_BAND_BOTTOM = 56

let _vite
let renderZplToPng
let composeSuratLabel
let formatLabelOrderDateTime

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
  ;({ formatLabelOrderDateTime } = await _vite.ssrLoadModule(
    '/src/utils/labelOrderDateTime.ts',
  ))
})
after(async () => {
  if (_vite) await _vite.close()
})

async function bitmap(zpl) {
  const result = await renderZplToPng({ zpl })
  return decodePngToBitmap(Buffer.from(result.pngBase64, 'base64'))
}

/** Tarihli ve tarihsiz render'ın piksel farkı. */
async function inkDelta() {
  const without = composeSuratLabel(V2_ZPL, {})
  const withDate = composeSuratLabel(V2_ZPL, { orderDate: ORDER_INSTANT })
  const a = await bitmap(without.zpl)
  const b = await bitmap(withDate.zpl)
  assert.equal(a.width, b.width)
  assert.equal(a.height, b.height)
  const added = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, count: 0 }
  let removed = 0
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const before = a.dark[y][x] === 1
      const now = b.dark[y][x] === 1
      if (now && !before) {
        added.count += 1
        added.x0 = Math.min(added.x0, x)
        added.y0 = Math.min(added.y0, y)
        added.x1 = Math.max(added.x1, x)
        added.y1 = Math.max(added.y1, y)
      }
      if (before && !now) removed += 1
    }
  }
  return { without, withDate, added, removed, width: a.width, height: a.height }
}

/* ═══ DATESTAMP-1 ═══════════════════════════════════════════════════════ */

test('DATESTAMP-1: etikette tarih-saat alani GERCEKTEN render edilir', async () => {
  const { withDate, added } = await inkDelta()
  // ZPL sözleşmesi: alan var ve metin BEKLENEN biçimde.
  assert.match(withDate.zpl, /\^FO\d+,\d+\^A0N,\d+,\d+\^FD12\.09\.2026 21:28\^FS/)
  // Ve GERÇEKTEN mürekkep üretiyor — dizgi kanıt sayılmaz.
  assert.ok(added.count > 400, `eklenen murekkep yetersiz: ${added.count}`)
})

/* ═══ DATESTAMP-2 ═══════════════════════════════════════════════════════ */

test('DATESTAMP-2: tarih KANONIK kaynaktan gelir; baski/senkron ani DEGIL', async () => {
  // 1) Biçim ve TEK zaman dilimi dönüşümü.
  assert.equal(formatLabelOrderDateTime(ORDER_INSTANT), EXPECTED_TEXT)
  // Epoch ms (Trendyol'un ham biçimi) AYNI sonucu verir.
  assert.equal(
    formatLabelOrderDateTime(Date.parse(ORDER_INSTANT)),
    EXPECTED_TEXT,
  )
  // `Date` örneği de aynı.
  assert.equal(
    formatLabelOrderDateTime(new Date(ORDER_INSTANT)),
    EXPECTED_TEXT,
  )
  // 2) ÇİFT DÖNÜŞÜM YOK: zaten +03 taşıyan bir dizgi kaydırılmaz.
  assert.equal(formatLabelOrderDateTime('2026-09-12T21:28:00+03:00'), EXPECTED_TEXT)
  // 3) NAIVE (ofsetsiz) değer UYDURULMAZ — alan çizilmez.
  assert.equal(formatLabelOrderDateTime('2026-09-12 21:28'), '')
  assert.equal(formatLabelOrderDateTime('2026-09-12T21:28:00'), '')
  assert.equal(formatLabelOrderDateTime(''), '')
  assert.equal(formatLabelOrderDateTime(null), '')
  // 4) Kaynak yoksa etikete HİÇBİR tarih yazılmaz (baskı anı KULLANILMAZ).
  const withoutSource = composeSuratLabel(V2_ZPL, {})
  assert.doesNotMatch(withoutSource.zpl, /\^FD\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\^FS/)

  // 5) YAPISAL: kalıcılık katmanı `orders.order_date` okur; senkron alanları
  //    (`first_seen_at` / `last_seen_at`) veya `new Date()` KULLANMAZ.
  const persistence = readFileSync(
    join(here, 'shipments', 'shipmentPersistenceService.ts'), 'utf8',
  )
  const at = persistence.indexOf('async function withCanonicalOrderDate')
  assert.ok(at > 0, 'kanonik tarih cozucusu bulunamadi')
  const body = persistence.slice(at, persistence.indexOf('\n}', at))
  assert.match(body, /findOrderByPackageId/)
  assert.match(body, /\.orderDate/)
  assert.doesNotMatch(body, /firstSeenAt|lastSeenAt|new Date\(\)/)
  // Composer girdisi de aynı alandan beslenir.
  const repository = readFileSync(
    join(here, 'shipments', 'printZplRepository.ts'), 'utf8',
  )
  assert.match(repository, /orderDate: readCandidate\(payload, 'orderDate'\)/)
})

/* ═══ DATESTAMP-3 ═══════════════════════════════════════════════════════ */

test('DATESTAMP-3: tarih alani KABUL EDILMIS hicbir bbox ile CAKISMAZ', async () => {
  const { added, removed } = await inkDelta()

  // ═══ EN GÜÇLÜ KANIT ═══════════════════════════════════════════════════
  // Kabul edilmiş bir blok kaydırılsaydı ya da üzerine yazılsaydı, ESKİ
  // render'da olup YENİ render'da olmayan piksel çıkardı. Sıfır olması,
  // barkod / barkod altı numara / QR / DataMatrix / 727-Sipariş No / adres /
  // telefon / desi / aktarma bloklarının TEK PİKSEL bile değişmediğini
  // gösterir.
  assert.equal(removed, 0, 'kabul edilmis mürekkep KALKMIS')

  // Eklenen mürekkep TAMAMEN ölçülmüş üst bandın içinde.
  assert.ok(added.y0 >= 0, `tarih etiket disina tasmis: y0=${added.y0}`)
  assert.ok(
    added.y1 <= TOP_BAND_BOTTOM,
    `tarih ust bandin ALTINA tasti: y1=${added.y1} > ${TOP_BAND_BOTTOM}`,
  )

  // İlk taşıyıcı mürekkebine boşluk — bitişik DEĞİL.
  const clearance = TOP_BAND_BOTTOM + 1 - added.y1
  assert.ok(clearance >= 8, `tasiyici icerige cok yakin: ${clearance} dot`)
})

/* ═══ DATESTAMP-4 ═══════════════════════════════════════════════════════ */

test('DATESTAMP-4: etiket boyutu ve tasma DEGISMEZ', async () => {
  const { withDate, without, added, width, height } = await inkDelta()
  // Tuval 100 × 100 mm (799 × 799 dot @ 203 dpi) AYNEN kalır.
  assert.equal(width, 799)
  assert.equal(height, 799)
  // Sayfa komutları (^PW / ^LL) DEĞİŞMEDİ.
  const pageCommands = (zpl) =>
    (zpl.match(/\^(PW|LL)\d+/g) ?? []).join(',')
  assert.equal(pageCommands(withDate.zpl), pageCommands(without.zpl))
  // Alan tuvalin İÇİNDE.
  assert.ok(added.x0 >= 0 && added.x1 < width, 'yatay tasma')
  assert.ok(added.y0 >= 0 && added.y1 < height, 'dikey tasma')
  // Fiziksel baskıda OKUNABİLİR: 2 mm'den yüksek.
  const heightMm = ((added.y1 - added.y0 + 1) / 799) * 100
  assert.ok(heightMm >= 2, `tarih cok kucuk: ${heightMm.toFixed(2)} mm`)
  assert.ok(heightMm <= 5, `tarih beklenenden buyuk: ${heightMm.toFixed(2)} mm`)
})

/* ═══ REGRESSION-PRINT-1..5 ═════════════════════════════════════════════ */

test('REGRESSION-PRINT-1..5: QR / barkod / 727 / desi / telefon DEGISMEDI', async () => {
  const without = composeSuratLabel(V2_ZPL, {})
  const withDate = composeSuratLabel(V2_ZPL, { orderDate: ORDER_INSTANT })
  const a = without.diagnostics
  const b = withDate.diagnostics

  // REGRESSION-PRINT-1 — QR: payload, kutu, büyütme, kaynak AYNI.
  assert.deepEqual(b.qrBox, a.qrBox)
  assert.equal(b.qrMagnification, a.qrMagnification)
  assert.equal(b.qrCandidateIndex, a.qrCandidateIndex)
  assert.equal(b.qrSource, a.qrSource)
  assert.equal(b.qrRejection, a.qrRejection)
  assert.equal(b.qrRenderYOffset, a.qrRenderYOffset)
  assert.deepEqual(b.carrierQr, a.carrierQr)

  // REGRESSION-PRINT-2 — barkod ve barkod altı numara ortalaması AYNI.
  assert.equal(b.code128Digits, a.code128Digits)
  assert.equal(b.barcodeModules, a.barcodeModules)
  assert.equal(b.barcodeWidth, a.barcodeWidth)
  assert.equal(b.humanTextTop, a.humanTextTop)
  assert.equal(b.humanTextBlockWidth, a.humanTextBlockWidth)

  // REGRESSION-PRINT-3 — 727 / Sipariş No dikey referansı AYNI konumda.
  assert.deepEqual(b.orderReferenceShift, a.orderReferenceShift)

  // REGRESSION-PRINT-4 — desi: "Top Ds/Kg" satırı taşıyıcının kendi
  // alanıdır; composer ona DOKUNMAZ ve kaynakta AYNEN durur.
  const desiRow = /Top Ds\/Kg/
  assert.equal(desiRow.test(withDate.zpl), desiRow.test(without.zpl))
  assert.equal(
    (withDate.zpl.match(/\^FD[^^]*2,00[^^]*\^FS/g) ?? []).length,
    (without.zpl.match(/\^FD[^^]*2,00[^^]*\^FS/g) ?? []).length,
  )

  // REGRESSION-PRINT-5 — telefon alanları AYNEN korunur.
  const phones = (zpl) => (zpl.match(/TEL:\s*\d[\d*]*/g) ?? []).join('|')
  assert.equal(phones(withDate.zpl), phones(without.zpl))

  // Aktarma metni ve bold adres de değişmedi.
  assert.equal(b.transferFontWidth, a.transferFontWidth)
  assert.equal(b.transferFontWidthNative, a.transferFontWidthNative)
  assert.equal(b.boldAddressLines, a.boldAddressLines)

  // ═══ DEĞİŞMEZLER ══════════════════════════════════════════════════════
  // Tarih bir EKLEMEDİR: taşıyıcı komutu silinmez, beklenmeyen mutasyon
  // doğmaz. İzinli mutasyon sayısı da ARTMAZ.
  assert.equal(b.diff.deletions, 0)
  assert.equal(b.diff.unexpectedMutations, 0)
  assert.equal(b.diff.deletions, a.diff.deletions)
  assert.equal(b.diff.unexpectedMutations, a.diff.unexpectedMutations)
  assert.equal(b.diff.allowedMutations, a.diff.allowedMutations)
  assert.ok(b.diff.insertions > a.diff.insertions, 'tarih EKLEME olmali')
})

/* ═══ ŞABLON GÜVENLİĞİ ══════════════════════════════════════════════════ */

test('DATESTAMP-GUARD: ust bant DOLUYSA tarih CIZILMEZ', async () => {
  // Üst banda GERÇEK içerik taşıyan bir alan koyulmuş şablon.
  const occupied = V2_ZPL.replace('^XA', '^XA^FO70,20^A0N,20,20^FDBASLIK^FS')
  const composed = composeSuratLabel(occupied, { orderDate: ORDER_INSTANT })
  assert.doesNotMatch(composed.zpl, /\^FD12\.09\.2026 21:28\^FS/)
  // Ama VERİSİ BOŞ bir alan bandı işgal SAYILMAZ (dikey "ALICI" başlığı
  // kaynakta `^FT360,49` ile BOŞ `^FD` taşır ve hiç çizilmez).
  const normal = composeSuratLabel(V2_ZPL, { orderDate: ORDER_INSTANT })
  assert.match(normal.zpl, /\^FD12\.09\.2026 21:28\^FS/)
})

/* ═══ BULK-PRINT-4-SOURCE ═══════════════════════════════════════════════ */

test('BULK-PRINT-4-SOURCE: resmi toplu baski yolu Surat CREATE ucunu cagirmaz', () => {
  // Hazır (READY) artefaktı olan siparişlerde toplu baskı, taşıyıcıya YENİ
  // gönderi açmaz: yalnız sunucudaki KAYITLI printZpl'in render'ını ister.
  const runner = readFileSync(
    join(here, '..', 'src', 'services', 'officialSuratPrintRunner.ts'), 'utf8',
  )
  assert.match(runner, /fetchSuratRenderArtifact/)
  assert.doesNotMatch(runner, /createSuratShipment/)
  // Create ucuna giden bir yol YOK (render ucu hariç).
  assert.doesNotMatch(runner, /\/api\/shipments\/surat(?!\/render)/)

  // Render istemcisi de yalnız render ucunu bilir.
  const client = readFileSync(
    join(here, '..', 'src', 'services', 'suratLabelRenderClient.ts'), 'utf8',
  )
  assert.match(client, /\/api\/labels\/render\/surat/)
  assert.doesNotMatch(client, /createSuratShipment/)
})

/* ═══ KAYIT ═════════════════════════════════════════════════════════════ */

test('DATESTAMP-REG: bu dosya test:surat icinde KAYITLI', () => {
  const registry = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const files = Array.isArray(registry) ? registry : registry.files
  assert.ok(files.includes('server/label-datestamp-geometry-flow.test.mjs'))
})
