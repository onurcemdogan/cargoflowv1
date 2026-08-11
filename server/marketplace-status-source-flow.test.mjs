import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

// "KARGOYA VERİLDİ" KAYNAK SÖZLEŞMESİ.
//
// Kanıtlanan zincir (dosya/fonksiyon):
//   Trendyol sync payload
//     → server/index.mjs normalizeTrendyolOrder* → order.marketplaceStatus
//     → src/utils/shipmentStatus.ts resolveMarketplaceStatus('Shipped')
//         → { shipped: true, operationStatus: 'SHIPPED', label: 'Kargoya Verildi' }
//       ve resolveOrderStatus → statusSource: 'marketplace',
//                               sourceLabel: order.marketplace ("Trendyol")
//     → src/utils/orderClassification.ts classifyOrderForTabs
//         isHandedToCargo = resolvedStatus.shipped
//                        || marketplaceStatus ∈ {Shipped, AtCollectionPoint}
//                        || shipment.shippedAt/handedToCargoAt
//                        || operationStatus ∈ {shipped, handedtocargo}
//     → resolveDashboardOperationStage → 'handedToCargo' (labelPrinted'ten ÖNCE)
//     → UI "Kargoya Verildi"
//
// SÖZLEŞMENİN ÖZÜ: yerel Sürat gönderisinin VARLIĞI bu zincirin parçası
// DEĞİLDİR. Trendyol shipment state'i otoriterdir.

let vite

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
})

after(async () => {
  await vite?.close()
})

const load = (path) => vite.ssrLoadModule(path)
const CLASSIFICATION = '/src/utils/orderClassification.ts'
const STATUS = '/src/utils/shipmentStatus.ts'

/**
 * PRODUCTION FIXTURE — PII YOK.
 * packageId 4065450430 / orderNumber 11492802204 gerçek vakasıdır: sipariş
 * CargoFlow ile DEĞİL harici sağlayıcı (DuruSoft) ile işlenmiştir, bu yüzden
 * YEREL SÜRAT GÖNDERİSİ YOKTUR. Müşteri adı/adres/telefon fixture'a GİRMEZ.
 */
function order(overrides = {}) {
  return {
    id: 'ord-4065450430',
    orderNumber: '11492802204',
    packageId: '4065450430',
    marketplace: 'Trendyol',
    marketplaceStatus: 'Shipped',
    status: 'Yeni',
    orderDate: '2026-05-02T08:00:00.000Z',
    items: [{ id: 'l1', productName: 'Urun', quantity: 1 }],
    // YEREL SÜRAT GÖNDERİSİ YOK (harici etiket sağlayıcısı ile işlendi).
    shipment: undefined,
    ...overrides,
  }
}

async function stageOf(input) {
  const { classifyOrderForTabs, resolveDashboardOperationStage } =
    await load(CLASSIFICATION)
  const state = classifyOrderForTabs(input)
  return { state, stage: resolveDashboardOperationStage(state) }
}

test('MARKETPLACE-STATUS-1: Picking → handedToCargo FALSE', async () => {
  const { state, stage } = await stageOf(order({ marketplaceStatus: 'Picking' }))
  assert.equal(state.isHandedToCargo, false)
  assert.notEqual(stage, 'handedToCargo')
})

test('MARKETPLACE-STATUS-2: Picking + LABEL_PRINTED → handedToCargo FALSE', async () => {
  // ETİKET BASILDI ≠ KARGOYA VERİLDİ. CargoFlow'un etiket üretmesi/basması
  // pazaryeri shipment state'i ÜRETMEZ.
  const { state, stage } = await stageOf(
    order({
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      labelStatus: 'PRINTED',
    }),
  )
  assert.equal(state.isHandedToCargo, false, 'yerel baskı kargoya verme DEĞİLDİR')
  assert.equal(state.isLabelPrinted, true)
  assert.equal(stage, 'labelPrinted')
})

test('MARKETPLACE-STATUS-3: Shipped + YEREL SÜRAT GÖNDERİSİ YOK → handedToCargo TRUE, kaynak Trendyol', async () => {
  const { state, stage } = await stageOf(order())
  assert.equal(state.isHandedToCargo, true)
  assert.equal(stage, 'handedToCargo')

  const { resolveOrderStatus } = await load(STATUS)
  const resolved = resolveOrderStatus(order())
  assert.equal(resolved.shipped, true)
  assert.equal(resolved.label, 'Kargoya Verildi')
  assert.equal(resolved.operationStatus, 'SHIPPED')
  assert.equal(resolved.statusSource, 'marketplace', 'kaynak pazaryeri olmalı')
  assert.equal(resolved.sourceLabel, 'Trendyol')
  assert.equal(resolved.shippedDetectedFrom, 'marketplaceStatus.Shipped')
})

