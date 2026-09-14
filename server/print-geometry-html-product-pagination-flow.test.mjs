// PRINT-GEOMETRY-003 — HTML ÜRÜN TAŞMASI: KAPASİTE GERİ KAZANILDI, QR SABİT.
//
// ═══ ÖLÇÜLEN TABAN (9ddee46) ═════════════════════════════════════════════
//
// PRINT-GEOMETRY-001 QR'ı içerikten kurtardı; bedeli bu turda YENİDEN ölçüldü:
//
//   kalem   1    2    3    4+
//   sonuç   OK   OK   OK   "Ürün bilgileri tek etikete sığmıyor."
//
// Sınır İÇERİKTEN BAĞIMSIZ olarak 3'tü: kısa ad, uzun ad, varyantsız,
// SKU'suz, adet 12 ve Türkçe karakterli içeriklerin HEPSİNDE aynı. Yani
// 4+ kalemli GEÇERLİ siparişler YALNIZ opsiyonel ürün detayı yüzünden
// basılamıyordu.
//
// ═══ KABUL EDİLMEYEN İKİ ÇÖZÜM ═══════════════════════════════════════════
//
//   A) QR'ı yeniden küçültmek — çakışma önceliğinin TERSİ.
//   B) Siparişi engellemek — sevkiyat etiketi zaten üretilebilir durumda.
//
// ═══ UYGULANAN ÇÖZÜM ═════════════════════════════════════════════════════
//
// SAYFA 1 sevkiyat etiketi olarak KALIR; sığmayan ürün satırları DEVAM
// SAYFALARINA taşar. Karar TARAYICIDAN ÖNCE, saf hesapla verilir (DOM ölçümü
// YOK), bu yüzden aynı girdi her zaman aynı sayfalamayı üretir.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

let _vite
let planLabelProductPages
let renderPrintableLabelPages
let buildCleanLabelDocument
let LABEL_TEMPLATE_GEOMETRY

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ planLabelProductPages } = await _vite.ssrLoadModule(
    '/src/utils/labelLayoutResolver.ts',
  ))
  ;({ renderPrintableLabelPages, buildCleanLabelDocument } =
    await _vite.ssrLoadModule('/src/utils/browserLabelPrint.ts'))
  ;({ LABEL_TEMPLATE_GEOMETRY } = await _vite.ssrLoadModule(
    '/src/utils/labelTemplateGeometry.ts',
  ))
})
after(async () => {
  if (_vite) await _vite.close()
})

const TEMPLATE = {
  id: 't',
  widthMm: 100,
  heightMm: 100,
  widthDots: 799,
  heightDots: 799,
  fields: [],
}

const RECIPIENT = 'YAGMUR SENTETIK'
const ADDRESS_TOKEN = 'SENTETIK CADDESI'
const PHONE = '5410000000'

const items = (n, options = {}) =>
  Array.from({ length: n }, (_, index) => ({
    id: `l-${index}`,
    quantity: options.quantity ?? 1,
    productName: `${options.name ?? 'Urun'} ${index + 1}`,
    color: 'Lacivert',
    size: '40',
    sku: `SKU-${index + 1}`,
    merchantSku: `SKU-${index + 1}`,
  }))

const labelData = (n, options = {}) => ({
  orderNumber: options.orderNumber ?? 'ORD-1',
  recipientName: RECIPIENT,
  address: `YENI MAH ${ADDRESS_TOKEN} NO 113/B`,
  fullAddressLines: [`YENI MAH ${ADDRESS_TOKEN}`, 'NO 113/B'],
  recipientPhone: PHONE,
  city: 'ISTANBUL',
  district: 'KADIKOY',
  routeCenter: 'ISTANBUL / KADIKOY',
  transferCenter: options.transfer ?? 'GEBZE AKTARMA',
  barcodeValue: '01249704068000',
  tNo: '63074185296307',
  trackingNumber: '7270034422363739',
  qrPayload: '7270034422363739',
  shipmentReference: '7270034422363739',
  leftVerticalReference: '7270034422363739',
  desi: 2,
  senderName: 'GONDERICI',
  items: items(n, options),
})

