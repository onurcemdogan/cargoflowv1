import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

// ═══ ÜST SEKME + SİPARİŞ DETAYI DOĞRULUK SÖZLEŞMESİ ══════════════════════
//
// ÜÇ ÖLÇÜLEN KUSUR:
//
// 1) "Etiket Hazır" üst sekmesi `isLabelReady ∪ isLabelPrinted` idi. Kullanıcı
//    aktivasyon semantiğinden sonra bu İKİ AYRI kullanıcı durumunu birleştiriyor
//    ve sekmeye girince "Etiket Basıldı" satırları görünüyordu.
//
// 2) Satır "Kargoya Verildi" derken sipariş detayındaki zaman çizelgesi "Henüz
//    aktif takip yok" diyordu: çizelge DAHA DAR bir kanıt kümesi kullanıyordu
//    (pazaryeri `Shipped` ve `shippedAt` HİÇ okunmuyordu).
//
// 3) Detay özet kartları artefakt hazırlığından besleniyordu; arka planda
//    hazırlanmış sipariş satırda "Barkod Bekliyor" iken detayda "Etiket Hazır"
//    görünüyordu.
//
// Bu paket üçünü de canonical kaynağa bağlı tutar.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let _vite
let classification
let timeline
let evidence
let orderStatus
let OrderDetailDrawer
let ORDERS_QUICK_TABS

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'error',
  })
  classification = await _vite.ssrLoadModule('/src/utils/orderClassification.ts')
  timeline = await _vite.ssrLoadModule('/src/utils/suratShipmentTimeline.ts')
  evidence = await _vite.ssrLoadModule('/src/utils/orderShippingEvidence.ts')
  orderStatus = await _vite.ssrLoadModule('/src/utils/orderStatus.ts')
  ;({ OrderDetailDrawer } = await _vite.ssrLoadModule(
    '/src/components/OrderDetailDrawer.tsx',
  ))
  ;({ ORDERS_QUICK_TABS } = await _vite.ssrLoadModule(
    '/src/utils/ordersWorkspaceQuery.ts',
  ))
})
after(async () => {
  if (_vite) await _vite.close()
})

// Dogrulanmis Surat gonderisi ve ona AIT siparis — referanslar (packageId /
// satisKodu / 727) BIRBIRIYLE ESLESMELI, yoksa `verifySuratShipment` gonderiyi
// dogrulanmamis sayar ve fixture sessizce "Acik Operasyon" olur.
const BARCODE_RAW = [
  '^XA',
  '^FO20,20^A0N,30,30^FDSURAT LABEL^FS',
  '^FO20,70^BCN,80,Y,N,N^FD01231201025^FS',
  '^XZ',
].join(String.fromCharCode(10))

const READY_SHIPMENT = {
  id: 'shp-1', provider: 'surat-kargo', serviceMode: 'ORTAK_BARKOD_SOAP',
  operationName: 'OrtakBarkodOlustur', trackingNumber: '25220148446193',
  kargoTakipNo: '25220148446193', tNo: '25220148446193',
  barcode: '01231201025', barcodeRaw: BARCODE_RAW,
  zplSource: 'surat.ortakBarkod.BarcodeRaw',
  shipmentCode: 'PKG123', satisKodu: 'ORDER123',
  webSiparisKodu: '7270033563324593', ozelKargoTakipNo: '7270033563324593',
  barcodeValue: '01231201025', barcodeSource: 'surat.ortakBarkod.Barcode',
  labelStatus: 'READY', status: 'created', lifecycleStatus: 'LABEL_READY',
  source: 'real', verifiedShipment: true,
  dispatchRegistrationConfirmed: true, operationalBarcodeVerified: true,
  serdendipVerified: true, verificationStage: 'serdendip_verified',
  lifecycleStage: 'VERIFIED',
  suratTrackingLog: {
    gonderilerLength: 1, KargoTakipNo: '25220148446193',
    BarkodNo: '01231201025', WebSiparisKodu: '7270033563324593',
    OzelKargoTakipNo: '7270033563324593',
  },
  suratCreateLog: {
    serviceMode: 'ORTAK_BARKOD_SOAP', operationName: 'OrtakBarkodOlustur',
    BarcodeRaw: BARCODE_RAW,
    parsedResponse: {
      KargoTakipNo: '25220148446193', TNo: '25220148446193',
      Barcode: '01231201025', BarcodeRaw: BARCODE_RAW,
      Barkod: '01231201025', requestReference: 'PKG123',
    },
  },
}

