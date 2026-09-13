import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import { decodePngToBitmap } from './labels/pngLandmarks.mjs'

// ═══ CANLI ETİKET ALT BÖLÜM TUTARSIZLIĞI ═════════════════════════════════
//
// İki gerçek etikette alt bölüm ayrıştı:
//   CASE A — sağ QR çok küçük · ürün metni büyük · 2 satır · alta yakın
//   CASE B — sağ QR normal    · tek satır      · yazı gereksiz küçük
//
// ═══ KÖK NEDEN — İKİ SEMPTOM, TEK MEKANİZMA ══════════════════════════════
//
// `suratZplGeometry` ve `suratLabelComposer` AYNI `^BQ` komutu için AYRI
// modeller kullanıyordu:
//
//   composer : kutu YUKARI büyür, taban çizgisinden pay = 7 × büyütme + 1
//   geometri : kenar = 25 × büyütme, `^FT` y'si ALT kenar
//
// 799×799 gerçek render'da taşıyıcı slotunda (taban çizgisi 741) ölçüldü:
//
//   büyütme | kenar | alt mürekkep | taban − alt
//        1  |   21  |     733      |      8
//        2  |   42  |     726      |     15
//        4  |   84  |     712      |     29
//        5  |  105  |     705      |     36
//        6  |  126  |     698      |     43
//
// kenar = 21 × büyütme · alt = taban − (7 × büyütme + 1). Geometri modeli
// büyütme 5'te alt kenarı 741 sayıyordu; GERÇEK 705. Bu 36 dot HAYALET
// İÇERİKTİR ve doğrudan ürün footer'ından çalınıyordu.
//
// SONUÇ: footer yüksekliği QR'ın nerede ve hangi büyütmede durduğuna göre
// DEĞİŞİYORDU. Eski composer QR'ı `^FT690,650`de bırakıyordu (footer 66 dot);
// `bdee451` sonrası QR alt hizaya çıpalandı ve taban 741 oldu (footer 44 dot).
// Yani AYNI SINIFTAKİ iki etiket, YALNIZ hangi composer sürümüyle compose
// edildiğine göre farklı font üretiyordu. CASE A eski artefakt, CASE B yeni.
//
// ═══ DÜZELTME ════════════════════════════════════════════════════════════
// Geometri modeli ölçülen render geometrisine bağlandı. Footer bölgesi artık
// QR büyütmesinden ve QR'ın taban çizgisinden BAĞIMSIZDIR.
//
// KAPSAM: yalnız `^FT` + `^BQ`. `^FO` dalı DEĞİŞMEDİ (bkz. FOOTER-V2-8).
//
// HİÇBİR İDDİA DİZGİYE DAYANMAZ: ölçüler 799×799 gerçek render'ın
// PİKSELLERİNDEN gelir.

const here = dirname(fileURLToPath(import.meta.url))
const V2_ZPL = readFileSync(join(here, 'fixtures', 'surat-real-v2-numeric.zpl'), 'utf8')
const SYNTHETIC_ZPL = readFileSync(
  join(here, 'fixtures', 'synthetic-surat-reference.zpl'), 'utf8',
)

const LABEL_EDGE = 798

let _vite
let composeSuratLabel
let parseSuratZplGeometry
let deriveAugmentedSuratZpl
let L
let renderZplToPng

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'error',
  })
  ;({ composeSuratLabel } = await _vite.ssrLoadModule('/src/utils/suratLabelComposer.ts'))
  ;({ parseSuratZplGeometry } = await _vite.ssrLoadModule('/src/utils/suratZplGeometry.ts'))
  ;({ deriveAugmentedSuratZpl } = await _vite.ssrLoadModule('/src/utils/augmentedSuratZpl.ts'))
  L = await _vite.ssrLoadModule('/src/utils/suratZplProductLine.ts')
  ;({ renderZplToPng } = await _vite.ssrLoadModule('/server/labels/zplRenderService.ts'))
})
after(async () => {
  if (_vite) await _vite.close()
})

async function bitmap(zpl) {
  const result = await renderZplToPng({ zpl })
  return decodePngToBitmap(Buffer.from(result.pngBase64, 'base64'))
}

