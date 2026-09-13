import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

// ═══ "BARKOD OLUŞTUR" TIKLAMASININ YENİ ANLAMI ═══════════════════════════
//
// Artık YALNIZ taşıyıcı create demek DEĞİLDİR:
//     "Bu siparişin etiketini kullanıcı iş akışına AL."
//
// Arka plan worker'ı artefaktı ÖNCEDEN hazırladıysa tıklama:
//     taşıyıcı create = 0 · pazaryeri mutasyonu = 0 · yeni artefakt = 0
// ve YALNIZ kullanıcı aktivasyonunu yazar. Artefakt yoksa MEVCUT manuel
// create yolu aynen çalışır ve başarıyla biterse aktivasyon da yazılır:
// iki yol AYNI kullanıcı sonucunu üretir.
//
// Bu dosya provider çağrılarını SAYARAK ölçer — "herhalde çağrılmamıştır"
// demez.

const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})
test.after(() => vite.close())

const { OrderWorkflowService } = await vite.ssrLoadModule(
  '/src/services/orderWorkflowService.ts',
)
const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
  '/src/utils/orderClassification.ts',
)
const { withDerivedOperationStatus, canCreateShipment } =
  await vite.ssrLoadModule('/src/utils/orderStatus.ts')
const {
  canActivateLabelWorkflow,
  hasPreparedLabelArtifact,
  resolveLabelWorkflowActivation,
} = await vite.ssrLoadModule('/src/utils/labelWorkflowActivation.ts')

const stageOf = (order) =>
  classifyDashboardOperationStage(withDerivedOperationStatus(order)).label

function buildOrder(over = {}) {
  return {
    id: 'order-1', marketplace: 'Trendyol', externalOrderId: 'ORDER123',
    orderNumber: 'ORDER123', packageId: 'PKG123',
    cargoTrackingNumber: '7270033563324593',
    marketplaceStatus: 'Created', operationStatus: 'NEW', source: 'real',
    status: 'Yeni', customerName: 'Test Alıcı', customerPhone: '5550000000',
    address: 'Test adresi', city: 'İstanbul', district: 'Kadıköy',
    totalAmount: 100, desi: 2, desiSource: 'manual',
    createdAt: '2026-09-01T08:00:00.000Z',
    items: [{
      id: 'item-1', productName: 'Ürün A', sku: 'SKU-A', barcode: 'PRODUCT-A',
      quantity: 2, variantAttributes: [],
    }],
    ...over,
  }
}

function buildShipment() {
  const barcodeRaw =
    '^XA\n^FO20,20^A0N,30,30^FDSURAT LABEL^FS\n^FO20,70^BCN,80,Y,N,N^FD01231201025^FS\n^XZ'
  const parsedResponse = {
    KargoTakipNo: '25220148446193', TNo: '25220148446193',
    Barcode: '01231201025', BarcodeRaw: barcodeRaw, Barkod: '01231201025',
    requestReference: 'PKG123',
  }
  return {
    id: 'shp-1', provider: 'surat-kargo', serviceMode: 'ORTAK_BARKOD_SOAP',
    operationName: 'OrtakBarkodOlustur', trackingNumber: '25220148446193',
    kargoTakipNo: '25220148446193', tNo: '25220148446193',
    barcode: '01231201025', barcodeRaw,
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
      parsedResponse, BarcodeRaw: barcodeRaw,
    },
  }
}

function buildConfig() {
  return {
    trendyol: {
      sellerId: '', apiKey: '', apiSecret: '', environment: 'prod',
      userAgentName: '',
    },
    surat: {
      kullaniciAdi: 'TEST', sifre: 'TEST', firmaId: '', ortam: 'test',
      serviceType: 'OrtakBarkodOlusturSoap',
      createShipmentPath: '/api/OrtakBarkodOlustur',
      trackingServiceType: 'KargoTakipHareketDetayiSoap',
      trackingPath: '/api/KargoTakipHareketDetayi',
    },
  }
}

// Servis tarayıcı deposuna yazar (`persistOrders`). Node'da yalnız minimal
// bir localStorage kabı gerekir; iş mantığı DEĞİŞMEZ.
const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
}
test.afterEach(() => storage.clear())

/** Taşıyıcı create çağrılarını SAYAN servis. */
function makeService() {
  const calls = { createShipment: 0 }
  const service = new OrderWorkflowService(
    {},
    {
      createShipment: async () => {
        calls.createShipment += 1
        return buildShipment()
      },
    },
    {},
    {},
    { append: () => [] },
  )
  return { service, calls }
}

/**
 * ARKA PLANDA HAZIRLANMIŞ sipariş: projeksiyon `operationStatus`ü artefakttan
 * LABEL_READY'ye TÜRETİR, ama kullanıcı aktivasyon damgası YOKTUR.
 */
function preparedOrder(over = {}) {
  return withDerivedOperationStatus(
    buildOrder({ shipment: buildShipment(), ...over }),
  )
}

/* ═══ ÖN KOŞUL ═══════════════════════════════════════════════════════ */