function order(over = {}) {
  return {
    id: over.id ?? 'o1',
    orderNumber: 'ORDER123',
    packageId: 'PKG123',
    externalOrderId: 'ORDER123',
    cargoTrackingNumber: '7270033563324593',
    marketplace: 'Trendyol',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    source: 'real',
    status: 'Yeni',
    customerName: 'Ada Lovelace',
    customerPhone: '5550000000',
    address: 'Gizli Mah. 1',
    city: 'İstanbul',
    district: 'Kadıköy',
    totalAmount: 100,
    desi: 2,
    desiSource: 'manual',
    orderDate: '2026-09-01T08:00:00.000Z',
    createdAt: '2026-09-01T08:00:00.000Z',
    items: [{ id: 'i1', productName: 'Ürün', barcode: 'BRC', quantity: 1 }],
    ...over,
  }
}

const project = (o) => orderStatus.withDerivedOperationStatus(o)
const tabOf = (o, tab) =>
  classification.orderMatchesQuickTab(
    classification.classifyOrderForTabs(project(o)),
    tab,
  )
const stageOf = (o) =>
  classification.classifyDashboardOperationStage(project(o)).label

/* ═══ ORDERS-TAB-PRINTED-1..6 ═════════════════════════════════════════ */

test('ORDERS-TAB-PRINTED-0: ikinci ana sekme "Etiket Basildi" ve degeri labelPrinted', () => {
  const tabs = ORDERS_QUICK_TABS.map((t) => `${t.key}:${t.label}`)
  assert.deepEqual(tabs, [
    'newOrders:Yeni Siparişler',
    'labelPrinted:Etiket Basıldı',
    'handedToCargo:Kargoya Verildi',
    'delivered:Teslim Edildi',
    'cancelReturn:İptal / İade',
    'all:Tümü',
  ])
  // "Etiket Hazır" ARTIK ust sekme DEGIL.
  assert.equal(
    ORDERS_QUICK_TABS.some((t) => t.label === 'Etiket Hazır'), false,
  )
})

test('ORDERS-TAB-PRINTED-1: aktive edilmis ama BASILMAMIS → sekmeye GIRMEZ', () => {
  const activated = order({
    shipment: READY_SHIPMENT,
    userLabelActivatedAt: '2026-09-02T10:00:00.000Z',
  })
  const cls = classification.classifyOrderForTabs(project(activated))
  assert.equal(cls.isLabelReady, true)
  assert.equal(cls.isLabelPrinted, false)
  assert.equal(tabOf(activated, 'labelPrinted'), false)
})

test('ORDERS-TAB-PRINTED-2: BASILMIS → sekmeye GIRER', () => {
  const printed = order({
    shipment: READY_SHIPMENT,
    labelStatus: 'PRINTED',
    label: { printedAt: '2026-09-02T11:00:00.000Z' },
  })
  assert.equal(classification.classifyOrderForTabs(project(printed)).isLabelPrinted, true)
  assert.equal(tabOf(printed, 'labelPrinted'), true)
})

test('ORDERS-TAB-PRINTED-3: worker artefakti READY + aktivasyon YOK → sekmeye GIRMEZ', () => {
  const prepared = order({ shipment: READY_SHIPMENT })
  assert.equal(stageOf(prepared), 'Barkod Bekliyor')
  assert.equal(tabOf(prepared, 'labelPrinted'), false)
  // Kapsama boslugu YOK: ana sekmelerden BIRINE duser.
  assert.equal(tabOf(prepared, 'newOrders'), true)
})

