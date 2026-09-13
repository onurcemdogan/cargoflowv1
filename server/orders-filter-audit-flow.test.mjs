import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

// ═══ SİPARİŞLER FİLTRE DENETİMİ — FILTER-AUDIT A..K ══════════════════════
//
// Forensic denetimin sonucunu KİLİTLER:
//
//   · `Statü → Etiket Oluşturuldu` KALDIRILDI — projede bu değeri YAZAN tek
//     bir satır yoktu, filtre daima boş dönerdi. Rozet/geçmiş render desteği
//     KASITLI olarak duruyor.
//   · `clearFilters` "Aynı Ürün Siparişi"ni de sıfırlar.
//   · `Statü → Hata` artık KALICI `operation_status = 'ERROR'` kayıtlarını da
//     bulur; geçici `status: 'Hata'` davranışı BOZULMAZ.
//   · `İşlem Durumu → labelReady` DEĞERİ aynı, görünen adı "Etiket Hazır".
//   · `optgroup` YALNIZ sunumdur: seçenek kümesi ve sorgu sonucu DEĞİŞMEZ.
//
// Çalışan hiçbir filtre kaldırılmadı; bu dosya onu da ölçer (K).

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})
test.after(() => vite.close())

const options = await vite.ssrLoadModule('/src/utils/ordersFilterOptions.ts')
const { buildVisibleOrders, classifyDashboardOperationStage } =
  await vite.ssrLoadModule('/src/utils/orderClassification.ts')
const { withDerivedOperationStatus } = await vite.ssrLoadModule(
  '/src/utils/orderStatus.ts',
)
const { OrdersPage } = await vite.ssrLoadModule('/src/pages/OrdersPage.tsx')
const { defaultLabelTemplate } = await vite.ssrLoadModule(
  '/src/services/integrationConfigService.ts',
)

function order(over = {}) {
  return {
    id: over.id ?? 'o1',
    orderNumber: over.orderNumber ?? 'ORD-1',
    packageId: over.packageId ?? 'PKG-1',
    marketplace: 'Trendyol',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerName: 'Ada',
    city: 'İstanbul',
    district: 'Kadıköy',
    orderDate: '2026-09-01T08:00:00.000Z',
    createdAt: '2026-09-01T08:00:00.000Z',
    items: [{ id: 'i1', productName: 'Ürün', barcode: 'BRC', quantity: 1 }],
    ...over,
  }
}

// ÜRETİM ŞEKLİ: liste projeksiyonu (ordersWorkspaceService) siparişleri
// `withDerivedOperationStatus`ten GEÇİREREK filtreler. Test de aynı yoldan
// geçmelidir; aksi halde `labelStatus`/`operationStatus` türetmesi olmayan
// yapay bir girdi ölçülür.
function visible(orders, over = {}) {
  return buildVisibleOrders({
    persistentOrders: orders.map((item) => withDerivedOperationStatus(item)),
    selectedTab: 'all',
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    dateFilter: { preset: 'all' },
    searchQuery: '',
    now: new Date('2026-09-10T00:00:00.000Z'),
    ...over,
  }).visibleOrders
}

function ordersHtml(extraProps = {}) {
  return renderToStaticMarkup(
    createElement(OrdersPage, {
      orders: [],
      products: [],
      labelTemplate: defaultLabelTemplate,
      labelMappingConfig: {},
      labelPreviewDrafts: {},
      selectedIds: [],
      busy: false,
      onToggleOrder: () => {},
      onToggleAll: () => {},
      onFetchOrders: () => {},
      onCreateShipments: () => {},
      onCreateShipmentForOrder: () => {},
      onTrackShipments: () => {},
      onTrackShipmentForOrder: () => {},
      onGenerateLabels: () => {},
      onDownloadZpl: () => {},
      onDownloadZplForOrder: () => {},
      onLabelMappingConfigChange: () => {},
      onLabelPreviewOverridesChange: () => {},
      onMarkPrinted: () => {},
      onMarkPrintedForOrder: () => {},
      onMarkHandedToCargo: () => {},
      ...extraProps,
    }),
  )
}

/* ═══ A — KALDIRILAN SEÇENEK ══════════════════════════════════════════ */

test('FILTER-AUDIT-A: "Etiket Olusturuldu" GORUNUR bir secenek DEGILDIR', () => {
  assert.equal(
    options.ORDERS_STATUS_FILTER_OPTIONS.includes('Etiket Oluşturuldu'),
    false,
    'secenek listesinde KALMIS',
  )
  assert.doesNotMatch(
    ordersHtml(),
    /<option[^>]*value="Etiket Oluşturuldu"/,
    'dropdown markup\'inda KALMIS',
  )
})

