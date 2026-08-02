import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

// REPRINT (tekrar yazdırma) çözümü — saf katman.
// Kök neden: ZebraZplLabelProvider.generateSingle her zaman ZPL'i YENİDEN üretiyor
// ve desi zorunlu tutuyordu; bu yüzden daha önce basılmış (LABEL_PRINTED) siparişte
// "Etiketi Yazdır" desi istiyordu. Düzeltme: KAYITLI taşıyıcı ZPL'i varsa doğrudan
// o basılır ve desi İSTENMEZ; desi doğrulaması YALNIZ ZPL üretilecekse (fresh
// create / kayıtlı ZPL yok) çalışır.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

async function withVite(t) {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  return vite
}

// Gerçek production shape: LABEL_PRINTED, desi=null, kayıtlı ZPL.
function reprintShipment(over = {}) {
  return {
    printEnabled: true,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    trackingNumber: '11820824092123',
    tNo: '11820824092123',
    kargoTakipNo: '11820824092123',
    barcode: '01252765588',
    barkodNo: '01252765588',
    barcodeValue: '01252765588',
    ozelKargoTakipNo: '7270034994447844',
    barcodeRaw: '^XA^FO20,20^FD01252765588^FS^XZ',
    ...over,
  }
}

function reprintOrder(over = {}) {
  return {
    id: 'order-11452948259',
    marketplace: 'Trendyol',
    orderNumber: '11452948259',
    packageId: 'PKG-11452948259',
    shipmentPackageId: 'PKG-11452948259',
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Hazırlanıyor',
    labelStatus: 'PRINTED',
    hasPrintableLabel: true,
    customerName: 'Test',
    address: 'Adres',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoTrackingNumber: '7270034994447844',
    cargoProviderName: 'Sürat Kargo',
    desi: null,
    items: [{ id: 'i1', productName: 'Ürün', quantity: 1, price: 100 }],
    shipment: reprintShipment(),
    ...over,
  }
}

