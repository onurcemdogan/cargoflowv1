import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Rota/aktarma satırlarının etiket alanına sığdırılması.
//
// KÖK NEDEN (görsel inceleme): sabit 15pt/13pt rota satırları dar sütunda
// iki satıra sarıp teslimat bölümünü aşıyor, ürün footer'ının üstüne taşıyor
// ve bölüm ayırıcı çizgisi metnin içinden geçiyordu.
//
// Veriler SENTETİKTİR.

const here = dirname(fileURLToPath(import.meta.url))
let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom', server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const fit = () => load('/src/utils/labelRouteFit.ts')
const BUDGET = { availableWidthMm: 52, availableHeightMm: 13.4 }

test('ROUTE-1: kısa rota EN BÜYÜK kademede kalır', async () => {
  const { resolveRouteFit, ROUTE_FIT_TIERS } = await fit()
  const result = resolveRouteFit({
    destination: 'KASTAMONU / ARAC',
    transfer: 'GEREDE AKTARMA',
    ...BUDGET,
  })
  assert.equal(result.fits, true)
  assert.deepEqual(result.tier, ROUTE_FIT_TIERS[0])
  assert.equal(result.tier.destinationPt, 13)
  assert.equal(result.tier.transferPt, 11.5)
})

test('ROUTE-2: uzun rota KONTROLLÜ küçültülür (kırpma YOK)', async () => {
  const { resolveRouteFit, ROUTE_FIT_TIERS } = await fit()
  const result = resolveRouteFit({
    destination: 'KAHRAMANMARAS / AFSIN ILCESI MERKEZ',
    transfer: 'GAZIANTEP AKTARMA MERKEZI SUBESI',
    ...BUDGET,
  })
  assert.equal(result.fits, true)
  assert.ok(
    result.tier.destinationPt < ROUTE_FIT_TIERS[0].destinationPt,
    'punto düşmeli',
  )
  assert.ok(result.estimatedHeightMm <= BUDGET.availableHeightMm)
})

test('ROUTE-3: kademeler MONOTON azalır ve minimum sınır vardır', async () => {
  const { ROUTE_FIT_TIERS } = await fit()
  for (let i = 1; i < ROUTE_FIT_TIERS.length; i += 1) {
    assert.ok(
      ROUTE_FIT_TIERS[i].destinationPt < ROUTE_FIT_TIERS[i - 1].destinationPt,
      'rota puntosu azalmalı',
    )
    assert.ok(
      ROUTE_FIT_TIERS[i].transferPt <= ROUTE_FIT_TIERS[i - 1].transferPt,
      'aktarma puntosu azalmalı',
    )
  }
  const min = ROUTE_FIT_TIERS[ROUTE_FIT_TIERS.length - 1]
  assert.equal(min.destinationPt, 9, 'minimum rota puntosu')
  assert.equal(min.transferPt, 8, 'minimum aktarma puntosu')
  // Negatif satır aralığı YOK.
  for (const tier of ROUTE_FIT_TIERS) {
    assert.ok(tier.lineHeight >= 0.9 && tier.lineHeight <= 1)
  }
})

test('ROUTE-4: hiçbir kademe sığmazsa fits=false (sessiz kırpma YOK)', async () => {
  const { resolveRouteFit } = await fit()
  const result = resolveRouteFit({
    destination: 'A'.repeat(400),
    transfer: 'B'.repeat(400),
    ...BUDGET,
  })
  assert.equal(result.fits, false)
})

