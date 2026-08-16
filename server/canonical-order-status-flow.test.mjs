import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createServer } from 'vite'

// TEK CANONICAL sipariş statü sınıflandırması.
// Her sipariş TEK canonical operasyon kovasında bulunur; tablo rozeti (Tümü),
// sekmeler, detay ve Dashboard AYNI classifyCanonicalOrderStatus'ten beslenir.
// Yaşa dayalı 60 günlük otomatik Arşiv KALDIRILDI: yalnız explicit archived ARŞİV,
// yalnız güçlü kanıt (canonical durum / marketplace forward / taşıyıcı zaman
// damgası / yazdırılabilir etiket) canonical statüyü belirler.

const here = dirname(fileURLToPath(import.meta.url))

async function withVite(t) {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // Bu sunucular YALNIZ ssrLoadModule icin kullanilir; SSR'da bagimliliklar
    // zaten harici tutulur. Otomatik dep-scan bu yuzden GEREKSIZ ve ayni surecte
    // pes pese acilip kapanan sunucularda yarisa girip sonraki dosyayi dusuruyordu.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => vite.close())
  return vite
}

const OLD = '2026-01-01T00:00:00Z'
const RECENT = '2026-07-26T00:00:00Z'

function baseOrder(over = {}) {
  const id = over.id || 'x'
  return {
    id: `order-${id}`,
    marketplace: 'Trendyol',
    orderNumber: `114${id}`,
    packageId: `PKG-${id}`,
    shipmentPackageId: `PKG-${id}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    status: 'Yeni',
    customerName: 'Test',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoProviderName: 'Sürat Kargo',
    totalAmount: 100,
    createdAt: over.orderDate || RECENT,
    orderDate: over.orderDate || RECENT,
    desi: 2,
    items: [{ id: `i-${id}`, productName: 'Ürün', quantity: 1, price: 100 }],
    ...over,
  }
}
function printedShipment() {
  return { barcodeRaw: '^XA^FD01^FS^XZ', hasPrintableLabel: true }
}

async function classifier(vite) {
  return vite.ssrLoadModule('/src/utils/orderClassification.ts')
}

test('CAN-1: aktif Created + etiket yok → BARCODE_WAITING (başka kovada değil)', async (t) => {
  const { classifyCanonicalOrderStatus, classifyOrderForTabs } =
    await classifier(await withVite(t))
  const order = baseOrder({ id: '1', operationStatus: 'NEW' })
  assert.equal(classifyCanonicalOrderStatus(order).status, 'BARCODE_WAITING')
  const s = classifyOrderForTabs(order)
  assert.equal(s.isBarcodeWaiting, true)
  assert.equal(s.isLabelReady, false)
  assert.equal(s.isHandedToCargo, false)
  assert.equal(s.isArchived, false)
})

test('CAN-2: LABEL_READY → LABEL_READY (Barkod Bekliyor değil)', async (t) => {
  const { classifyCanonicalOrderStatus } = await classifier(await withVite(t))
  const order = baseOrder({ id: '2', operationStatus: 'LABEL_READY', labelStatus: 'READY' })
  assert.equal(classifyCanonicalOrderStatus(order).status, 'LABEL_READY')
  assert.equal(classifyCanonicalOrderStatus(order).label, 'Etiket Hazır')
})

test('CAN-3: LABEL_PRINTED + marketplace Hazırlanıyor → LABEL_PRINTED (korunur)', async (t) => {
  const { classifyCanonicalOrderStatus } = await classifier(await withVite(t))
  const order = baseOrder({
    id: '3',
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Hazırlanıyor',
    labelStatus: 'PRINTED',
    hasPrintableLabel: true,
    shipment: printedShipment(),
  })
  assert.equal(classifyCanonicalOrderStatus(order).status, 'LABEL_PRINTED')
})

test('CAN-4: SHIPPED/HANDED_TO_CARGO → HANDED_TO_CARGO (Etiket Basıldı/Barkod Bekliyor değil)', async (t) => {
  const { classifyCanonicalOrderStatus } = await classifier(await withVite(t))
  const shipped = baseOrder({ id: '4', marketplaceStatus: 'Shipped', operationStatus: 'HANDED_TO_CARGO' })
  assert.equal(classifyCanonicalOrderStatus(shipped).status, 'HANDED_TO_CARGO')
  assert.equal(classifyCanonicalOrderStatus(shipped).label, 'Kargoya Verildi')
})

test('CAN-5: DELIVERED → DELIVERED', async (t) => {
  const { classifyCanonicalOrderStatus } = await classifier(await withVite(t))
  const order = baseOrder({ id: '5', marketplaceStatus: 'Delivered', operationStatus: 'DELIVERED' })
  assert.equal(classifyCanonicalOrderStatus(order).status, 'DELIVERED')
})

test('CAN-6: CANCELLED/RETURNED → CANCELLED_OR_RETURNED (aktif kuyrukta değil)', async (t) => {
  const { classifyCanonicalOrderStatus, classifyOrderForTabs } =
    await classifier(await withVite(t))
  const cancelled = baseOrder({ id: '6', marketplaceStatus: 'Cancelled' })
  assert.equal(classifyCanonicalOrderStatus(cancelled).status, 'CANCELLED_OR_RETURNED')
  assert.equal(classifyOrderForTabs(cancelled).isOpenOperation, false)
  const returned = baseOrder({ id: '6r', marketplaceStatus: 'Returned' })
  assert.equal(classifyCanonicalOrderStatus(returned).status, 'CANCELLED_OR_RETURNED')
})

test('CAN-7: explicit archived=true → ARCHIVED', async (t) => {
  const { classifyCanonicalOrderStatus } = await classifier(await withVite(t))
  const order = baseOrder({ id: '7', archived: true, archivedAt: OLD })
  assert.equal(classifyCanonicalOrderStatus(order).status, 'ARCHIVED')
  assert.equal(classifyCanonicalOrderStatus(order).label, 'Arşiv')
})

test('CAN-8: yalnız eski tarih → otomatik Kargoya Verildi/Arşiv OLMAZ (BARCODE_WAITING)', async (t) => {
  const { classifyCanonicalOrderStatus } = await classifier(await withVite(t))
  const old = baseOrder({ id: '8', operationStatus: 'NEW', orderDate: OLD })
  const status = classifyCanonicalOrderStatus(old).status
  assert.equal(status, 'BARCODE_WAITING')
  assert.notEqual(status, 'ARCHIVED')
  assert.notEqual(status, 'HANDED_TO_CARGO')
})

test('CAN-9: yalnız 727/packageId/tracking referansı → Kargoya Verildi OLMAZ', async (t) => {
  const { classifyCanonicalOrderStatus, classifyOrderForTabs } =
    await classifier(await withVite(t))
  const order = baseOrder({
    id: '9',
    operationStatus: 'NEW',
    cargoTrackingNumber: '7270034994447844',
    shipment: { trackingNumber: '11820824092123', barcode: '01252765588' },
  })
  assert.notEqual(classifyCanonicalOrderStatus(order).status, 'HANDED_TO_CARGO')
  assert.equal(classifyOrderForTabs(order).isHandedToCargo, false)
})

test('CAN-10: LABEL_PRINTED + persisted ZPL → LABEL_PRINTED (reprint bozulmaz)', async (t) => {
  const { classifyCanonicalOrderStatus } = await classifier(await withVite(t))
  const order = baseOrder({
    id: '10',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    hasPrintableLabel: true,
    shipment: printedShipment(),
  })
  assert.equal(classifyCanonicalOrderStatus(order).status, 'LABEL_PRINTED')
})

test('CAN-11: Tümü tablo rozeti = canonical (mapOperationStatus === classifyCanonicalOrderStatus)', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus } = await classifier(vite)
  const { mapOperationStatus } = await vite.ssrLoadModule(
    '/src/utils/statusPresentation.ts',
  )
  const cases = [
    baseOrder({ id: 'a', operationStatus: 'NEW' }),
    baseOrder({ id: 'b', operationStatus: 'LABEL_READY', labelStatus: 'READY' }),
    baseOrder({ id: 'c', operationStatus: 'LABEL_PRINTED', labelStatus: 'PRINTED', hasPrintableLabel: true, shipment: printedShipment() }),
    baseOrder({ id: 'd', marketplaceStatus: 'Shipped', operationStatus: 'HANDED_TO_CARGO' }),
    baseOrder({ id: 'e', marketplaceStatus: 'Delivered', operationStatus: 'DELIVERED' }),
    baseOrder({ id: 'f', marketplaceStatus: 'Cancelled' }),
    baseOrder({ id: 'g', archived: true }),
  ]
  for (const order of cases) {
    assert.equal(
      mapOperationStatus(order).label,
      classifyCanonicalOrderStatus(order).label,
      `rozet canonical ile eşleşmeli: ${order.id}`,
    )
  }
})

test('CAN-12: Dashboard aşaması ve tablo rozeti aynı statüyü gösterir', async (t) => {
  const vite = await withVite(t)
  const { classifyDashboardOperationStage } = await classifier(vite)
  const { mapOperationStatus } = await vite.ssrLoadModule(
    '/src/utils/statusPresentation.ts',
  )
  const order = baseOrder({ id: '12', operationStatus: 'LABEL_PRINTED', marketplaceStatus: 'Hazırlanıyor', labelStatus: 'PRINTED', hasPrintableLabel: true, shipment: printedShipment() })
  assert.equal(
    classifyDashboardOperationStage(order).label,
    mapOperationStatus(order).label,
  )
})

test('CAN-13: Dashboard sayaçları canonical bucket sayılarıyla eşleşir', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const orders = [
    baseOrder({ id: 'bw', operationStatus: 'NEW' }),
    baseOrder({ id: 'lr', operationStatus: 'LABEL_READY', labelStatus: 'READY' }),
    baseOrder({ id: 'lp', operationStatus: 'LABEL_PRINTED', labelStatus: 'PRINTED', hasPrintableLabel: true, shipment: printedShipment() }),
    baseOrder({ id: 'hc', marketplaceStatus: 'Shipped', operationStatus: 'HANDED_TO_CARGO' }),
  ]
  const model = buildDashboardViewModel({
    orders,
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-26T12:00:00Z'),
  })
  assert.equal(model.operationalSummary.barcodeWaiting, 1)
  assert.equal(model.operationalSummary.labelReady, 1)
  assert.equal(model.operationalSummary.labelPrinted, 1)
  assert.equal(model.operationalSummary.handedToCargo, 1)
  // Tümü aktif+etiket öncesi = yalnız barcodeWaiting (1); label/handed hariç.
  assert.equal(model.operationalSummary.openOperations, 1)
})

test('CAN-14: sınıflandırma yaştan bağımsız/deterministik (sayfa yenilemede değişmez)', async (t) => {
  const { classifyCanonicalOrderStatus } = await classifier(await withVite(t))
  const oldOrder = baseOrder({ id: '14o', operationStatus: 'LABEL_PRINTED', labelStatus: 'PRINTED', hasPrintableLabel: true, shipment: printedShipment(), orderDate: OLD })
  const newOrder = baseOrder({ id: '14n', operationStatus: 'LABEL_PRINTED', labelStatus: 'PRINTED', hasPrintableLabel: true, shipment: printedShipment(), orderDate: RECENT })
  // Yalnız yaş farklı; statü AYNI olmalı (yaş statüyü değiştirmez).
  assert.equal(
    classifyCanonicalOrderStatus(oldOrder).status,
    classifyCanonicalOrderStatus(newOrder).status,
  )
  // Aynı sipariş iki kez → aynı sonuç (deterministik).
  assert.equal(
    classifyCanonicalOrderStatus(oldOrder).status,
    classifyCanonicalOrderStatus(oldOrder).status,
  )
})

test('CAN-15: tenant izolasyonu — Tenant B, Tenant A siparişini görmez (org-scoped)', async (t) => {
  const schema = await import('./db/schema.ts')
  process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  const orderService = await import('./orders/orderPersistenceService.ts')
  const dir = join(here, '..', 'drizzle')
  const stmts = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    stmts.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  const pglite = new PGlite()
  t.after(() => pglite.close())
  for (const s of stmts) await pglite.exec(s)
  const db = drizzle(pglite, { schema })
  const [orgA] = await db.insert(schema.organizations).values({ name: 'A', slug: 'can-a' }).returning()
  const [orgB] = await db.insert(schema.organizations).values({ name: 'B', slug: 'can-b' }).returning()
  await orderService.persistSyncResult(
    db,
    orgA.id,
    [
      {
        marketplace: 'Trendyol',
        packageId: 'T-1',
        shipmentPackageId: 'T-1',
        orderNumber: '11499',
        marketplaceStatus: 'Created',
        operationStatus: 'NEW',
        customerFirstName: 'A',
        customerLastName: 'B',
        city: 'İstanbul',
        totalAmount: 100,
        currency: 'TRY',
        orderDate: '2026-07-26T08:00:00Z',
        rawOrder: {},
        items: [{ id: 'l1', quantity: 1, price: 100 }],
      },
    ],
    { complete: true },
  )
  const [row] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.packageId, 'T-1'))
  assert.ok(await orderService.getOrder(db, orgA.id, row.id), 'org A görür')
  assert.equal(await orderService.getOrder(db, orgB.id, row.id), null, 'org B görmez')
})

test('CAN-16: kaynak taraması — yaşa dayalı otomatik arşiv kaldırıldı', () => {
  const orderStatus = readFileSync(
    join(here, '..', 'src', 'utils', 'orderStatus.ts'),
    'utf8',
  )
  assert.ok(!orderStatus.includes('HISTORICAL_ORDER_AGE_DAYS'))
  assert.ok(!/export function isHistoricalOrder/.test(orderStatus))
})