/** İki render'ın FARKINDAN bbox — sabit ölçüm penceresi KULLANILMAZ. */
function diffBox(withIt, withoutIt) {
  let left = Infinity, top = Infinity, right = -1, bottom = -1, ink = 0
  for (let y = 0; y <= LABEL_EDGE; y += 1) {
    for (let x = 0; x <= LABEL_EDGE; x += 1) {
      if (!withIt.dark[y][x] || withoutIt.dark[y][x]) continue
      ink += 1
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return ink === 0 ? null : { left, top, right, bottom, ink, side: right - left + 1 }
}

function inkBottom(bm) {
  for (let y = LABEL_EDGE; y >= 0; y -= 1) {
    for (let x = 0; x <= LABEL_EDGE; x += 1) if (bm.dark[y][x]) return y
  }
  return -1
}

const QR_FIELD = /\^FT\d+,\d+\s*\^BQ[^^]*\^FD[A-Z]{2},[^^]*\^FS/

const item = (over = {}) => ({
  productName: 'Bluz', quantity: 1, color: 'Krem', size: '40', sku: '6496', ...over,
})
const LONG = item({
  productName: 'Onu Drapeli Los Tesettur Takim Uzun Kollu Astarli Abiye Elbise',
  color: 'Lacivert', size: '38', sku: 'SCUBA-SECOT-0012',
})

const composedV2 = () => composeSuratLabel(V2_ZPL, {}).zpl
/** Taşıyıcı QR'ının büyütmesini DEĞİŞTİRİR; konum ve yük AYNEN kalır. */
const withMagnification = (zpl, mag) =>
  zpl.replace(/(\^BQ[A-Z]?,\d+,)\d+/, `$1${mag}`)
/** `bdee451` ÖNCESİ artefakt biçimi: QR taşıyıcının özgün yerinde ve bozuk token. */
const legacyPlacement = (zpl) =>
  zpl.replace(QR_FIELD, '^FT690,650^BQN,4,4 ^FDQA,7270034422363739^FS')

/* ═══ QR-CONSISTENCY-1..4 ══════════════════════════════════════════════ */

test('QR-CONSISTENCY-1: ^FT+^BQ render geometrisi OLCULEN modelle birebir', async () => {
  const base = composedV2()
  const baseline = Number((base.match(/\^FT\d+,(\d+)\^BQ/) ?? [])[1])
  assert.ok(baseline > 0, 'QR taban cizgisi okunamadi')
  const withoutQr = await bitmap(base.replace(QR_FIELD, ''))

  // Model: kenar = 21 × büyütme, alt = taban − (7 × büyütme + 1).
  for (const mag of [1, 2, 4, 5, 6]) {
    const zpl = withMagnification(base, mag)
    const box = diffBox(await bitmap(zpl), withoutQr)
    assert.ok(box, `mag ${mag}: QR murekkebi YOK`)
    assert.equal(box.side, 21 * mag, `mag ${mag}: kenar`)
    assert.equal(baseline - box.bottom, 7 * mag + 1, `mag ${mag}: taban payi`)

    // Geometri ayristiricisi AYNI kutuyu bildirmeli.
    const geo = parseSuratZplGeometry(zpl)
    const qr = geo.elements
      .filter((e) => e.kind === 'qr')
      .sort((a, b) => b.x - a.x)[0]
    assert.equal(qr.width, box.side, `mag ${mag}: ayristirici kenari`)
    assert.equal(qr.y + qr.height, box.bottom, `mag ${mag}: ayristirici alt kenari`)
  }
})

test('QR-CONSISTENCY-2: footer, QR GERCEK murekkebinden turer', async () => {
  // ÖLÇÜM BİR VARSAYIMI ÇÜRÜTTÜ: "footer büyütmeden bağımsızdır" DOĞRU
  // DEĞİL. Büyütme küçüldükçe `^FT` kutusu taban çizgisine yaklaşır ve QR
  // GERÇEKTEN daha aşağıda biter (mag 1 → alt 733, mag 5 → alt 705).
  // Doğru sözleşme "bağımsızlık" değil, ÖLÇÜLMÜŞLÜKTÜR: footer QR'ın
  // gerçek alt mürekkebini izler, hayalet bir tabanı değil.
  const base = composedV2()
  const withoutQr = await bitmap(base.replace(QR_FIELD, ''))
  const carrierBottomWithoutQr = inkBottom(withoutQr)

  for (const mag of [1, 2, 4, 5, 6]) {
    const zpl = withMagnification(base, mag)
    const box = diffBox(await bitmap(zpl), withoutQr)
    const area = L.resolveFooterArea(parseSuratZplGeometry(zpl))
    const realCarrierBottom = Math.max(carrierBottomWithoutQr, box.bottom)
    // Footer, GERÇEK taşıyıcı mürekkebinin altında başlar...
    assert.ok(
      area.top > realCarrierBottom,
      `mag ${mag}: footer ${area.top} <= gercek murekkep ${realCarrierBottom}`,
    )
    // ...ve ondan GEREKSIZ uzaklasmaz (hayalet icerik YOK).
    assert.ok(
      area.top - realCarrierBottom <= 20,
      `mag ${mag}: footer gercek murekkepten ${area.top - realCarrierBottom} dot uzakta `
      + '(hayalet icerik)',
    )
  }

  // KANONİK SÖZLEŞMENİN URETTIGI buyutmelerde (adaylar 6 ve 5) footer AYNI.
  const canonical = [5, 6].map(
    (mag) => L.resolveFooterArea(parseSuratZplGeometry(withMagnification(base, mag))).height,
  )
  assert.equal(canonical[0], canonical[1], 'kanonik adaylar farkli footer veriyor')
})

test('QR-CONSISTENCY-2b: ESKI ve YENI QR yerlesimi AYNI footer bolgesini verir', () => {
  const current = parseSuratZplGeometry(composedV2())
  const legacy = parseSuratZplGeometry(legacyPlacement(composedV2()))
  const a = L.resolveFooterArea(current)
  const b = L.resolveFooterArea(legacy)
  // CASE A / CASE B ayrismasinin TA KENDISI buydu.
  assert.deepEqual(
    { top: a.top, height: a.height },
    { top: b.top, height: b.height },
    'composer surumu footer bolgesini DEGISTIRMEMELI',
  )
})

test('QR-CONSISTENCY-3: QR yuku ve konumu DEGISMEDI', () => {
  const source = (V2_ZPL.match(/\^BQ[^^]*\^FD([A-Z]{2},[^^]*)\^FS/) ?? [])[1]
  const composed = (composedV2().match(/\^BQ[^^]*\^FD([A-Z]{2},[^^]*)\^FS/) ?? [])[1]
  assert.equal(composed, source, 'QR yuku DEGISMEMELI')
})

test('QR-CONSISTENCY-4: QR korunmus geometriyle CAKISMAZ', async () => {
  const base = composedV2()
  const withQr = await bitmap(base)
  const withoutQr = await bitmap(base.replace(QR_FIELD, ''))
  const box = diffBox(withQr, withoutQr)
  // QR kutusunun ICINDE, QR'dan BAGIMSIZ murekkep olmamali.
  let overlap = 0
  for (let y = box.top; y <= box.bottom; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      if (withoutQr.dark[y][x]) overlap += 1
    }
  }
  assert.equal(overlap, 0, 'QR kutusunda YABANCI murekkep var')
})

/* ═══ FOOTER-V2-1..8 ═══════════════════════════════════════════════════ */

/** Ürün footer'ı EKLENMİŞ tam etiket (üretim yolu: deriveAugmentedSuratZpl). */
function augmented(items, mutate = (z) => z) {
  const source = mutate(V2_ZPL)
  return deriveAugmentedSuratZpl(source, items, { compose: {} })
}

async function productBox(items, mutate) {
  const result = augmented(items, mutate)
  assert.equal(
    result.augmented, true,
    `urun satiri EKLENMEDI: ${result.augmentationStatus} ${result.fallbackReason ?? ''}`,
  )
  const withProduct = await bitmap(result.printZpl)
  const source = mutate ? mutate(V2_ZPL) : V2_ZPL
  // Taban: AYNI composer yolundan gecen, urun satiri OLMAYAN etiket.
  const withoutProduct = await bitmap(
    deriveAugmentedSuratZpl(source, [], { compose: {} }).printZpl,
  )
  return { box: diffBox(withProduct, withoutProduct), withProduct, withoutProduct, result }
}

test('FOOTER-V2-1: CASE A sekli (eski yerlesim) ile CASE B sekli AYNI fontu verir', () => {
  const geoB = parseSuratZplGeometry(composedV2())
  const geoA = parseSuratZplGeometry(legacyPlacement(composedV2()))
  for (const items of [[item()], [LONG], [item(), item({ productName: 'Etek', sku: '7001' })]]) {
    const planA = L.planSuratFooter(items, geoA)
    const planB = L.planSuratFooter(items, geoB)
    assert.equal(planA.ok && planB.ok, true)
    assert.equal(
      planA.profile.fontHeight, planB.profile.fontHeight,
      'iki canli vaka AYNI fontu uretmeli',
    )
  }
})

test('FOOTER-V2-2: secim MAKSIMAL — bir buyugu SIGMAZ', () => {
  const geo = parseSuratZplGeometry(composedV2())
  for (const items of [
    [item()], [LONG],
    [item(), item({ productName: 'Etek', sku: '7001' })],
    [item(), item({ productName: 'Etek', sku: '7001' }), item({ productName: 'Ceket', sku: '7002' })],
  ]) {
    const plan = L.planSuratFooter(items, geo)
    assert.equal(plan.ok, true)
    const font = plan.profile.fontHeight
    if (font >= L.FOOTER_MAX_FONT_HEIGHT) continue
    const bigger = L.measureFooterFit(items, plan.area, font + 1)
    assert.equal(
      bigger.fits, false,
      `font ${font} MAKSIMAL DEGIL: ${font + 1} de siğiyor `
      + `(${bigger.usedHeight} <= ${plan.area.height})`,
    )
  }
})

test('FOOTER-V2-3: duzeltme footer bolgesini GERCEKTEN buyuttu', () => {
  const geo = parseSuratZplGeometry(composedV2())
  const area = L.resolveFooterArea(geo)
  // Fiziksel olarak bos bant (olculdu: taşıyıcı murekkebi 705'te biter).
  // Eski model 741 diyordu → footer 44 dot. Yeni model gercek bosluga yakin.
  assert.ok(area.height >= 60, `footer yuksekligi ${area.height} < 60`)
  assert.ok(geo.contentBottom <= 725, `contentBottom ${geo.contentBottom} hala sisik`)
})

test('FOOTER-V2-4: urun metni ALT SINIRI ASMAZ, guvenli pay KORUNUR', async () => {
  for (const items of [[item()], [LONG], [item(), item({ productName: 'Etek', sku: '7001' })]]) {
    const { box } = await productBox(items)
    assert.ok(box, 'urun murekkebi YOK')
    const remaining = LABEL_EDGE - box.bottom
    assert.ok(box.bottom <= LABEL_EDGE, `alt tasma: ${box.bottom}`)
    assert.ok(
      remaining >= L.FOOTER_BOTTOM_MARGIN - 1,
      `alt guvenli pay ${remaining} < ${L.FOOTER_BOTTOM_MARGIN}`,
    )
  }
})

test('FOOTER-V2-5: urun metni TASIYICI murekkebiyle CAKISMAZ (piksel)', async () => {
  for (const items of [[item()], [LONG], [item(), item({ productName: 'Etek', sku: '7001' })]]) {
    const { box, withoutProduct } = await productBox(items)
    let overlap = 0
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        if (withoutProduct.dark[y][x]) overlap += 1
      }
    }
    assert.equal(overlap, 0, 'urun metni tasiyici murekkebiyle CAKISIYOR')
  }
})