const order = (id, lines, extra = {}) => ({
  id: `o-${id}`,
  orderNumber: `114678700${id}`,
  packageId: `PKG-${id}`,
  operationStatus: 'LABEL_READY',
  labelStatus: 'READY',
  customerName: RECIPIENT,
  customerPhone: PHONE,
  city: 'ISTANBUL',
  district: 'KADIKOY',
  address: `YENI MAH ${ADDRESS_TOKEN} NO 113/B`,
  desi: 2,
  items: lines,
  ...extra,
  shipment: {
    provider: 'surat-kargo',
    trackingNumber: '25220148446193',
    tNo: '25220148446193',
    kargoTakipNo: '25220148446193',
    barcode: '01231201025',
    barkodNo: '01231201025',
    barcodeValue: '01231201025',
    ozelKargoTakipNo: '7270034422363739',
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    zplReady: true,
    printEnabled: true,
    barcodeRaw: '^XA^FD01231201025^FS^XZ',
  },
})

/** Sayfa 1'in QR kenarı — stil değişkeninden okunur. */
const largeQrOf = (pageHtml) =>
  (pageHtml.match(/--layout-large-qr:([\d.]+)mm/) || [])[1] ?? null
const smallQrOf = (pageHtml) =>
  (pageHtml.match(/--layout-small-qr:([\d.]+)mm/) || [])[1] ?? null

const continuationCount = (pages) =>
  pages.filter((page) => page.includes('label-page-continuation')).length

/** Bir ürün adının TÜM sayfalarda kaç kez göründüğü. */
function productOccurrences(pages, line) {
  const needle = `>${line.quantity || 1} x ${line.productName}<`
  return pages.join('').split(needle).length - 1
}

// ═══ PG3-1 / PG3-2 / PG3-3 — KAPASİTE ═══════════════════════════════════

test('PG3-1: 1 urun TEK sayfa', () => {
  const pages = renderPrintableLabelPages(labelData(1))
  assert.equal(pages.length, 1)
  assert.equal(continuationCount(pages), 0)
})