test('ORDERS-TAB-PRINTED-4: aktive + basilmamis → rozet "Etiket Hazir", sekme DISINDA', () => {
  const activated = order({
    shipment: READY_SHIPMENT,
    userLabelActivatedAt: '2026-09-02T10:00:00.000Z',
  })
  assert.equal(stageOf(activated), 'Etiket Hazır')
  assert.equal(tabOf(activated, 'labelPrinted'), false)
  assert.equal(tabOf(activated, 'newOrders'), true)
})

test('ORDERS-TAB-PRINTED-5: basilmis → rozet "Etiket Basildi", sekme ICINDE', () => {
  const printed = order({
    shipment: READY_SHIPMENT,
    labelStatus: 'PRINTED',
    label: { printedAt: '2026-09-02T11:00:00.000Z' },
  })
  assert.equal(stageOf(printed), 'Etiket Basıldı')
  assert.equal(tabOf(printed, 'labelPrinted'), true)
  assert.equal(tabOf(printed, 'newOrders'), false)
})

test('ORDERS-TAB-PRINTED-6: sayac ve liste AYNI canonical yuklemi kullanir', () => {
  // Sayac yolu (`buildTabCounts`) ve liste yolu (`buildVisibleOrders`) tek
  // `orderMatchesQuickTab` uzerinden gecer — IKI AYRI tanim YOK.
  const source = readFileSync(join(root, 'src/utils/ordersWorkspaceQuery.ts'), 'utf8')
  assert.match(source, /orderMatchesQuickTab\(state, tab\.key\)/)
  const dataset = [
    order({ id: 'a', packageId: 'P-A', shipment: READY_SHIPMENT }),
    order({
      id: 'b', packageId: 'P-B', shipment: READY_SHIPMENT,
      labelStatus: 'PRINTED', label: { printedAt: '2026-09-02T11:00:00.000Z' },
    }),
  ].map(project)
  const listed = classification.buildVisibleOrders({
    persistentOrders: dataset,
    selectedTab: 'labelPrinted',
    marketplaceFilter: 'all', operationStatusFilter: 'all', cargoFilter: 'all',
    dateFilter: { preset: 'all' }, searchQuery: '',
    now: new Date('2026-09-10T00:00:00.000Z'),
  }).visibleOrders
  const counted = dataset.filter((o) => tabOf(o, 'labelPrinted')).length
  assert.equal(listed.length, counted)
  assert.equal(listed.length, 1)
})

/* ═══ DETAIL-LIFECYCLE-1..7 ═══════════════════════════════════════════ */

const stepOf = (o, key) =>
  timeline.buildSuratShipmentTimeline(project(o)).find((s) => s.key === key)

test('DETAIL-LIFECYCLE-1: pazaryeri Shipped, tasiyici dogrulamasi YOK → adim PENDING OLAMAZ', () => {
  const shipped = order({ marketplaceStatus: 'Shipped' })
  const step = stepOf(shipped, 'trackingActive')
  assert.notEqual(step.status, 'pending')
  // Gerekce DOGRU kaynaktan: tasiyici dogrulamasi YOKKEN "Surat takip kaydi
  // dogrulandi" YAZILAMAZ.
  assert.equal(step.description, 'Pazaryeri gönderinin kargoya verildiğini bildiriyor.')
  assert.doesNotMatch(step.description, /doğrulandı/)
})

test('DETAIL-LIFECYCLE-2: operationStatus=HANDED_TO_CARGO → active/completed', () => {
  const handed = order({ operationStatus: 'HANDED_TO_CARGO' })
  const step = stepOf(handed, 'trackingActive')
  assert.ok(['active', 'completed'].includes(step.status), step.status)
})