test('MARKETPLACE-STATUS-4: Delivered → delivered', async () => {
  const { state, stage } = await stageOf(
    order({ marketplaceStatus: 'Delivered' }),
  )
  assert.equal(state.isDelivered, true)
  assert.equal(stage, 'delivered')
})

test('MARKETPLACE-STATUS-5: Cancelled / Returned / UnDelivered / UnSupplied → canceledOrReturned', async () => {
  for (const marketplaceStatus of [
    'Cancelled',
    'Returned',
    'UnDelivered',
    'UnSupplied',
  ]) {
    const { state, stage } = await stageOf(order({ marketplaceStatus }))
    assert.equal(
      state.isCanceledOrReturned,
      true,
      `${marketplaceStatus} iptal/iade sayılmalı`,
    )
    assert.equal(stage, 'canceledOrReturned', marketplaceStatus)
  }
})

test('MARKETPLACE-STATUS-6: DuruSoft üretim vakası — Shipped, yerel Sürat doğrulaması OLMASA DA kazanır', async () => {
  // Gerçek vakada Sürat doğrulaması şu değerleri üretir:
  //   verifiedShipment=false · hasSuratShipment=false
  //   hasTrackingQuery=false · hasSuratTrackingNumber=false
  //   matchReason="Sürat gönderisi oluşturulmadı" · takip no boş
  // Bu NORMALDİR ve Trendyol'un otoriter shipment state'ini GEÇERSİZ KILMAZ.
  const { verifySuratShipment } = await load('/src/utils/suratVerification.ts')
  const fixture = order()
  const verification = verifySuratShipment(fixture)
  assert.equal(verification.verifiedShipment, false, 'yerel Sürat gönderisi YOK')
  assert.ok(!verification.barcodeRaw, 'yerel ZPL yok')

  const { state, stage } = await stageOf(fixture)
  assert.equal(state.isHandedToCargo, true, 'Trendyol Shipped otoriterdir')
  assert.equal(stage, 'handedToCargo')
  assert.equal(state.isLabelReady, false)
  assert.equal(state.isLabelPrinted, false)
})

test('MARKETPLACE-STATUS-7: AtCollectionPoint da kargoya verilmiş sayılır', async () => {
  const { state, stage } = await stageOf(
    order({ marketplaceStatus: 'AtCollectionPoint' }),
  )
  assert.equal(state.isHandedToCargo, true)
  assert.equal(stage, 'handedToCargo')
})

test('MARKETPLACE-STATUS-8: Created → handedToCargo FALSE', async () => {
  const { state } = await stageOf(order({ marketplaceStatus: 'Created' }))
  assert.equal(state.isHandedToCargo, false)
})

// ═══ "ŞİMDİ YENİLE" HARNESS ═══════════════════════════════════════════════
//
// CANLI DOĞRULAMA YAPILMADI (production Trendyol erişimi yok) — bu bölüm
// yalnız before/after SÖZLEŞMESİNİ kilitler. Canlı before/after ölçümü
// PENDING EXTERNAL VALIDATION olarak raporlanır.

async function refresh(beforeStatus, afterStatus) {
  const before = await stageOf(order({ marketplaceStatus: beforeStatus }))
  const after = await stageOf(order({ marketplaceStatus: afterStatus }))
  return { before, after }
}

test('REFRESH-1: Picking → Picking, aşama DEĞİŞMEZ', async () => {
  const { before, after } = await refresh('Picking', 'Picking')
  assert.equal(before.state.isHandedToCargo, false)
  assert.equal(after.state.isHandedToCargo, false)
  assert.equal(before.stage, after.stage)
})

test('REFRESH-2: Picking → Shipped, handedToCargo OLUR', async () => {
  const { before, after } = await refresh('Picking', 'Shipped')
  assert.equal(before.state.isHandedToCargo, false)
  assert.equal(after.state.isHandedToCargo, true)
  assert.equal(after.stage, 'handedToCargo')
})

test('REFRESH-3: yalnız YEREL baskı olayı aşamayı ilerletmez', async () => {
  // Sync'ten gelen pazaryeri durumu aynı kalırken CargoFlow etiketi basarsa
  // "Kargoya Verildi" ÜRETİLMEZ.
  const before = await stageOf(order({ marketplaceStatus: 'Picking' }))
  const after = await stageOf(
    order({
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      labelStatus: 'PRINTED',
    }),
  )
  assert.equal(before.state.isHandedToCargo, false)
  assert.equal(after.state.isHandedToCargo, false)
  assert.equal(after.stage, 'labelPrinted')
})