test('LABEL-UX-CLICK-0: hazirlanmis siparis "Etiket Hazir" DEGIL, aktive EDILEBILIR', () => {
  const order = preparedOrder()
  // Türetme gerçekten LABEL_READY üretiyor — kusurun kaynağı budur.
  assert.equal(order.operationStatus, 'LABEL_READY')
  assert.equal(hasPreparedLabelArtifact(order), true)
  assert.equal(resolveLabelWorkflowActivation(order).activated, false)
  assert.equal(stageOf(order), 'Barkod Bekliyor')
  // İkinci create AÇILMAZ ama buton AÇIK olmalı: aktivasyon yeteneği ayrı sorulur.
  assert.equal(canCreateShipment(order), false, 'ikinci tasiyici create ACILMAZ')
  assert.equal(canActivateLabelWorkflow(order), true, 'buton AKTIF olmali')
})

/* ═══ LABEL-UX-STATE-10 — HIZLI YOL ═══════════════════════════════════ */

test('LABEL-UX-STATE-10: hazir artefakt + tiklama → tasiyici cagrisi 0', async () => {
  const { service, calls } = makeService()
  const order = preparedOrder()

  const before = JSON.stringify(order.shipment)
  const result = await service.createShipments([order], [order.id], buildConfig())
  const next = result.orders[0]

  // AĞ DELTASI = 0.
  assert.equal(calls.createShipment, 0, 'tasiyici create CAGRILMADI')
  // ARTEFAKT DELTASI = 0.
  assert.equal(JSON.stringify(next.shipment), before, 'artefakt DEGISMEDI')
  // KULLANICI DURUMU ilerledi.
  assert.equal(resolveLabelWorkflowActivation(next).activated, true)
  assert.equal(stageOf(next), 'Etiket Hazır')
  // Sessiz "zaten oluşturulmuş" uyarısı DEĞİL, açık bir sonuç.
  assert.match(result.result.message, /is akisina alindi|iş akışına alındı/i)
  assert.doesNotMatch(result.result.message, /zaten oluşturulmuş/i)
})

/* ═══ LABEL-UX-STATE-4 — ARTEFAKT YOKKEN MEVCUT YOL ═══════════════════ */

test('LABEL-UX-STATE-4: artefakt YOK → mevcut manuel create yolu calisir ve aktive eder', async () => {
  const { service, calls } = makeService()
  const order = buildOrder()
  assert.equal(hasPreparedLabelArtifact(order), false)

  const result = await service.createShipments([order], [order.id], buildConfig())
  const next = result.orders[0]

  assert.equal(calls.createShipment, 1, 'mevcut create yolu KOSTU')
  assert.equal(resolveLabelWorkflowActivation(next).activated, true)
  assert.equal(stageOf(next), 'Etiket Hazır')
})

/* ═══ LABEL-UX-STATE-6 — ÇİFT TIKLAMA ════════════════════════════════ */

test('LABEL-UX-STATE-6c: cift tiklama → ikinci create YOK, damga OYNAMAZ', async () => {
  const { service, calls } = makeService()
  const first = await service.createShipments(
    [buildOrder()], ['order-1'], buildConfig(),
  )
  const afterFirst = first.orders[0]
  const stamp = resolveLabelWorkflowActivation(afterFirst).activatedAt
  assert.equal(calls.createShipment, 1)

  const second = await service.createShipments(
    [afterFirst], [afterFirst.id], buildConfig(),
  )
  const afterSecond = second.orders[0]

  assert.equal(calls.createShipment, 1, 'IKINCI tasiyici create YOK')
  assert.equal(
    resolveLabelWorkflowActivation(afterSecond).activatedAt, stamp,
    'aktivasyon ani KAYMAZ',
  )
  assert.equal(stageOf(afterSecond), 'Etiket Hazır')
})

/* ═══ LABEL-UX-STATE-9 — TOPLU İŞLEM SIZINTISI YOK ═══════════════════ */

test('LABEL-UX-STATE-9c: secilmeyen hazir siparis AKTIVE EDILMEZ', async () => {
  const { service, calls } = makeService()
  const selected = preparedOrder({ id: 'sel-1', packageId: 'PKG-SEL', orderNumber: 'SEL1' })
  const untouched = preparedOrder({ id: 'unt-1', packageId: 'PKG-UNT', orderNumber: 'UNT1' })

  const result = await service.createShipments(
    [selected, untouched], [selected.id], buildConfig(),
  )
  const nextSelected = result.orders.find((o) => o.id === 'sel-1')
  const nextUntouched = result.orders.find((o) => o.id === 'unt-1')

  assert.equal(calls.createShipment, 0)
  assert.equal(resolveLabelWorkflowActivation(nextSelected).activated, true)
  assert.equal(
    resolveLabelWorkflowActivation(nextUntouched).activated, false,
    'secilmeyen siparis artefakti yuzunden AKTIVE OLMAZ',
  )
  assert.equal(stageOf(nextUntouched), 'Barkod Bekliyor')
})

/* ═══ TERMİNAL SİPARİŞ — AKTİVASYON YOK ══════════════════════════════ */

test('LABEL-UX-CLICK-1: kargoya verilmis/teslim siparis AKTIVE EDILEMEZ', () => {
  for (const marketplaceStatus of ['Shipped', 'Delivered', 'Cancelled']) {
    const order = preparedOrder({ marketplaceStatus })
    assert.equal(
      canActivateLabelWorkflow(order), false,
      `${marketplaceStatus} icin aktivasyon ACILMAZ`,
    )
  }
})

/* ═══ KAYIT ═════════════════════════════════════════════════════════════ */

test('LABEL-UX-CLICK-REG: bu dosya test:surat icinde KAYITLI', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const registry = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const files = Array.isArray(registry) ? registry : registry.files
  assert.ok(files.includes('server/label-user-activation-flow.test.mjs'))
})