test('DETAIL-LIFECYCLE-3: shipment.shippedAt → active/completed + GERCEK zaman damgasi', () => {
  const shipped = order({
    shipment: { ...READY_SHIPMENT, shippedAt: '2026-09-03T09:30:00.000Z' },
  })
  const step = stepOf(shipped, 'trackingActive')
  assert.ok(['active', 'completed'].includes(step.status), step.status)
  assert.ok(step.timestamp, 'gercek zaman damgasi gorunmeli')
  // Uydurma YOK: damga yoksa alan da YOK.
  const noStamp = stepOf(order({ marketplaceStatus: 'Shipped' }), 'trackingActive')
  assert.equal(noStamp.timestamp, undefined)
})

test('DETAIL-LIFECYCLE-4: Delivered → kargoya verildi ve teslim COMPLETED', () => {
  const delivered = order({
    marketplaceStatus: 'Delivered',
    shipment: { ...READY_SHIPMENT, deliveredAt: '2026-09-05T12:00:00.000Z' },
  })
  assert.equal(stepOf(delivered, 'trackingActive').status, 'completed')
  assert.equal(stepOf(delivered, 'delivered').status, 'completed')
  assert.ok(stepOf(delivered, 'delivered').timestamp)
})

test('DETAIL-LIFECYCLE-5: Shipped ama CargoFlow etiket kaniti YOK → SAHTE completed YOK', () => {
  const shipped = order({ marketplaceStatus: 'Shipped' })
  const labelCreated = stepOf(shipped, 'labelCreated')
  const labelReady = stepOf(shipped, 'awaitingAcceptance')
  assert.equal(labelCreated.status, 'unknown', 'sahte gecmis yazildi')
  assert.equal(labelReady.status, 'unknown', 'sahte gecmis yazildi')
  assert.equal(labelCreated.timestamp, undefined)
  assert.match(labelCreated.description, /CargoFlow kaydı yok/)
})

test('DETAIL-LIFECYCLE-6: dogrulanmis tasiyici gonderisinde mevcut metin KORUNUR', () => {
  const verified = order({
    shipment: READY_SHIPMENT,
    operationStatus: 'HANDED_TO_CARGO',
  })
  const step = stepOf(verified, 'trackingActive')
  assert.equal(step.description, 'Sürat takip kaydı doğrulandı.')
  assert.equal(stepOf(verified, 'labelCreated').status, 'completed')
})

test('DETAIL-LIFECYCLE-7: sekme sinifi ile cizelge CELISEMEZ', () => {
  const cases = [
    order({ id: 'm', packageId: 'P-M', marketplaceStatus: 'Shipped' }),
    order({ id: 'n', packageId: 'P-N', operationStatus: 'SHIPPED' }),
    order({ id: 'o', packageId: 'P-O', shipment: { ...READY_SHIPMENT, handedToCargoAt: '2026-09-03T09:00:00.000Z' } }),
    order({ id: 'p', packageId: 'P-P', marketplaceStatus: 'AtCollectionPoint' }),
    order({ id: 'q', packageId: 'P-Q', marketplaceStatus: 'Delivered' }),
  ]
  for (const candidate of cases) {
    const cls = classification.classifyOrderForTabs(project(candidate))
    const step = stepOf(candidate, 'trackingActive')
    const timelineSaysShipped = step.status !== 'pending'
    assert.equal(
      cls.isHandedToCargo || cls.isDelivered, timelineSaysShipped,
      `${candidate.id}: liste ${cls.isHandedToCargo || cls.isDelivered}, cizelge ${timelineSaysShipped}`,
    )
  }
})

/* ═══ DETAIL-FIELDS ═══════════════════════════════════════════════════ */