test('REP-1: generateSingle LABEL_PRINTED + desi=null + kayıtlı ZPL → HATA ATMAZ, taşıyıcı ZPL kullanır', async (t) => {
  const vite = await withVite(t)
  const { ZebraZplLabelProvider } = await vite.ssrLoadModule(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const { defaultLabelTemplate } = await vite.ssrLoadModule(
    '/src/services/integrationConfigService.ts',
  )
  const provider = new ZebraZplLabelProvider()
  const order = reprintOrder()
  let label
  await assert.doesNotReject(async () => {
    label = await provider.generateSingle({
      order,
      shipment: order.shipment,
      template: defaultLabelTemplate,
      mappingConfig: {},
    })
  })
  // Reprint desi İSTEMEDEN etiket üretti (desi=null taşınır).
  assert.equal(label.desi, null)
  assert.ok(label.zplContent.startsWith('^XA'))
  // Canonical barkod DEĞİŞMEZ (yeni create/barkod yok).
  assert.equal(label.barcodeValue, '01252765588')
})

test('REP-2: generateSingle kayıtlı ZPL YOK + desi=null → desi hatası (fresh-create korunur)', async (t) => {
  const vite = await withVite(t)
  const { ZebraZplLabelProvider } = await vite.ssrLoadModule(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const { defaultLabelTemplate } = await vite.ssrLoadModule(
    '/src/services/integrationConfigService.ts',
  )
  const provider = new ZebraZplLabelProvider()
  const order = reprintOrder({ shipment: reprintShipment({ barcodeRaw: '' }) })
  await assert.rejects(
    async () =>
      provider.generateSingle({
        order,
        shipment: order.shipment,
        template: defaultLabelTemplate,
        mappingConfig: {},
      }),
    // Desi artık sipariş bazında GİRİLMEZ; kaynak Ayarlar'daki "Varsayılan
    // Gönderi Desisi"dir. Tanımlı değilse fresh-create BLOKLANIR ve kullanıcı
    // Ayarlar'a yönlendirilir (fresh-create koruması aynen sürüyor).
    /Ayarlar/,
  )
})

test('REP-3: generateSingle kayıtlı ZPL var + desi=DEĞER → yine kayıtlı ZPL kullanılır (reprint create çağırmaz)', async (t) => {
  const vite = await withVite(t)
  const { ZebraZplLabelProvider } = await vite.ssrLoadModule(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const { defaultLabelTemplate } = await vite.ssrLoadModule(
    '/src/services/integrationConfigService.ts',
  )
  const provider = new ZebraZplLabelProvider()
  const order = reprintOrder({ desi: 3 })
  const label = await provider.generateSingle({
    order,
    shipment: order.shipment,
    template: defaultLabelTemplate,
    mappingConfig: {},
  })
  // Kayıtlı barkod korunur; yeni create/barkod üretilmez.
  assert.equal(label.barcodeValue, '01252765588')
  assert.ok(label.zplContent.startsWith('^XA'))
})

test('REP-4: resolvePersistedLabelArtifact — barcodeRaw varsa zpl + source döner', async (t) => {
  const vite = await withVite(t)
  const { resolvePersistedLabelArtifact, isReprintEligible } =
    await vite.ssrLoadModule('/src/utils/persistedLabel.ts')
  const order = reprintOrder()
  const artifact = resolvePersistedLabelArtifact(order)
  assert.equal(artifact.hasPrintableLabel, true)
  assert.equal(artifact.zpl, order.shipment.barcodeRaw)
  assert.equal(artifact.source, 'order.shipment.barcodeRaw')
  assert.equal(isReprintEligible(order), true)
})

test('REP-5: resolvePersistedLabelArtifact — hasPrintableLabel=true ama ham ZPL yok → zpl=null, pending-fetch (etiket yok DEĞİL)', async (t) => {
  const vite = await withVite(t)
  const { resolvePersistedLabelArtifact } = await vite.ssrLoadModule(
    '/src/utils/persistedLabel.ts',
  )
  const order = reprintOrder({ shipment: reprintShipment({ barcodeRaw: '' }) })
  const artifact = resolvePersistedLabelArtifact(order)
  assert.equal(artifact.hasPrintableLabel, true)
  assert.equal(artifact.zpl, null)
  assert.equal(artifact.source, 'pending-fetch')
})

test('REP-6: isReprintEligible — LABEL_READY/LABEL_PRINTED + etiket → true; NEW → false', async (t) => {
  const vite = await withVite(t)
  const { isReprintEligible } = await vite.ssrLoadModule(
    '/src/utils/persistedLabel.ts',
  )
  assert.equal(
    isReprintEligible(reprintOrder({ operationStatus: 'LABEL_READY' })),
    true,
  )
  assert.equal(
    isReprintEligible(reprintOrder({ operationStatus: 'LABEL_PRINTED' })),
    true,
  )
  assert.equal(
    isReprintEligible(
      reprintOrder({
        operationStatus: 'NEW',
        hasPrintableLabel: false,
        shipment: undefined,
      }),
    ),
    false,
  )
})

test('REP-7: suratPrintEligibility — kayıtlı ZPL ile canPrint + "Etiket hazır ve yazdırılabilir." (Serendip/kabul metni yok)', async (t) => {
  const vite = await withVite(t)
  const { resolveSuratPrintEligibility } = await vite.ssrLoadModule(
    '/src/utils/suratPrintEligibility.ts',
  )
  const order = reprintOrder()
  const eligibility = resolveSuratPrintEligibility(order)
  assert.equal(eligibility.canPrint, true)
  assert.equal(eligibility.statusLabel, 'Etiket hazır ve yazdırılabilir.')
  assert.ok(!/Serendip|kabul bekleniyor|fiziksel Sürat kabul/i.test(eligibility.reason))
  assert.ok(!/Serendip|kabul bekleniyor|fiziksel Sürat kabul/i.test(eligibility.statusLabel))
})

test('REP-8: statusPresentation — LABEL_PRINTED ve LABEL_READY mesajları güncel', async (t) => {
  const vite = await withVite(t)
  const { mapOperationStatus } = await vite.ssrLoadModule(
    '/src/utils/statusPresentation.ts',
  )
  const printed = mapOperationStatus(
    reprintOrder({
      operationStatus: 'LABEL_PRINTED',
      labelStatus: 'PRINTED',
      label: { printedAt: '2026-07-26T10:00:00Z' },
    }),
  )
  assert.equal(
    printed.description,
    'Etiket basıldı. Gerektiğinde tekrar yazdırabilirsiniz.',
  )
  const ready = mapOperationStatus(
    reprintOrder({ operationStatus: 'LABEL_READY', labelStatus: 'READY' }),
  )
  assert.equal(ready.description, 'Etiket hazır ve yazdırılabilir.')
})

test('REP-9: UI kaynak taraması — fiziksel kabul / Serendip metinleri kullanıcı yüzeyinden kaldırıldı', () => {
  const files = [
    'src/utils/suratPrintEligibility.ts',
    'src/utils/statusPresentation.ts',
    'src/utils/suratShipmentTimeline.ts',
    'src/components/OrderDetailDrawer.tsx',
  ]
  const forbidden = [
    'fiziksel Sürat kabulü bekleniyor',
    'Serendip kaydı tesellümden sonra',
    'Serendip kaydı doğrulanmadan yazdırılamaz',
    'Kabul Bekleniyor',
  ]
  for (const file of files) {
    const content = readFileSync(join(root, file), 'utf8')
    for (const phrase of forbidden) {
      assert.ok(
        !content.includes(phrase),
        `${file} hâlâ "${phrase}" içeriyor`,
      )
    }
  }
})

test('REP-10: LABEL_READY kullanıcı mesajı "Etiket hazır ve yazdırılabilir."', async (t) => {
  const vite = await withVite(t)
  const { resolveSuratPrintEligibility } = await vite.ssrLoadModule(
    '/src/utils/suratPrintEligibility.ts',
  )
  const order = reprintOrder({ operationStatus: 'LABEL_READY' })
  const eligibility = resolveSuratPrintEligibility(order)
  assert.equal(eligibility.statusLabel, 'Etiket hazır ve yazdırılabilir.')
})