test('FILTER-AUDIT-A2: rozet ve gecmis render destegi KALDIRILMADI', () => {
  // Eski bir kayit bu degeri tasiyorsa gorunmeye devam etmeli: yalniz
  // FILTRE secenegi kaldirildi.
  const badge = readFileSync(join(root, 'src/components/StatusBadge.tsx'), 'utf8')
  assert.match(badge, /Etiket Oluşturuldu/)
  const status = readFileSync(join(root, 'src/utils/orderStatus.ts'), 'utf8')
  assert.match(status, /Etiket Oluşturuldu/)
})

/* ═══ B — DIGER CANONICAL SECENEKLER DURUYOR ══════════════════════════ */

test('FILTER-AUDIT-B: canonical statu secenekleri HALA gorunur', () => {
  const expected = [
    'all', 'Yeni',
    'Created', 'Picking', 'Invoiced', 'Shipped', 'Delivered',
    'Cancelled', 'Returned', 'UnDelivered', 'UnSupplied',
    'AtCollectionPoint', 'Unknown',
    'Ön Kayıt Yapıldı', 'Kargo Oluşturuldu', 'Etiket Hazır',
    'Etiket Basıldı', 'Hata',
  ]
  assert.deepEqual([...options.ORDERS_STATUS_FILTER_OPTIONS], expected)
  const html = ordersHtml()
  for (const value of expected) {
    assert.match(
      html,
      new RegExp(`<option[^>]*value="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      `${value} secenegi KAYIP`,
    )
  }
})

/* ═══ D / E — "Hata" KALICI + GECICI ══════════════════════════════════ */

test('FILTER-AUDIT-D: kalici operationStatus=ERROR, Statu:Hata ile BULUNUR', () => {
  // Sync iptal/iade paketlerine ERROR yazar; `status` kolonu DB\'de YOKTUR,
  // yenilemeden sonra order.status yeniden \'Yeni\'dir.
  const persisted = order({
    id: 'err-persisted', packageId: 'PKG-ERR', orderNumber: 'ERR-1',
    status: 'Yeni', marketplaceStatus: 'Cancelled', operationStatus: 'ERROR',
  })
  const rows = visible([persisted], { operationStatusFilter: 'Hata' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'err-persisted')
})

test('FILTER-AUDIT-E: gecici status="Hata" CALISMAYA DEVAM EDER', () => {
  const transient = order({
    id: 'err-transient', packageId: 'PKG-TR', orderNumber: 'TR-1',
    status: 'Hata', operationStatus: 'SURAT_BARCODE_FAILED',
  })
  const rows = visible([transient], { operationStatusFilter: 'Hata' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'err-transient')
})

test('FILTER-AUDIT-D2: alias ASIRI GENIS DEGIL — hatasiz siparis eslesmez', () => {
  const healthy = order({ id: 'ok', packageId: 'PKG-OK', orderNumber: 'OK-1' })
  assert.equal(visible([healthy], { operationStatusFilter: 'Hata' }).length, 0)
  // Diger statu secenekleri alias YUZUNDEN genislemedi.
  assert.equal(visible([healthy], { operationStatusFilter: 'Created' }).length, 1)
  assert.equal(visible([healthy], { operationStatusFilter: 'Delivered' }).length, 0)
})

/* ═══ F — RENAME YALNIZ SUNUM ═════════════════════════════════════════ */

test('FILTER-AUDIT-F: labelReady DEGERI ayni, gorunen ad "Etiket Hazir"', () => {
  const entry = options.ORDERS_OPERATION_TAB_OPTIONS.find(
    (item) => item.key === 'labelReady',
  )
  assert.ok(entry, 'labelReady secenegi KAYBOLMUS')
  assert.equal(entry.key, 'labelReady', 'internal value DEGISMEMELI')
  assert.equal(entry.label, 'Etiket Hazır')
  const html = ordersHtml()
  assert.match(html, /<option[^>]*value="labelReady"[^>]*>Etiket Hazır</)
  assert.doesNotMatch(html, /Etiket Basılacak/)
  // Islem Durumu secenek KUMESI degismedi.
  assert.deepEqual(
    options.ORDERS_OPERATION_TAB_OPTIONS.map((item) => item.key),
    [
      'all', 'barcodePending', 'shipmentPending', 'suratVerificationPending',
      'labelReady', 'labelPrinted', 'archive', 'externallyProcessed',
    ],
  )
})

/* ═══ G — OPTGROUP YALNIZ SUNUM ═══════════════════════════════════════ */

test('FILTER-AUDIT-G1: gruplar ana diziden TURER, ikinci liste YOK', () => {
  const grouped = options.ORDERS_STATUS_FILTER_GROUPS.flatMap((group) =>
    options.ordersStatusFilterOptionsForGroup(group.key),
  )
  const all = options.ORDERS_STATUS_FILTER_OPTIONS.filter((item) => item !== 'all')
  // TAM BOLUNME: her secenek TAM BIR gruba duser, fazlalik/eksik YOK.
  assert.deepEqual([...grouped].sort(), [...all].sort())
  assert.equal(new Set(grouped).size, grouped.length, 'duplicate option')
  assert.equal(options.resolveOrdersStatusFilterGroup('all'), null)
})

test('FILTER-AUDIT-G2: optgroup markup VAR ve value\'lar DEGISMEDI', () => {
  const html = ordersHtml()
  assert.match(html, /<optgroup label="Pazaryeri Durumu">/)
  assert.match(html, /<optgroup label="CargoFlow İş Akışı">/)
  for (const value of options.ORDERS_STATUS_FILTER_OPTIONS) {
    assert.match(
      html,
      new RegExp(`value="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    )
  }
})

test('FILTER-AUDIT-G3: gruplama FILTRE SONUCUNU degistirmez', () => {
  const rows = [
    order({ id: 'a', packageId: 'P-A', orderNumber: 'A', marketplaceStatus: 'Created' }),
    order({ id: 'b', packageId: 'P-B', orderNumber: 'B', marketplaceStatus: 'Picking' }),
    order({ id: 'c', packageId: 'P-C', orderNumber: 'C', marketplaceStatus: 'Delivered' }),
  ]
  // Gruba giren her secenek, gruptan BAGIMSIZ olarak ayni sonucu verir.
  for (const value of ['Created', 'Picking', 'Delivered']) {
    const result = visible(rows, { operationStatusFilter: value })
    assert.equal(result.length, 1, `${value} sonucu degisti`)
    assert.equal(result[0].marketplaceStatus, value)
  }
})

/* ═══ H / I / J — YENİ ETİKET DURUM SEMANTİĞİ ═════════════════════════ */

// GERCEK dogrulanmis Surat gonderisi sekli (label-flow fixture'i ile ayni):
// `verifySuratShipment` bunu VERIFIED sayar, yani artefakt GERCEKTEN hazirdir.
const PREPARED_BARCODE_RAW = [
  '^XA',
  '^FO20,20^A0N,30,30^FDSURAT LABEL^FS',
  '^FO20,70^BCN,80,Y,N,N^FD01231201025^FS',
  '^XZ',
].join(String.fromCharCode(10))
const preparedShipment = {
  id: 'shp-1', provider: 'surat-kargo', serviceMode: 'ORTAK_BARKOD_SOAP',
  operationName: 'OrtakBarkodOlustur', trackingNumber: '25220148446193',
  kargoTakipNo: '25220148446193', tNo: '25220148446193',
  barcode: '01231201025', barcodeRaw: PREPARED_BARCODE_RAW,
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
    BarcodeRaw: PREPARED_BARCODE_RAW,
    parsedResponse: {
      KargoTakipNo: '25220148446193', TNo: '25220148446193',
      Barcode: '01231201025', BarcodeRaw: PREPARED_BARCODE_RAW,
      Barkod: '01231201025', requestReference: 'PKG123',
    },
  },
}

const stageOf = (o) =>
  classifyDashboardOperationStage(withDerivedOperationStatus(o)).label

test('FILTER-AUDIT-H: worker artefakti READY + userActivated=false → Barkod Bekliyor', () => {
  const prepared = order({
    id: 'prep', packageId: 'PKG123', orderNumber: 'ORDER123',
    cargoTrackingNumber: '7270033563324593',
    shipment: preparedShipment,
  })
  // ON KOSUL: artefakt GERCEKTEN hazir — gizlenen sey hazirlik degil,
  // KULLANICI durumudur.
  assert.equal(
    withDerivedOperationStatus(prepared).operationStatus, 'LABEL_READY',
    'projeksiyon artefakttan LABEL_READY TURETMELI (kusurun kaynagi)',
  )
  assert.equal(stageOf(prepared), 'Barkod Bekliyor')
  // Islem Durumu filtresi de ayni yanıtı verir (tek siniflandirici).
  assert.equal(
    visible([prepared], { operationTabFilter: 'barcodePending' }).length, 1,
  )
  assert.equal(visible([prepared], { operationTabFilter: 'labelReady' }).length, 0)
})

test('FILTER-AUDIT-I: userActivated=true + printed=false → Etiket Hazır', () => {
  const activated = order({
    id: 'act', packageId: 'PKG123', orderNumber: 'ORDER123',
    cargoTrackingNumber: '7270033563324593',
    shipment: preparedShipment,
    userLabelActivatedAt: '2026-09-02T10:00:00.000Z',
  })
  assert.equal(stageOf(activated), 'Etiket Hazır')
  assert.equal(visible([activated], { operationTabFilter: 'labelReady' }).length, 1)
  assert.equal(
    visible([activated], { operationTabFilter: 'barcodePending' }).length, 0,
  )
})

test('FILTER-AUDIT-J: printed=true → Etiket Basıldı', () => {
  const printed = order({
    id: 'prn', packageId: 'PKG123', orderNumber: 'ORDER123',
    cargoTrackingNumber: '7270033563324593',
    shipment: preparedShipment,
    labelStatus: 'PRINTED',
    label: { printedAt: '2026-09-02T11:00:00.000Z' },
  })
  assert.equal(stageOf(printed), 'Etiket Basıldı')
  assert.equal(visible([printed], { operationTabFilter: 'labelPrinted' }).length, 1)
})

/* ═══ K — DIGER FILTRELER DEGISMEDI ═══════════════════════════════════ */

test('FILTER-AUDIT-K1: pazaryeri / kargo / tarih / cok cesitli / ayni urun secenekleri AYNEN duruyor', () => {
  const page = readFileSync(join(root, 'src/pages/OrdersPage.tsx'), 'utf8')
  for (const value of ['Trendyol', 'Hepsiburada', 'N11', 'Shopify', 'Manuel']) {
    assert.ok(page.includes(`'${value}'`), `Pazaryeri ${value} KAYIP`)
  }
  for (const value of ['Sürat Kargo', 'Bekliyor', 'Hatalı']) {
    assert.ok(page.includes(`'${value}'`), `Kargo ${value} KAYIP`)
  }
  for (const key of ['all', 'today', 'yesterday', 'last3', 'last7', 'last30', 'custom']) {
    assert.ok(page.includes(`key: '${key}'`), `Tarih ${key} KAYIP`)
  }
  for (const value of ['multi', 'single', 'repeated', 'unique']) {
    assert.ok(page.includes(`value="${value}"`), `${value} secenegi KAYIP`)
  }
  // Serbest metin filtreleri de duruyor.
  for (const label of [
    'Şehir', 'İlçe', 'Müşteri', 'Ürün', 'Sipariş No', 'Kargo Fişi No',
  ]) {
    assert.ok(page.includes(`<span>${label}</span>`), `${label} filtresi KAYIP`)
  }
})

test('FILTER-AUDIT-K2: diger filtrelerin SORGU davranisi degismedi', () => {
  const rows = [
    order({ id: 'x', packageId: 'P-X', orderNumber: 'X-1', city: 'İstanbul', district: 'Kadıköy' }),
    order({ id: 'y', packageId: 'P-Y', orderNumber: 'Y-1', city: 'Ankara', district: 'Çankaya' }),
    order({
      id: 'z', packageId: 'P-Z', orderNumber: 'Z-1',
      city: 'İzmir', district: 'Konak',
      items: [
        { id: 'i1', productName: 'A', barcode: 'B1', quantity: 1 },
        { id: 'i2', productName: 'B', barcode: 'B2', quantity: 1 },
      ],
    }),
  ]
  assert.equal(visible(rows, { cityFilter: 'İstanbul' }).length, 1)
  assert.equal(visible(rows, { districtFilter: 'Çankaya' }).length, 1)
  assert.equal(visible(rows, { marketplaceFilter: 'Trendyol' }).length, 3)
  assert.equal(visible(rows, { marketplaceFilter: 'N11' }).length, 0)
  assert.equal(visible(rows, { multiProductFilter: 'multi' }).length, 1)
  assert.equal(visible(rows, { multiProductFilter: 'single' }).length, 2)
  assert.equal(visible(rows, { customerQuery: 'Ada' }).length, 3)
  assert.equal(visible(rows, { orderNumberQuery: 'Y-1' }).length, 1)
  assert.equal(visible(rows, { productQuery: 'B2' }).length, 1)
  assert.equal(visible(rows, { cargoFilter: 'Bekliyor' }).length, 3)
})

/* ═══ KAYIT ══════════════════════════════════════════════════════════ */

test('FILTER-AUDIT-REG: bu dosya test:surat icinde KAYITLI', () => {
  const registry = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const files = Array.isArray(registry) ? registry : registry.files
  assert.ok(files.includes('server/orders-filter-audit-flow.test.mjs'))
})