function drawerHtml(o) {
  return renderToStaticMarkup(
    createElement(OrderDetailDrawer, {
      order: o,
      products: [],
      onClose: () => {},
      onCreateShipment: () => {},
      onTrackShipment: () => {},
      onDownloadZpl: () => {},
      onMarkPrinted: () => {},
      onMarkHandedToCargo: () => {},
    }),
  )
}

test('DETAIL-FIELDS-1: teknik alanlar ANA detaydan cikti, Teknik Durum ICINDE', () => {
  const html = drawerHtml(order({ shipment: READY_SHIPMENT }))
  const technicalIndex = html.indexOf('Teknik Durum')
  assert.ok(technicalIndex > 0, 'Teknik Durum bolumu YOK')
  for (const field of [
    'ZPL Durumu', 'Print Kaynağı', 'Takip Doğrulama',
    'Servis Modu', 'Operasyon Adı', 'OzelKargoTakipNo', 'ReferansNo',
  ]) {
    const at = html.indexOf(field)
    assert.ok(at > 0, `${field} KAYBOLDU (silinmemeliydi)`)
    assert.ok(at > technicalIndex, `${field} hala ANA detayda`)
  }
})

test('DETAIL-FIELDS-2: yinelenen alanlar TEK KEZ gosterilir', () => {
  const html = drawerHtml(order({ shipment: READY_SHIPMENT }))
  const count = (needle) => html.split(`>${needle}<`).length - 1
  assert.equal(count('Paket ID'), 1, 'Paket ID iki kez')
  assert.equal(count('Trendyol Takip / QR No'), 1, 'takip no iki kez')
})

test('DETAIL-FIELDS-3: kosullu alanlar veri YOKKEN cizilmez', () => {
  const html = drawerHtml(order())
  assert.doesNotMatch(html, /Planlanan Teslim/)
  assert.doesNotMatch(html, /Gerçek Teslim Tarihi/)
})

test('DETAIL-FIELDS-4: para birimi CANONICAL alandan gelir', () => {
  const html = drawerHtml(order({ currency: 'EUR' }))
  assert.match(html, /Para Birimi<\/span><strong>EUR/)
})

test('DETAIL-FIELDS-5: is akisi durumu BOS diye gizlenmez', () => {
  // Etiketi olmayan siparis icin bile durum kartlari GORUNUR.
  const html = drawerHtml(order())
  assert.match(html, /Etiket Durumu/)
  assert.match(html, /Kargo Durumu/)
  assert.match(html, /Barkod Bekliyor/)
})

/* ═══ DETAIL-PARITY-1..6 ══════════════════════════════════════════════ */

const PARITY_CASES = [
  ['A Barkod Bekliyor', order({ id: 'A', packageId: 'P-A' }), 'Barkod Bekliyor'],
  ['B worker hazirladi', order({ id: 'B', packageId: 'P-B', shipment: READY_SHIPMENT }), 'Barkod Bekliyor'],
  ['C Etiket Hazir', order({
    id: 'C', packageId: 'P-C', shipment: READY_SHIPMENT,
    userLabelActivatedAt: '2026-09-02T10:00:00.000Z',
  }), 'Etiket Hazır'],
  ['D Etiket Basildi', order({
    id: 'D', packageId: 'P-D', shipment: READY_SHIPMENT,
    labelStatus: 'PRINTED', label: { printedAt: '2026-09-02T11:00:00.000Z' },
  }), 'Etiket Basıldı'],
  ['E Kargoya Verildi (pazaryeri)', order({
    id: 'E', packageId: 'P-E', marketplaceStatus: 'Shipped',
  }), 'Kargoya Verildi'],
  ['F Kargoya Verildi (tasiyici)', order({
    id: 'F', packageId: 'P-F', shipment: { ...READY_SHIPMENT, shippedAt: '2026-09-03T09:00:00.000Z' },
  }), 'Kargoya Verildi'],
  ['G Teslim Edildi', order({
    id: 'G', packageId: 'P-G', marketplaceStatus: 'Delivered',
  }), 'Teslim Edildi'],
]

