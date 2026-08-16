import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

// TRENDYOL PAKET KIMLIGI IZI — SALT OKUNUR TANI.
//
// GOLDEN URETIM VAKASI (PII YOK):
//   orderNumber 11493372619 · CargoFlow packageId 4065907241
//   CargoFlow: Picking + LABEL_PRINTED · Trendyol paneli: Kargoya Verildi
//
// Bu paket YALNIZ tani aracinin sozlesmesini kilitler:
//   1) HICBIR yazma yapmaz (DB/carrier/marketplace),
//   2) sorgu KANITLI parametrelerle kurulur (uydurma param YOK),
//   3) vaka siniflandirmasi B1/B2/B3/E deterministiktir,
//   4) kanit yetersizse KARAR VERMEZ (inconclusive).
//
// Surat/SSP, ZPL, etiket, retention KAPSAM DISIDIR.

let vite

before(async () => {
  vite = await createServer({
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
})
after(async () => {
  await vite?.close()
})

const TRACE = '/server/orders/trendyolPackageIdentityTrace.ts'
const CLI_SOURCE = readFileSync(
  'server/orders/trendyolPackageIdentityTraceCli.ts',
  'utf8',
)
const CORE_SOURCE = readFileSync(
  'server/orders/trendyolPackageIdentityTrace.ts',
  'utf8',
)
const ENTRY_SOURCE = readFileSync('server/index.mjs', 'utf8')

/** Yorum satirlari ayiklanmis kaynak — sozlesme KODA bakar, aciklamaya degil. */
const codeOf = (source) =>
  source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')

const GOLDEN = { packageId: '4065907241', orderNumber: '11493372619' }

const pkg = (overrides = {}) => ({
  id: GOLDEN.packageId,
  packageId: GOLDEN.packageId,
  shipmentPackageId: GOLDEN.packageId,
  orderNumber: GOLDEN.orderNumber,
  status: 'Picking',
  lastModifiedDate: 1_750_000_000_000,
  ...overrides,
})

const fieldsOf = async (item) => {
  const module = await vite.ssrLoadModule(TRACE)
  return module.extractPackageIdentityFields(item)
}

// ═══ SALT OKUNURLUK ═══════════════════════════════════════════════════════

test('TRACE-READONLY-1: CLI hicbir yazma cagrisi ICERMEZ', () => {
  const code = codeOf(CLI_SOURCE)
  for (const forbidden of [
    '.update(',
    '.insert(',
    '.delete(',
    'persistSyncResult',
    'markOrderLabelReady',
    'applyTrackingDecision',
    'purgeOrderRecord',
    'archiveEligibleOrders',
  ]) {
    assert.equal(code.includes(forbidden), false, `yazma yasak: ${forbidden}`)
  }
  // Yalnizca okuma yuzeyi.
  assert.ok(code.includes('.select('))
  assert.ok(code.includes("method: 'GET'"))
})

test('TRACE-READONLY-2: tasiyici (Surat) ve marketplace write yuzeyi YOK', () => {
  const code = codeOf(CLI_SOURCE) + '\n' + codeOf(CORE_SOURCE)
  for (const forbidden of [
    'surat',
    'Serendip',
    'KargoTakip',
    'WebSiparisKodu',
    'CariKoduveSifre',
    'shipment-packages',
    'updatePackageStatus',
    'zpl',
  ]) {
    assert.equal(
      code.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `kapsam disi: ${forbidden}`,
    )
  }
})

test('TRACE-READONLY-3: secret/PII loglanmaz', () => {
  const code = codeOf(CLI_SOURCE)
  // Ham govde, apiKey/apiSecret veya musteri alanlari RAPORLANMAZ.
  for (const forbidden of [
    'customerFirstName',
    'customerLastName',
    'customerPhone',
    'shipmentAddress',
    'rawResponse',
    'console.log(body',
  ]) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
  // apiKey/apiSecret YALNIZ Authorization basliginda kullanilir.
  const secretUses = code.split('apiSecret').length - 1
  assert.equal(secretUses, 1, 'apiSecret yalniz auth basliginda')
})

// ═══ SORGU SOZLESMESI ═════════════════════════════════════════════════════

test('TRACE-QUERY-1: URL kanonik client ile AYNI parametreleri kurar', async () => {
  const { buildOrdersQueryUrl } = await vite.ssrLoadModule(TRACE)
  const url = buildOrdersQueryUrl({
    baseUrl: 'https://apigw.trendyol.com',
    sellerId: '277221',
    orderNumber: GOLDEN.orderNumber,
    startDate: 1_750_000_000_000,
    endDate: 1_752_000_000_000,
    page: 0,
    size: 200,
  })
  assert.ok(url.includes('/integration/order/sellers/277221/orders?'))
  for (const param of [
    'startDate=',
    'endDate=',
    'page=0',
    'size=200',
    'orderByField=PackageLastModifiedDate',
    'orderByDirection=DESC',
    `orderNumber=${GOLDEN.orderNumber}`,
  ]) {
    assert.ok(url.includes(param), param)
  }
  // Statu filtresi UYGULANMAZ: ileri statuler de gorulmeli.
  assert.equal(url.includes('status='), false)
  // Kanonik client de AYNI yolu ve orderNumber parametresini kullanir.
  assert.ok(
    ENTRY_SOURCE.includes(
      "if (query.orderNumber) params.set('orderNumber', query.orderNumber)",
    ),
    'orderNumber parametresi kanonik client sozlesmesinde olmali',
  )
  assert.ok(
    ENTRY_SOURCE.includes('/integration/order/sellers/${credentials.sellerId}/orders?'),
  )
})

test('TRACE-QUERY-2: KANITLANMAMIS parametre UYDURULMAZ', () => {
  const code = codeOf(CORE_SOURCE) + '\n' + codeOf(CLI_SOURCE)
  for (const invented of ['shipmentPackageIds', 'packageIds=', 'supplierId=']) {
    assert.equal(code.includes(invented), false, invented)
  }
  // Kanonik client'ta da boyle bir parametre YOK — sozlesme dogrulanir.
  assert.equal(ENTRY_SOURCE.includes('shipmentPackageIds'), false)
})

test('TRACE-QUERY-3: pencere 30 GUNU asamaz ve gelecege tasmaz', async () => {
  const { resolveTraceWindow } = await vite.ssrLoadModule(TRACE)
  const now = 1_800_000_000_000
  const day = 24 * 60 * 60 * 1000

  const anchored = resolveTraceWindow({
    nowMs: now,
    orderDateMs: now - 5 * day,
  })
  assert.equal(anchored.basis, 'orderDate')
  assert.ok(anchored.endDate <= now, 'gelecege tasmaz')
  assert.ok(anchored.endDate - anchored.startDate <= 30 * day)
  assert.ok(anchored.startDate < now - 5 * day, 'siparis tarihinden once baslar')

  const explicit = resolveTraceWindow({
    nowMs: now,
    startOverrideMs: now - 90 * day,
    endOverrideMs: now,
  })
  assert.equal(explicit.basis, 'explicit')
  assert.equal(explicit.clampedTo30Days, true, '90 gun 30 gune KIRPILIR')
  assert.ok(explicit.endDate - explicit.startDate <= 30 * day)

  const fallback = resolveTraceWindow({ nowMs: now, windowDays: 7 })
  assert.equal(fallback.basis, 'now')
  assert.equal(fallback.endDate - fallback.startDate, 7 * day)
  // Gecersiz gun degerleri tabana/tavana oturur.
  assert.ok(
    resolveTraceWindow({ nowMs: now, windowDays: 999 }).endDate -
      resolveTraceWindow({ nowMs: now, windowDays: 999 }).startDate <=
      30 * day,
  )
})

// ═══ ALAN CIKARIMI ════════════════════════════════════════════════════════

test('TRACE-FIELDS-1: packageId turetimi normalizeTrendyolOrders ile AYNI', async () => {
  assert.equal((await fieldsOf(pkg())).packageId, GOLDEN.packageId)
  // packageId yoksa shipmentPackageId, o da yoksa id.
  assert.equal(
    (await fieldsOf({ shipmentPackageId: '55', id: '99' })).packageId,
    '55',
  )
  assert.equal((await fieldsOf({ id: '99' })).packageId, '99')
  // Kanonik turetim satiri kaynakta duruyor.
  assert.ok(
    ENTRY_SOURCE.includes(
      'const packageId = String(item.packageId ?? item.shipmentPackageId ?? item.id ?? \'\')',
    ),
  )
})

test('TRACE-FIELDS-2: YALNIZ teknik alanlar tasinir (PII YOK)', async () => {
  const fields = await fieldsOf(
    pkg({
      customerFirstName: 'X',
      customerLastName: 'Y',
      customerPhone: '5550000000',
      shipmentAddress: { city: 'Istanbul', address1: 'gizli' },
      lines: [{ productName: 'urun' }],
      totalPrice: 199.9,
      originPackageIds: [4000000001],
    }),
  )
  assert.deepEqual(Object.keys(fields).sort(), [
    'lastModifiedAtMs',
    'lastModifiedDate',
    'orderNumber',
    'originPackageIds',
    'packageId',
    'packageStatus',
    'rawIds',
    'shipmentPackageStatus',
    'status',
  ])
  assert.deepEqual(fields.originPackageIds, [4000000001])
  const serialized = JSON.stringify(fields)
  for (const leak of ['5550000000', 'Istanbul', 'gizli', 'urun', '199.9']) {
    assert.equal(serialized.includes(leak), false, leak)
  }
})

test('TRACE-FIELDS-3: etkin statu ve zaman damgasi cozumu', async () => {
  const { effectiveStatusOf, resolvePackageModifiedAt } =
    await vite.ssrLoadModule(TRACE)
  assert.equal(
    effectiveStatusOf(await fieldsOf(pkg({ status: 'Shipped' }))),
    'Shipped',
  )
  // status yoksa shipmentPackageStatus, o da yoksa packageStatus.
  assert.equal(
    effectiveStatusOf(
      await fieldsOf(pkg({ status: undefined, shipmentPackageStatus: 'Shipped' })),
    ),
    'Shipped',
  )
  assert.equal(
    effectiveStatusOf(
      await fieldsOf(
        pkg({
          status: undefined,
          shipmentPackageStatus: undefined,
          packageStatus: 'Delivered',
        }),
      ),
    ),
    'Delivered',
  )
  // index.mjs ile AYNI damga semantigi.
  assert.equal(resolvePackageModifiedAt({ lastModifiedDate: 1700 }), 1700)
  assert.equal(
    resolvePackageModifiedAt({ lastModifiedDate: '2026-08-01T00:00:00.000Z' }),
    Date.parse('2026-08-01T00:00:00.000Z'),
  )
  assert.equal(resolvePackageModifiedAt({}), null)
})

// ═══ VAKA SINIFLANDIRMASI ═════════════════════════════════════════════════

const classify = async (packages) => {
  const module = await vite.ssrLoadModule(TRACE)
  return module.classifyPackageIdentityCase({
    persistedPackageId: GOLDEN.packageId,
    packages: packages.map(module.extractPackageIdentityFields),
  })
}

test('TRACE-CASE-B1: exact Picking + baska paket Shipped', async () => {
  const verdict = await classify([
    pkg({ status: 'Picking' }),
    pkg({
      packageId: '4099999999',
      shipmentPackageId: '4099999999',
      id: '4099999999',
      status: 'Shipped',
    }),
  ])
  assert.equal(verdict.case, 'B1_package_split_or_replacement')
  assert.equal(verdict.exactFound, true)
  assert.deepEqual(verdict.forwardPackageIds, ['4099999999'])
  assert.equal(verdict.conclusive, true)
})

test('TRACE-CASE-B2: exact Shipped ama DB Picking', async () => {
  const verdict = await classify([pkg({ status: 'Shipped' })])
  assert.equal(verdict.case, 'B2_persistence_or_matching_bug')
  assert.equal(verdict.exactStatus, 'Shipped')
  assert.equal(verdict.conclusive, true)
})

test('TRACE-CASE-B3: exact YOK + baska paket Shipped', async () => {
  const verdict = await classify([
    pkg({
      packageId: '4099999999',
      shipmentPackageId: '4099999999',
      id: '4099999999',
      status: 'Shipped',
      originPackageIds: [Number(GOLDEN.packageId)],
    }),
  ])
  assert.equal(verdict.case, 'B3_replacement_package')
  assert.equal(verdict.exactFound, false)
  assert.deepEqual(verdict.forwardPackageIds, ['4099999999'])
})

test('TRACE-CASE-E: exact Picking ve baska paket YOK', async () => {
  const verdict = await classify([pkg({ status: 'Picking' })])
  assert.equal(verdict.case, 'E_entity_mismatch')
  assert.equal(verdict.exactFound, true)
  assert.deepEqual(verdict.otherPackageIds, [])
})

test('TRACE-CASE-INCONCLUSIVE: bos yanit "paket yok" KANITI DEGILDIR', async () => {
  const verdict = await classify([])
  assert.equal(verdict.case, 'INCONCLUSIVE_no_packages_in_window')
  assert.equal(verdict.conclusive, false)
  assert.ok(verdict.note.includes('KANITLAMAZ'))
})

test('TRACE-CASE-FORWARD-SET: ileri statu kumesi kanonik', async () => {
  const { FORWARD_MARKETPLACE_STATUSES, isForwardStatus } =
    await vite.ssrLoadModule(TRACE)
  const retention = readFileSync('server/orders/orderRetention.ts', 'utf8')
  for (const status of FORWARD_MARKETPLACE_STATUSES) {
    assert.ok(retention.includes(`'${status}'`), `retention kumesinde: ${status}`)
    assert.equal(isForwardStatus(status), true)
  }
  for (const status of ['Created', 'Picking', 'Invoiced', null, '']) {
    assert.equal(isForwardStatus(status), false, String(status))
  }
})

// ═══ MEVCUT DAVRANISLAR KORUNUR ═══════════════════════════════════════════

test('TRACE-SCOPE: calisan akislar DEGISMEDI', () => {
  // Stale overwrite fix yerinde.
  assert.ok(ENTRY_SOURCE.includes('incomingIsNewer'))
  assert.ok(ENTRY_SOURCE.includes('function definedFieldsOf'))
  // Arka plan senkronu ve bayrak sozlesmesi yerinde.
  assert.ok(ENTRY_SOURCE.includes('startTrendyolStatusSyncOnBoot'))
  assert.ok(ENTRY_SOURCE.includes('syncTrendyolOrdersForOrganization'))
  // Tani araci senkron zincirine BAGLANMAZ (ayri, elle calistirilan CLI).
  assert.equal(
    ENTRY_SOURCE.includes('trendyolPackageIdentityTrace'),
    false,
    'tani araci server boot yoluna baglanmamali',
  )
})