test('FOOTER-V2-6: tekli ve toplu yol AYNI artefakti uretir', () => {
  const items = [item()]
  const single = deriveAugmentedSuratZpl(V2_ZPL, items, { compose: {} })
  const bulk = [1, 2, 3].map(() => deriveAugmentedSuratZpl(V2_ZPL, items, { compose: {} }))
  for (const one of bulk) assert.equal(one.zpl, single.zpl)
})

test('FOOTER-V2-7: worker ve manuel AYNI composer sonucunu verir', () => {
  // Composer SAF bir fonksiyondur: aynı kaynak + aynı girdi → aynı çıktı.
  // Worker ile manuel yol AYNI `deriveAugmentedSuratZpl` cagrisini kullanir.
  const a = deriveAugmentedSuratZpl(V2_ZPL, [item()], { compose: {} })
  const b = deriveAugmentedSuratZpl(V2_ZPL, [item()], { compose: {} })
  assert.equal(a.zpl, b.zpl)
  assert.equal(a.renderContract, 'carrier_composed')
})

test('FOOTER-V2-8: alternatif ^FO sozdizimi geometri normalizasyonunu ATLAMAZ', async () => {
  // `^FO` dali DEGISTIRILMEDI; burada KANITLANAN sey, o sozdiziminde de
  // QR'in OLCULDUGU ve footer'in onun UZERINE BINMEDIGIDIR.
  const geo = parseSuratZplGeometry(SYNTHETIC_ZPL)
  const qr = geo.elements.filter((e) => e.kind === 'qr').sort((a, b) => b.x - a.x)[0]
  assert.ok(qr, '^FO QR OLCULMEDI')

  const field = /\^FO\d+,\d+\^BQ[^^]*\^FD[A-Z]{2},[^^]*\^FS/
  const box = diffBox(await bitmap(SYNTHETIC_ZPL), await bitmap(SYNTHETIC_ZPL.replace(field, '')))
  assert.ok(box, 'render QR murekkebi YOK')
  // Ayristirici alt kenari GERCEK alt kenarin ALTINDA olmali (muhafazakar).
  assert.ok(
    qr.y + qr.height >= box.bottom,
    `^FO QR alt kenari EKSIK olculdu: ${qr.y + qr.height} < ${box.bottom}`,
  )
  // Footer QR'in gercek murekkebinin ALTINDA baslar.
  const area = L.resolveFooterArea(geo)
  assert.ok(area.top > box.bottom, `footer QR'in UZERINE biniyor: ${area.top} <= ${box.bottom}`)
})