test('ROUTE-5: sığmayan rota AÇIK hata verir (etiket sessizce basılmaz)', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const { ROUTE_OVERFLOW_MESSAGE } = await fit()
  const TNO = '25220148446193'
  const BARCODE = '01231201025'
  const order = {
    id: 'o1', orderNumber: '7270032941525232', packageId: 'PKG1',
    operationStatus: 'LABEL_READY', labelStatus: 'READY',
    customerName: 'SENTETIK ALICI', customerPhone: '5410000000',
    city: 'X'.repeat(200), district: 'Y'.repeat(200),
    address: 'YENI MAH SENTETIK CADDESI NO 1',
    desi: 2,
    items: [{ id: 'l1', quantity: 1, productName: 'Test Ürün' }],
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: TNO, tNo: TNO, kargoTakipNo: TNO,
      barcode: BARCODE, barkodNo: BARCODE, barcodeValue: BARCODE,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true, printEnabled: true,
      barcodeRaw: `^XA^FD${BARCODE}^FS^XZ`,
    },
  }
  const template = {
    id: 't', widthMm: 100, heightMm: 100,
    widthDots: 799, heightDots: 799, fields: [],
  }
  // Tek siparislik batch'te hicbir sey basilamiyorsa MEVCUT sozlesme geregi
  // ACIK hata firlatilir (sessiz bos etiket YOK).
  assert.throws(
    () => buildCleanLabelDocument([order], template, {}),
    (error) => String(error.message).includes(ROUTE_OVERFLOW_MESSAGE),
  )

  // SIPARIS BAZINDA IZOLASYON: saglam siparis basilir, yalniz sorunlu olan
  // acik sebeple atlanir; batch tumden dusmez.
  const healthy = {
    ...order, id: 'o2', orderNumber: '7270032941525233',
    city: 'KASTAMONU', district: 'ARAC',
  }
  const mixed = buildCleanLabelDocument([healthy, order], template, {})
  assert.equal(mixed.printable.length, 1)
  assert.equal(mixed.printable[0].model.orderNumber, '7270032941525233')
  assert.equal(mixed.skipped.length, 1)
  assert.equal(mixed.skipped[0].reason, ROUTE_OVERFLOW_MESSAGE)
})

test('ROUTE-6: baskı CSS\'i kademeyi değişkenden okur, SESSİZ KIRPMA yok', () => {
  const src = readFileSync(join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  assert.match(src, /--route-destination-size/)
  assert.match(src, /--route-transfer-size/)
  assert.match(src, /--route-line-height/)
  // Sabit 15pt/13pt rota puntosu KALMADI.
  assert.equal(/surat-destination-normal|surat-destination-small/.test(src), false)
  const style = src.slice(src.indexOf('.surat-delivery {'), src.indexOf('.surat-product {'))
  assert.equal(/-webkit-line-clamp/.test(style), false, 'kırpma yok')
  assert.equal(/overflow: hidden/.test(style), false, 'gizleme yok')
})

test('ROUTE-7: önizleme CSS\'i AYNI kademeyi kullanır (preview == print)', () => {
  const css = readFileSync(join(here, '..', 'src/index.css'), 'utf8')
  const preview = readFileSync(
    join(here, '..', 'src/components/LabelHtmlPreview.tsx'), 'utf8')
  const zone = css
    .slice(
      css.indexOf('.surat-delivery-copy strong'),
      css.indexOf('.surat-product-section'),
    )
    // Yorumlar cikarilir: aciklama metnindeki "line-clamp" kelimesi yanlis
    // pozitif uretiyordu.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  assert.equal(/-webkit-line-clamp/.test(zone), false, 'önizlemede de kırpma yok')
  assert.match(zone, /var\(--label-delivery-route-size/)
  assert.match(zone, /var\(--label-route-line-height/)
  // Onizleme puntoyu baski ile AYNI TEK cozumleyiciden alir
  // (resolveLabelLayout -> profil + productFit + routeFit).
  assert.match(preview, /resolveLabelLayout\(/)
  assert.match(preview, /routeFit\.tier\.destinationPt/)
  assert.match(preview, /routeFit\.tier\.transferPt/)
})

test('ROUTE-8: barkod payload ve 10X sessiz alan DEĞİŞMEDİ', () => {
  const src = readFileSync(join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  // Sessiz alan hâlâ viewBox içinde, JsBarcode margin'i ile DEĞİL.
  assert.match(src, /margin: 0,/)
  assert.match(src, /applyScalableQuietZone\(svg, BARCODE_MODULE_WIDTH\)/)
  assert.match(src, /displayValue: true/)
  const quiet = readFileSync(join(here, '..', 'src/utils/barcodeQuietZone.ts'), 'utf8')
  assert.match(quiet, /CODE128_QUIET_ZONE_MODULES = 10/)
})