test('DETAIL-PARITY-1: satir rozeti ile detay ozet karti CELISMEZ', () => {
  for (const [name, candidate, expected] of PARITY_CASES) {
    assert.equal(stageOf(candidate), expected, `${name}: satir rozeti`)
    const html = drawerHtml(candidate)
    if (expected === 'Kargoya Verildi' || expected === 'Teslim Edildi') {
      // Kargo Durumu karti "Bekliyor" DIYEMEZ.
      assert.doesNotMatch(
        html, /Kargo Durumu<\/span><strong>Bekliyor/,
        `${name}: detay "Bekliyor" diyor ama satir "${expected}"`,
      )
    } else {
      assert.ok(html.includes(expected), `${name}: detayda "${expected}" yok`)
    }
  }
})

test('DETAIL-PARITY-2: kargoya verilmis sipariste cizelge PENDING kalmaz', () => {
  for (const [name, candidate, expected] of PARITY_CASES) {
    if (expected !== 'Kargoya Verildi' && expected !== 'Teslim Edildi') continue
    const step = stepOf(candidate, 'trackingActive')
    assert.notEqual(step.status, 'pending', `${name}: cizelge pending`)
    assert.doesNotMatch(step.description, /Henüz aktif takip yok/, name)
  }
})

test('DETAIL-PARITY-3: sekme uyeligi rozetle CELISMEZ', () => {
  for (const [name, candidate, expected] of PARITY_CASES) {
    assert.equal(
      tabOf(candidate, 'labelPrinted'), expected === 'Etiket Basıldı', name,
    )
    assert.equal(
      tabOf(candidate, 'handedToCargo'), expected === 'Kargoya Verildi', name,
    )
    assert.equal(tabOf(candidate, 'delivered'), expected === 'Teslim Edildi', name)
  }
})

test('DETAIL-PARITY-4: her siparis ana sekmelerden EN AZ BIRINE duser', () => {
  for (const [name, candidate] of PARITY_CASES) {
    const hit = ORDERS_QUICK_TABS.filter((t) => tabOf(candidate, t.key))
    assert.ok(hit.length > 0, `${name}: hicbir ana sekmede YOK`)
  }
})

test('DETAIL-PARITY-5: kanit kaynagi ile gerekce metni UYUSUR', () => {
  const marketplaceOnly = order({ marketplaceStatus: 'Shipped' })
  assert.equal(
    evidence.resolveOrderShippingEvidence(project(marketplaceOnly)).handedToCargoSource,
    'marketplace',
  )
  const withTimestamp = order({
    shipment: { ...READY_SHIPMENT, shippedAt: '2026-09-03T09:00:00.000Z' },
  })
  assert.equal(
    evidence.resolveOrderShippingEvidence(project(withTimestamp)).handedToCargoSource,
    'carrierTimestamp',
  )
  const none = order()
  const resolved = evidence.resolveOrderShippingEvidence(project(none))
  assert.equal(resolved.handedToCargo, false)
  assert.equal(resolved.handedToCargoSource, null)
  assert.equal(resolved.shippedAt, null)
})

test('DETAIL-PARITY-6: detay drawer READ-ONLY — provider/mutasyon cagrisi YOK', () => {
  const source = readFileSync(join(root, 'src/components/OrderDetailDrawer.tsx'), 'utf8')
  for (const forbidden of ['fetch(', 'createSuratShipment', 'axios']) {
    assert.equal(source.includes(forbidden), false, `drawer ${forbidden} cagiriyor`)
  }
})

/* ═══ KAYIT ═══════════════════════════════════════════════════════════ */

test('ORDERS-TAB-DETAIL-REG: bu dosya test:surat icinde KAYITLI', () => {
  const registry = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const files = Array.isArray(registry) ? registry : registry.files
  assert.ok(files.includes('server/orders-tab-detail-parity-flow.test.mjs'))
})