/* ═══ REGRESYON ════════════════════════════════════════════════════════ */

test('FOOTER-V2-REG: tasiyici bloklari HAREKET ETMEDI', async () => {
  // Urun footer'i EKLEMEDIR: tasiyicinin kendi murekkebi TEK PIKSEL degismez.
  const withoutProduct = await bitmap(
    deriveAugmentedSuratZpl(V2_ZPL, [], { compose: {} }).printZpl,
  )
  const { withProduct } = await productBox([item()])
  let removed = 0
  for (let y = 0; y <= LABEL_EDGE; y += 1) {
    for (let x = 0; x <= LABEL_EDGE; x += 1) {
      if (withoutProduct.dark[y][x] && !withProduct.dark[y][x]) removed += 1
    }
  }
  assert.equal(removed, 0, 'tasiyici murekkebi KALKTI')
})

test('FOOTER-V2-REG2: QR disindaki gecmis geometri sozlesmeleri KORUNDU', async () => {
  // Etiket olcusu, DataMatrix ve barkod bloklari DEGISMEDI.
  const geo = parseSuratZplGeometry(composedV2())
  assert.equal(geo.printWidth, 799)
  assert.equal(geo.labelLength, 799)
  const dm = geo.elements.filter((e) => e.kind === 'qr').sort((a, b) => a.x - b.x)[0]
  assert.equal(dm.x, 59, 'DataMatrix konumu degisti')
  assert.equal(dm.width, 192, 'DataMatrix olcum modeli degisti')
  const bottom = inkBottom(await bitmap(composedV2()))
  assert.equal(bottom, 705, `tasiyici murekkep alt siniri degisti: ${bottom}`)
})

test('FOOTER-V2-REG3: bu dosya test:surat icinde KAYITLI', () => {
  const registry = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const files = Array.isArray(registry) ? registry : registry.files
  assert.ok(files.includes('server/live-label-footer-consistency-flow.test.mjs'))
})