test('PG3-2: 3 urun TEK sayfa (mevcut guvenli kapasite KORUNUR)', () => {
  const pages = renderPrintableLabelPages(labelData(3))
  assert.equal(pages.length, 1, '3 kalem hala tek sayfaya sigar')
  assert.equal(continuationCount(pages), 0)
  // TABAN DAVRANIS BIREBIR: plancinin sayfa-1 profili, 3 kalemde eskiden
  // secilen profille AYNI olmalidir.
  const plan = planLabelProductPages({
    items: labelData(3).items,
    destination: 'ISTANBUL / KADIKOY',
    transfer: 'GEBZE AKTARMA',
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.totalPages, 1)
  assert.equal(plan.pages[0].items.length, 3)
})

test('PG3-3: 4-5 urun YALNIZ QR sabit diye BASARISIZ OLMAZ', () => {
  for (const count of [4, 5]) {
    const pages = renderPrintableLabelPages(labelData(count))
    assert.ok(pages.length >= 2, `${count} kalem icin sayfa uretilmeli`)
    // ESKIDEN: "Ürün bilgileri tek etikete sığmıyor." ile HATA firlatiliyordu.
    assert.equal(continuationCount(pages), pages.length - 1)
  }
})

// ═══ PG3-4 / PG3-5 / PG3-6 / PG3-17 — TAŞMA VE BÜTÜNLÜK ═════════════════

test('PG3-4: tasma DEVAM SAYFASI olusturur', () => {
  const pages = renderPrintableLabelPages(labelData(10))
  assert.ok(pages.length >= 2)
  assert.equal(continuationCount(pages), pages.length - 1)
  // Sayfa 1 SEVKIYAT sayfasidir; devam sayfasi DEGILDIR.
  assert.equal(pages[0].includes('label-page-continuation'), false)
  assert.match(pages[1], /data-page-kind="product_continuation"/)
})

test('PG3-5: 10 urun — her satir TAM BIR KEZ basilir', () => {
  const data = labelData(10)
  const pages = renderPrintableLabelPages(data)
  for (const line of data.items) {
    assert.equal(
      productOccurrences(pages, line),
      1,
      `"${line.productName}" tam bir kez gorunmeli`,
    )
  }
})

test('PG3-6: 20 urun — DETERMINISTIK N sayfa', () => {
  const data = labelData(20)
  const first = renderPrintableLabelPages(data)
  const second = renderPrintableLabelPages(labelData(20))
  assert.deepEqual(second, first, 'ayni girdi ayni belgeyi uretmeli')
  assert.ok(first.length >= 2)
  for (const line of data.items) {
    assert.equal(productOccurrences(first, line), 1, line.productName)
  }
})

test('PG3-17: sayfa sinirinda TEKRAR veya KAYIP satir YOK', () => {
  // Sinir davranisi yalniz bir sayida degil, GENIS bir aralikta sinanir:
  // kapasitenin hemen altinda/ustunde ve cok sayfali durumlarda.
  for (const count of [3, 4, 5, 6, 9, 10, 11, 20, 25, 40]) {
    const data = labelData(count)
    const pages = renderPrintableLabelPages(data)
    for (const line of data.items) {
      assert.equal(
        productOccurrences(pages, line),
        1,
        `n=${count} "${line.productName}"`,
      )
    }
    // SIRA KORUNUR: plan, order.items sirasini degistirmez.
    const plan = planLabelProductPages({
      items: data.items,
      destination: 'ISTANBUL / KADIKOY',
      transfer: 'GEBZE AKTARMA',
    })
    const flat = plan.pages.flatMap((page) =>
      page.items.map((item) => item.productName),
    )
    assert.deepEqual(
      flat,
      data.items.map((item) => item.productName),
      `n=${count} urun SIRASI bozuldu`,
    )
    // SIFIR SATIRLI DEVAM SAYFASI URETILMEZ (sonsuz sayfalama muhafizi).
    for (const page of plan.pages.slice(1)) {
      assert.ok(page.items.length > 0, `n=${count} bos devam sayfasi`)
    }
  }
})

// ═══ PG3-7 / PG3-8 — QR DEĞİŞMEZLİĞİ ════════════════════════════════════

test('PG3-7: 1 / 3 / 5 / 10 urun — SAYFA 1 QR olculeri AYNI', () => {
  const measured = [1, 3, 5, 10].map((count) => {
    const page = renderPrintableLabelPages(labelData(count))[0]
    return { count, large: largeQrOf(page), small: smallQrOf(page) }
  })
  const geometry = LABEL_TEMPLATE_GEOMETRY.cargoflow_html
  for (const entry of measured) {
    assert.equal(
      entry.large,
      String(geometry.largeQr.sideMm),
      `n=${entry.count} buyuk QR`,
    )
    assert.equal(
      entry.small,
      String(geometry.smallQr.sideMm),
      `n=${entry.count} kucuk QR`,
    )
  }
  assert.equal(new Set(measured.map((entry) => entry.large)).size, 1)
  assert.equal(new Set(measured.map((entry) => entry.small)).size, 1)
})

test('PG3-8: UZUN urun adi QR olcusunu DEGISTIRMEZ', () => {
  const short = renderPrintableLabelPages(labelData(3, { name: 'Tisort' }))[0]
  const long = renderPrintableLabelPages(
    labelData(3, {
      name: 'Scuba Secil Detayli Tesettur Abiye Elbise Lacivert Uzun Kollu Ozel Seri',
    }),
  )[0]
  assert.equal(largeQrOf(long), largeQrOf(short))
  assert.equal(smallQrOf(long), smallQrOf(short))
})

// ═══ PG3-9 — PG2B REGRESYONU ════════════════════════════════════════════

test('PG3-9: sarili/uzun aktarma + tasma — QR degismez, sayfalama calisir', () => {
  const reference = renderPrintableLabelPages(labelData(10))[0]
  for (const transfer of [
    'IZMIR',
    'BALIKESIR AKTARMA',
    'DIKILI/CAN BALIKESIR AKTARMA',
    'KAHRAMANMARAS ELBISTAN AKTARMA MERKEZI',
  ]) {
    const pages = renderPrintableLabelPages(labelData(10, { transfer }))
    assert.ok(pages.length >= 2, `${transfer}: tasma calismali`)
    assert.equal(largeQrOf(pages[0]), largeQrOf(reference), `${transfer} QR`)
    // Aktarma metni SAYFA 1'de AYNEN yer alir (kayip yok).
    assert.ok(pages[0].includes(transfer), `${transfer} metni sayfada`)
  }
})

// ═══ PG3-10 / PG3-11 — DEVAM SAYFASI İÇERİĞİ ════════════════════════════

test('PG3-10: devam sayfasi siparis/paket KIMLIGI ve sayfa gostergesi tasir', () => {
  const pages = renderPrintableLabelPages(labelData(10))
  const continuation = pages[1]
  assert.match(continuation, /Ürün Detayı/)
  assert.ok(continuation.includes('ORD-1'), 'siparis numarasi')
  assert.ok(continuation.includes('63074185296307'), 'T.No kimligi')
  assert.match(continuation, /Sayfa 2 \/ \d+/, 'devam gostergesi')
})

test('PG3-11: devam sayfasinda GEREKSIZ alici PII ve ikinci barkod/QR YOK', () => {
  const pages = renderPrintableLabelPages(labelData(10))
  const continuation = pages.slice(1).join('')
  for (const pii of [RECIPIENT, ADDRESS_TOKEN, PHONE]) {
    assert.equal(
      continuation.includes(pii),
      false,
      `devam sayfasinda PII: ${pii}`,
    )
  }
  // SEVKIYAT ARTEFAKTI SAYFA 1'DIR: barkod/QR devam sayfasinda TEKRARLANMAZ.
  assert.equal((continuation.match(/<svg/g) ?? []).length, 0, 'ikinci kod yok')
  assert.ok((pages[0].match(/<svg/g) ?? []).length > 0, 'sayfa 1 kod tasir')
})

// ═══ PG3-12 / PG3-13 / PG3-14 — BASKI SIRASI VE MANTIKSAL SAYIM ═════════

test('PG3-12: tek siparis baskisi sayfalari SIRAYLA cikarir', () => {
  const pages = renderPrintableLabelPages(labelData(20))
  assert.equal(pages[0].includes('label-page-continuation'), false, 'ilk sayfa sevkiyat')
  for (let index = 1; index < pages.length; index += 1) {
    assert.match(pages[index], /data-page-kind="product_continuation"/)
    assert.ok(
      pages[index].includes(`Sayfa ${index + 1} / ${pages.length}`),
      `sayfa ${index + 1} gostergesi hatali`,
    )
  }
})

test('PG3-13: TOPLU baskida sira A1,A2,...,B1,B2,... (sayfa numarasina gore DEGIL)', () => {
  const doc = buildCleanLabelDocument(
    [order('1', items(10)), order('2', items(1)), order('3', items(5))],
    TEMPLATE,
  )
  // Belgedeki sayfa siniri isaretlerini SIRAYLA topla.
  const sequence = [...doc.html.matchAll(/class="label-page( label-page-continuation)?"/g)]
    .map((match) => (match[1] ? 'C' : 'S'))
    .join('')
  // A: sevkiyat + devam, B: yalniz sevkiyat, C: sevkiyat + devam
  assert.match(sequence, /^SC+SSC+$/, `beklenmeyen sayfa sirasi: ${sequence}`)
  // "Once tum sevkiyatlar, sonra tum ekler" gruplamasi OLMAMALI.
  assert.equal(/^S+C+$/.test(sequence), false, 'sayfalar turune gore GRUPLANMIS')
})

test('PG3-14 / PG3-15: cok sayfali siparis TEK mantiksal baski sayilir', () => {
  const doc = buildCleanLabelDocument([order('1', items(10))], TEMPLATE)
  assert.equal(doc.printable.length, 1, 'fiziksel sayfa sayisi MANTIKSAL sayim DEGIL')
  assert.equal(doc.skipped.length, 0)
  const pageCount = (doc.html.match(/class="label-page/g) ?? []).length
  assert.ok(pageCount > 1, 'fiziksel olarak cok sayfa')

  // SECIM/BASILDI ANLAMBILIMI DEGISMEDI: sayfalama, baski niyeti ve
  // "onceden basilmislari dahil et" kurallarina DOKUNMAZ.
  const intent = readFileSync(
    join(here, '..', 'src', 'utils', 'printSelectionIntent.ts'),
    'utf8',
  )
  for (const leak of [
    'planLabelProductPages',
    'renderPrintableLabelPages',
    'label-page-continuation',
    'totalPages',
  ]) {
    assert.equal(intent.includes(leak), false, `secim anlambilimine sizdi: ${leak}`)
  }
})

// ═══ PG3-16 — 0 ÜRÜN ════════════════════════════════════════════════════

test('PG3-16: 0 urun YALNIZ sevkiyat sayfasi uretir (bos devam sayfasi YOK)', () => {
  const pages = renderPrintableLabelPages(labelData(0))
  assert.equal(pages.length, 1)
  assert.equal(continuationCount(pages), 0)
})

// ═══ PG3-18 / PG3-19 — SAĞLAYICI İZOLASYONU ═════════════════════════════

test('PG3-18: Surat ZPL composer ve kayitli printZpl ETKILENMEZ', () => {
  const composer = readFileSync(
    join(here, '..', 'src', 'utils', 'suratLabelComposer.ts'),
    'utf8',
  )
  for (const leak of [
    'planLabelProductPages',
    'renderPrintableLabelPages',
    'label-page-continuation',
    'labelLayoutResolver',
  ]) {
    assert.equal(composer.includes(leak), false, `ZPL composer'a sizdi: ${leak}`)
  }
  const repository = readFileSync(
    join(here, 'shipments', 'printZplRepository.ts'),
    'utf8',
  )
  assert.equal(repository.includes('planLabelProductPages'), false)
  // Toplu yeniden yazma yolu YOK.
  assert.equal(
    /for\s*\([^)]*\)\s*\{[^}]*update\([^)]*printZpl/m.test(repository),
    false,
  )
})

test('PG3-19: saglayiciya ait sablonlar DEGISMEDI', async () => {
  const geometry = LABEL_TEMPLATE_GEOMETRY
  for (const key of [
    'trendyol_common_label',
    'hepsiburada_mutual_barcode',
    'aras_native',
  ]) {
    assert.equal(geometry[key].mayMutateGeometry, false, key)
    assert.equal(geometry[key].productFooterEligible, false, `${key} footer`)
  }
  // Sayfalama YALNIZ cargoflow_html icin gecerlidir.
  assert.equal(geometry.cargoflow_html.productFooterEligible, true)
})

// ═══ PG3-20 — FİZİKSEL SAYFA GEOMETRİSİ ═════════════════════════════════

test('PG3-20: sayfa olcusu SABLONDAN gelir, A4/Letter varsayimindan DEGIL', () => {
  const doc = buildCleanLabelDocument([order('1', items(10))], TEMPLATE)
  const geometry = LABEL_TEMPLATE_GEOMETRY.cargoflow_html
  // @page ACIKCA ilan edilir ve sablon olcusune esittir.
  assert.match(
    doc.html,
    new RegExp(`@page \\{ size: ${geometry.pageWidthMm}mm ${geometry.pageHeightMm}mm; margin: 0; \\}`),
  )
  // ADLANDIRILMIS SAYFA BOYU KULLANILMAZ.
  //
  // DIKKAT — DAR ARAMA: ilk yazimda "letter" kelimesi TUM belgede araniyordu
  // ve test `letter-spacing` CSS ozelligine takilip DUSUYORDU. Aranan sey
  // kelimenin kendisi degil, SAYFA BOYU ILANIDIR.
  assert.equal(
    /@page[^}]*size:\s*(A4|A5|letter|legal)/i.test(doc.html),
    false,
    'adlandirilmis (A4/Letter) sayfa boyu ilani',
  )
  // Belgede TEK bir @page ilani vardir ve o da sablon olcusunu tasir.
  assert.equal((doc.html.match(/@page/g) ?? []).length, 1, 'tek @page ilani')
  // Devam sayfasi da AYNI fiziksel kutuyu kullanir: kendi olcu ilani YOKTUR.
  const printer = readFileSync(
    join(here, '..', 'src', 'utils', 'browserLabelPrint.ts'),
    'utf8',
  )
  const continuationRule = printer.slice(
    printer.indexOf('.label-page-continuation'),
    printer.indexOf('.surat-continuation-header'),
  )
  assert.equal(/width:\s*\d/.test(continuationRule), false, 'devam sayfasi kendi genisligini ilan etmis')
  assert.equal(/height:\s*\d/.test(continuationRule), false, 'devam sayfasi kendi yuksekligini ilan etmis')
  // Varsayilan olcu kaynagi sablon KAYDIDIR.
  assert.match(printer, /htmlGeometry\.pageWidthMm/)
  assert.match(printer, /htmlGeometry\.pageHeightMm/)
})