test('SOURCE-LABEL: yerel operasyon durumu "Trendyol" kaynağı ÜRETMEZ', async () => {
  const { resolveOrderStatus } = await load(STATUS)
  // Pazaryeri statüsü eşlenemiyorsa kaynak YEREL operasyondur.
  const local = resolveOrderStatus(
    order({ marketplaceStatus: 'Picking', operationStatus: 'LABEL_PRINTED' }),
  )
  assert.equal(local.statusSource, 'localOperation')
  assert.equal(local.sourceLabel, 'CargoFlow')
  assert.equal(local.shipped, false, 'yerel durum kargoya verme ÜRETMEZ')

  // Pazaryeri Shipped ise kaynak pazaryeridir.
  const marketplace = resolveOrderStatus(order())
  assert.equal(marketplace.statusSource, 'marketplace')
  assert.equal(marketplace.sourceLabel, 'Trendyol')
})

// ═══ SSP FIZIKSEL KABUL SONRASI ASAMA ═════════════════════════════════════

test('SSP-REFRESH-1: taşıyıcı mutabakatı HANDED_TO_CARGO yazınca aşama kargoya verildi olur', async () => {
  // Golden vaka: Trendyol hâlâ Picking; kanonik operationStatus taşıyıcı
  // mutabakatıyla HANDED_TO_CARGO'ya geçmiş.
  const { state, stage } = await stageOf(
    order({
      orderNumber: '11493372619',
      packageId: '4065907241',
      marketplaceStatus: 'Picking',
      operationStatus: 'HANDED_TO_CARGO',
    }),
  )
  assert.equal(state.isHandedToCargo, true)
  assert.equal(stage, 'handedToCargo')
})

test('SSP-REFRESH-1b: LABEL_PRINTED + Picking hâlâ labelPrinted (kabul kanıtı yok)', async () => {
  const { state, stage } = await stageOf(
    order({
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      labelStatus: 'PRINTED',
    }),
  )
  assert.equal(state.isHandedToCargo, false)
  assert.equal(stage, 'labelPrinted')
})

// ═══ TRENDYOL → KARGOYA VERİLDİ (otoriter kaynak) ═════════════════════════
//
// ÜRÜN KARARI: SSP/Sürat fiziksel kabul mutabakatı ürün gereksinimi DEĞİL.
// "Kargoya Verildi" için otoriter kaynak TRENDYOL'dur. Yerel etiket durumu
// (LABEL_READY / LABEL_PRINTED) pazaryeri Shipped'i EZMEZ.

test('TRENDYOL-HANDED-1: LABEL_READY + Shipped → Kargoya Verildi', async () => {
  const { state, stage } = await stageOf(
    order({
      marketplaceStatus: 'Shipped',
      operationStatus: 'LABEL_READY',
      labelStatus: 'READY',
    }),
  )
  assert.equal(state.isHandedToCargo, true, 'yerel etiket durumu EZMEZ')
  assert.equal(stage, 'handedToCargo')
})

test('TRENDYOL-HANDED-2: LABEL_PRINTED + Shipped → Kargoya Verildi', async () => {
  const { state, stage } = await stageOf(
    order({
      marketplaceStatus: 'Shipped',
      operationStatus: 'LABEL_PRINTED',
      labelStatus: 'PRINTED',
    }),
  )
  assert.equal(state.isHandedToCargo, true)
  assert.equal(stage, 'handedToCargo')
})

test('TRENDYOL-HANDED-3: yeniden yükleme sonrası Kargoya Verildi KORUNUR', async () => {
  // Kalıcı alanlardan yeniden kurulan sipariş (reload) aynı aşamayı verir.
  const persisted = order({
    marketplaceStatus: 'Shipped',
    operationStatus: 'LABEL_PRINTED',
  })
  const first = await stageOf(persisted)
  const second = await stageOf({ ...persisted })
  assert.equal(first.stage, 'handedToCargo')
  assert.equal(second.stage, 'handedToCargo')
  // AtCollectionPoint de aynı sözleşmeye tabidir.
  const collection = await stageOf(
    order({ marketplaceStatus: 'AtCollectionPoint', operationStatus: 'LABEL_PRINTED' }),
  )
  assert.equal(collection.stage, 'handedToCargo')
})

test('TRENDYOL-HANDED-4: Picking → LABEL_READY/LABEL_PRINTED KORUNUR', async () => {
  const ready = await stageOf(
    order({
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_READY',
      labelStatus: 'READY',
    }),
  )
  assert.equal(ready.state.isHandedToCargo, false)
  assert.equal(ready.stage, 'labelReady')

  const printed = await stageOf(
    order({
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      labelStatus: 'PRINTED',
    }),
  )
  assert.equal(printed.state.isHandedToCargo, false)
  assert.equal(printed.stage, 'labelPrinted')
})
