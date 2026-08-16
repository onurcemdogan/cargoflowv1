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

// MERKEZİ BAŞARI KRİTERİ regresyonu (SDP fiziksel kabul ayrı uygulamada):
//   labelCreationOk = HTTP ok && soapResult.isError === false && geçerli boş
//   olmayan ZPL. verifiedShipment / dispatchRegistrationConfirmed /
//   operationalBarcodeVerified / tracking kaydı / T.No-barkod parse ŞART DEĞİLDİR;
//   yalnız diagnostic'tir ve LABEL_READY geçişini ENGELLEYEMEZ.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const orderService = await import('./orders/orderPersistenceService.ts')
const shipmentService = await import('./shipments/shipmentPersistenceService.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}
async function makeDb() {
  const pglite = new PGlite()
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, name, slug) {
  const [org] = await db.insert(schema.organizations).values({ name, slug }).returning()
  return org.id
}
let seq = 0
function makeOrder(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `PKG-${seq}`
  return {
    marketplace: 'Trendyol', packageId, shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`, marketplaceStatus: 'Created',
    operationStatus: 'NEW', customerFirstName: 'Ada', customerLastName: 'L',
    city: 'İstanbul', district: 'Kadıköy', totalAmount: 100, currency: 'TRY',
    orderDate: '2026-07-26T08:00:00Z', rawOrder: {}, items: [{ id: `l-${packageId}`, quantity: 1, price: 100 }],
    ...over,
  }
}
// Yazdırılabilir ZPL üretilmiş operation record (status UNKNOWN = kabul-öncesi).
function zplRecord(org, order, over = {}) {
  return {
    idempotencyKey: `SURAT:org_${org}:${order.orderNumber}:CREATE`,
    organizationId: org, marketplace: 'Trendyol', packageId: order.packageId,
    orderNumber: order.orderNumber, orderId: order.orderNumber, provider: 'surat',
    operation: 'OrtakBarkodOlustur', status: 'UNKNOWN', createCallCount: 1,
    completedAt: '2026-07-26T09:00:00Z',
    carrierTrackingNumber: '', carrierBarcodeNumber: '',
    candidateTrackingNumber: '11820824092123', candidateBarcodeNumber: '01252765588',
    technicalZpl: '^XA^FD01252765588^FS^XZ',
    verificationStatus: 'LABEL_CREATED_UNVERIFIED',
    shipment: {
      tNo: '11820824092123', barkodNo: '01252765588', barcodeRaw: '^XA^FD01252765588^FS^XZ',
      labelStatus: 'READY', printEnabled: true, verifiedShipment: false,
      dispatchRegistrationConfirmed: false,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    },
    ...over,
  }
}

// ---- Saf helper testleri (resolveSuratCreateBusinessResult) ----
test('1-3,5,8: labelCreationOk YALNIZ yazdırılabilir ZPL ile belirlenir', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, })
  t.after(() => vite.close())
  const { resolveSuratCreateBusinessResult } = await vite.ssrLoadModule(
    '/src/utils/suratCreateResult.ts',
  )

  // (1) isError=false + geçerli ZPL → ok=true, LABEL_READY, printEnabled.
  const zplOnly = resolveSuratCreateBusinessResult({
    printEnabled: true, zplReady: true, barcodeRaw: '^XA^FD01252765588^FS^XZ',
    labelStatus: 'READY', lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
  })
  assert.equal(zplOnly.labelCreationOk, true)
  assert.equal(zplOnly.businessOk, true)

  // (2) verifiedShipment=false LABEL_READY'i engellemez.
  assert.equal(
    resolveSuratCreateBusinessResult({ zplReady: true, verifiedShipment: false, labelStatus: 'READY' }).labelCreationOk,
    true,
  )
  // (3) dispatchRegistrationConfirmed=false engellemez.
  assert.equal(
    resolveSuratCreateBusinessResult({ barcodeRaw: '^XA^XZ', dispatchRegistrationConfirmed: false }).labelCreationOk,
    true,
  )

  // (5) T.No/barkod parse EDİLEMEZ ama ZPL geçerli → yine başarılı, yazdırılabilir.
  const noCodesButZpl = resolveSuratCreateBusinessResult({
    printEnabled: true, barcodeRaw: '^XA^FDx^FS^XZ', labelStatus: 'READY',
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    // trackingNumber/barcode YOK
  })
  assert.equal(noCodesButZpl.labelCreationOk, true, 'kimlik olmadan da ZPL varsa başarılı')
  assert.equal(noCodesButZpl.hasIdentifier, false, 'kimlik yok (yalnız diagnostic)')
  assert.equal(noCodesButZpl.printable, true)

  // (8) ZPL boş → create başarısız (LABEL_READY yazılmaz).
  assert.equal(
    resolveSuratCreateBusinessResult({ printEnabled: false, labelStatus: 'PENDING', lifecycleStatus: 'SURAT_CREATED_NO_TRACKING' }).labelCreationOk,
    false,
  )
  // Gerçek hard-failure (dispatch reddi) → başarısız.
  assert.equal(
    resolveSuratCreateBusinessResult({ barcodeRaw: '^XA^XZ', lifecycleStatus: 'SURAT_DISPATCH_REJECTED' }).labelCreationOk,
    false,
  )
  // labelStatus BLOCKED → başarısız.
  assert.equal(
    resolveSuratCreateBusinessResult({ barcodeRaw: '^XA^XZ', labelStatus: 'BLOCKED' }).labelCreationOk,
    false,
  )
})

// ---- Persistence + markLabelReady testleri ----
test('4: T.No parse edilirse trackingNumber olarak kaydedilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org T', 'label-success-t')
  const order = makeOrder({ packageId: 'T-1', orderNumber: 'T-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, zplRecord(org, order))
  const rows = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].trackingNumber, '11820824092123', 'Sürat T.No canonical trackingNumber')
  assert.equal(rows[0].barcode, '01252765588', 'Code128 barkod canonical barcode')
})

test('5-6: ZPL var ama T.No/barkod YOK → shipment persist + LABEL_READY (yenilemede kalır)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org Z', 'label-success-z')
  const order = makeOrder({ packageId: 'Z-1', orderNumber: 'Z-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })

  // Kimliksiz ama ZPL'li kayıt (parse edilemedi).
  await shipmentService.writeOperationRecord(db, org, zplRecord(org, order, {
    candidateTrackingNumber: '', candidateBarcodeNumber: '',
    shipment: {
      barcodeRaw: '^XA^FDweb^FS^XZ', labelStatus: 'READY', printEnabled: true,
      zplReady: true, technicalZplReceived: true, verifiedShipment: false,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    },
  }))
  const rows = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  assert.equal(rows.length, 1, 'ZPL varsa kimliksiz de shipment yazılır')

  const [orderRow] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, 'Z-1'))
  const result = await orderService.markLabelReady(db, org, orderRow.id)
  assert.equal(result.updated, true)
  assert.equal(result.operationStatus, 'LABEL_READY')

  // (6) Yeniden okuma (sayfa yenileme): kalıcı LABEL_READY.
  const [reloaded] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderRow.id))
  assert.equal(reloaded.operationStatus, 'LABEL_READY', 'yenilemede Etiket Hazır korunur')
  assert.equal(reloaded.marketplaceStatus, 'Created', 'marketplaceStatus dokunulmaz (otomatik Kargoya Verildi YOK)')
})

test('7: aynı ZPL kaydı ikinci kez yazılır → duplicate shipment oluşmaz (idempotent)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org I', 'label-success-i')
  const order = makeOrder({ packageId: 'I-1', orderNumber: 'I-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, zplRecord(org, order))
  await shipmentService.writeOperationRecord(db, org, zplRecord(org, order))
  const rows = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  assert.equal(rows.length, 1, 'tekrar create kopya shipment üretmez (upsert)')
})

test('8: ZPL YOK / hard-failure → shipment YAZILMAZ, markLabelReady reddeder', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org F', 'label-success-f')
  const order = makeOrder({ packageId: 'F-1', orderNumber: 'F-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, {
    idempotencyKey: `SURAT:org_${org}:F-1:CREATE`, organizationId: org,
    marketplace: 'Trendyol', packageId: 'F-1', orderNumber: 'F-1', orderId: 'F-1',
    provider: 'surat', operation: 'OrtakBarkodOlustur', status: 'FAILED_SAFE',
    createCallCount: 1, completedAt: '2026-07-26T09:00:00Z',
    shipment: { lifecycleStatus: 'SURAT_DISPATCH_REJECTED', labelStatus: 'BLOCKED' },
  })
  const rows = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  assert.equal(rows.length, 0, 'ZPL yok → sahte shipment yazılmaz')
  const [orderRow] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, 'F-1'))
  const result = await orderService.markLabelReady(db, org, orderRow.id)
  assert.equal(result.updated, false)
  assert.equal(result.reason, 'shipment_required')
})

test('9: farklı tenant başka tenant ZPL siparişini LABEL_READY yapamaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A', 'label-success-a')
  const orgB = await makeOrg(db, 'Org B', 'label-success-b')
  const order = makeOrder({ packageId: 'X-1', orderNumber: 'X-1' })
  await orderService.persistSyncResult(db, orgA, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, orgA, zplRecord(orgA, order))
  const [orderRowA] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, 'X-1'))

  // Org B, org A'nın orderId'siyle markLabelReady → bulunamaz (izolasyon).
  const cross = await orderService.markLabelReady(db, orgB, orderRowA.id)
  assert.equal(cross.found, false, 'tenant B, tenant A siparişini göremez')
  // Org B'nin shipments'ında org A kaydı görünmez.
  const rowsB = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, orgB))
  assert.equal(rowsB.length, 0)
})

// ---- Debug sanitizasyonu (SOAP/ZPL/PII sızmaz) ----
test('10: debug güvenli metadata — ham SOAP/ZPL/PII sızmaz', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, })
  t.after(() => vite.close())
  const { summarizeSuratRawResponse, buildSuratSafeRequestBody } = await vite.ssrLoadModule(
    '/src/utils/suratDebugSafe.ts',
  )
  const raw = '<Sifre>SECRET</Sifre><AliciAdi>Ada Lovelace</AliciAdi><AliciAdresi>Açık adres</AliciAdresi>'
  const summary = summarizeSuratRawResponse(raw, {
    responseStatus: 200, isError: false, labelCreationOk: true,
    zpl: '^XA^FD01252765588^FS^XZ', lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
  })
  const text = JSON.stringify(summary) + JSON.stringify(buildSuratSafeRequestBody({ orderNumber: 'X' }))
  for (const leak of ['SECRET', 'Ada Lovelace', 'Açık adres', '01252765588', '^XA']) {
    assert.equal(text.includes(leak), false, `debug ${leak} sızdırmaz`)
  }
  assert.equal(summary.labelCreationOk, true)
  assert.equal(summary.zplPresent, true)
})
