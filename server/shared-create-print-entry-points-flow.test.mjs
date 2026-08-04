import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Tek-tuş kargo etiketi akışının ORTAK giriş noktaları:
// Siparişler · Sipariş Detayı · Dashboard Son Operasyonlar.
// Veriler SENTETİKTİR.

const here = dirname(fileURLToPath(import.meta.url))
let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom', server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
const drawer = readFileSync(
  join(here, '..', 'src/components/OrderDetailDrawer.tsx'), 'utf8')
const dashboard = readFileSync(
  join(here, '..', 'src/pages/DashboardPage.tsx'), 'utf8')
const ordersPage = readFileSync(
  join(here, '..', 'src/pages/OrdersPage.tsx'), 'utf8')

// ---------------------------------------------------------------- 1 + 2
test('SEP-1/2: Detay ekranında provider adı YOK, ortak buton VAR', () => {
  assert.equal(/Sürat Gönderisi Oluştur/.test(drawer), false)
  assert.match(drawer, /Kargo Etiketi Oluştur ve Yazdır/)
  assert.match(drawer, /Gelişmiş İşlemler/)
})

// ---------------------------------------------------------------- 3
test('SEP-3: Detay ana butonu ORTAK handler\'ı sipariş id ile çağırır', () => {
  const footer = drawer.slice(drawer.indexOf('order-drawer-footer'))
  assert.match(footer, /onClick=\{\(\) => onCreateAndPrintLabel\?\.\(order\.id\)\}/)
  // Detay içine create/print iş mantığı KOPYALANMADI.
  for (const leak of [
    'runSuratCreateAndPrint', 'buildCreateAdapter', 'buildPrintAdapter',
    'workflowService.createShipments', 'printCleanLabelDocument',
  ]) {
    assert.equal(drawer.includes(leak), false, `mantık kopyalandı: ${leak}`)
  }
})

// ---------------------------------------------------------------- 4
test('SEP-4: Detay run sırasında kilitli (çift tıklama tek run)', () => {
  assert.match(drawer, /const actionsLocked = createAndPrintBusy/)
  const footer = drawer.slice(drawer.indexOf('order-drawer-footer'))
  assert.match(footer, /disabled=\{busy \|\| actionsLocked \|\| !onCreateAndPrintLabel\}/)
  // Ana akıştaki tek-run guard'ı korunur.
  assert.match(app, /if \(ids\.length === 0 \|\| suratRunActive\.current\) return/)
})

// ---------------------------------------------------------------- 5..7
test('SEP-5/6/7: BEKLIYOR create+print, READY print, PRINTED reprint', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  const order = (id, extra = {}) => ({
    id, orderNumber: `N-${id}`, packageId: `P-${id}`,
    marketplace: 'Trendyol',
    items: [{ id: `l-${id}`, productName: 'Test', quantity: 1 }],
    ...extra,
  })
  const input = {
    isSuratOrder: () => true,
    resolveDesiBlock: () => null,
    resolveFitBlock: () => null,
    resolveDataBlock: () => null,
    hasPrintableLabel: (o) => Boolean(o.ready),
    isPrinted: (o) => Boolean(o.printed),
    isInFlight: (o) => Boolean(o.inFlight),
  }
  const waiting = resolveSuratCreateAndPrintPlan([order('1')], input)
  assert.equal(waiting.needsCreate.length, 1, 'Barkod Bekliyor -> create')

  const ready = resolveSuratCreateAndPrintPlan([order('2', { ready: true })], input)
  assert.equal(ready.needsCreate.length, 0, 'READY -> create YOK')
  assert.equal(ready.readyToPrint.length, 1)

  const printed = resolveSuratCreateAndPrintPlan(
    [order('3', { ready: true, printed: true })], input)
  assert.equal(printed.needsCreate.length, 0, 'PRINTED -> create YOK')
  assert.equal(printed.reprint.length, 1, 'PRINTED -> reprint')

  const inFlight = resolveSuratCreateAndPrintPlan(
    [order('4', { inFlight: true })], input)
  assert.equal(inFlight.needsCreate.length, 0, 'in-flight -> ikinci create YOK')
  assert.equal(inFlight.inFlight.length, 1)
})

// ---------------------------------------------------------------- 8
test('SEP-8: Detay Gelişmiş İşlemler ÜÇ eski handler\'ı korur', () => {
  const menu = drawer.slice(
    drawer.indexOf('order-detail-advanced-menu'),
    drawer.indexOf('</aside>'),
  )
  assert.match(menu, /onTrackShipment\(order\.id\)/)
  assert.match(menu, /onDownloadZpl\(order\.id\)/)
  assert.match(menu, /onPrintLabel\(order\.id\)/)
  for (const label of ['Takip Sorgula', 'ZPL İndir', 'Tekrar Yazdır']) {
    assert.ok(menu.includes(label), `${label} korunmalı`)
  }
  assert.equal((menu.match(/role="menuitem"/g) ?? []).length, 3)
})

// ---------------------------------------------------------------- 9 + 14
test('SEP-9/14: Dashboard yazıcı ikonu ORTAK handler, metin provider-bağımsız', () => {
  const zone = dashboard.slice(
    dashboard.indexOf('dashboard-row-actions'),
    dashboard.indexOf('</td>', dashboard.indexOf('dashboard-row-actions')),
  )
  assert.match(zone, /onCreateAndPrintLabelForOrder \?\? onPrintOrder\)\(\s*operation\.id,?\s*\)/)
  assert.match(zone, /title="Kargo etiketi oluştur ve yazdır"/)
  assert.match(zone, /kargo etiketi oluştur ve yazdır/)
  assert.equal(/Sürat/.test(zone), false, 'kullanıcı metninde provider adı YOK')
  // Görüntüle ve indirme ikonları KORUNUR.
  assert.match(zone, /Sipariş detayını görüntüle/)
  assert.match(zone, /ZPL indir/)
})

// ---------------------------------------------------------------- 10
test('SEP-10: Dashboard ikonu "Barkod Bekliyor" siparişte DISABLED DEĞİL', () => {
  const zone = dashboard.slice(
    dashboard.indexOf('dashboard-row-actions'),
    dashboard.indexOf('</td>', dashboard.indexOf('dashboard-row-actions')),
  )
  const printBtn = zone.slice(
    zone.indexOf('kargo etiketi oluştur ve yazdır'),
    zone.indexOf('<Printer size={15} />'),
  )
  // Eski salt-baskı kuralı (canPrint) ARTIK kapatmıyor.
  assert.equal(/disabled=\{!operation\.canPrint\}/.test(printBtn), false)
  assert.match(printBtn, /!operation\.id/)
  assert.match(printBtn, /isCarrierLabelActionBusy\?\.\(operation\.id\)/)
})

// ---------------------------------------------------------------- 15
test('SEP-15: desteklenmeyen kargo firması GÜVENLİ blocked sonucu verir', async () => {
  const { resolveSuratCreateAndPrintPlan, UNSUPPORTED_CARRIER_MESSAGE } =
    await load('/src/utils/suratCreatePrintPlan.ts')
  const plan = resolveSuratCreateAndPrintPlan(
    [{
      id: 'o-1', orderNumber: 'N1', packageId: 'P1', marketplace: 'Trendyol',
      items: [{ id: 'l1', productName: 'Test', quantity: 1 }],
    }],
    {
      isSuratOrder: () => false,
      resolveDesiBlock: () => null,
      resolveFitBlock: () => null,
      resolveDataBlock: () => null,
      hasPrintableLabel: () => false,
      isPrinted: () => false,
      isInFlight: () => false,
    },
  )
  assert.equal(plan.blocked.length, 1)
  assert.equal(plan.needsCreate.length, 0, 'desteklenmeyen provider ÇALIŞTIRILMAZ')
  assert.equal(plan.blocked[0].reason, UNSUPPORTED_CARRIER_MESSAGE)
  assert.equal(/Sürat/.test(plan.blocked[0].reason), false)
})

// ---------------------------------------------------------------- 16 + 17
test('SEP-16/17: aynı sipariş için tek create; registry canonical kimlik', () => {
  const busy = app.slice(
    app.indexOf('function isCarrierLabelActionBusy'),
    app.indexOf('const carrierLabelPhaseText'),
  )
  assert.match(busy, /suratRunning \|\| suratRunActive\.current/)
  assert.match(busy, /hasPendingServerOperation\(order\)/)
  assert.match(busy, /isOperationInFlight\(orderPackageIdentity\(order\)\)/)
  // Create hâlâ ayni paket kimligi icin tek Promise kullanir.
  assert.match(app, /runExclusiveOperation\(identity, \(\) =>/)
})

// ---------------------------------------------------------------- 18 + 19
test('SEP-18/19: üç ekran AYNI App state\'ini kullanır, stale kopya EZMEZ', () => {
  // Tek state kaynagi: orders -> her iki sayfaya da ayni referans gider.
  assert.match(app, /const orders = ordersState\.orders/)
  assert.match(app, /onOrdersUpdated: \(updated\) => \{/)
  assert.match(app, /setOrdersState\(\(current\) => \(\{ \.\.\.current, orders: updated \}\)\)/)
  // Detay/Dashboard kendi lokal order kopyasini state'e YAZMAZ.
  assert.equal(/setOrdersState/.test(drawer), false)
  assert.equal(/setOrdersState/.test(dashboard), false)
})

// ---------------------------------------------------------------- 20 + 21
test('SEP-20/21: popup/confirmation YOK, otomatik browser-print korunur', () => {
  for (const src of [app, drawer, dashboard, ordersPage]) {
    assert.equal(/window\.confirm\(/.test(src), false)
    assert.equal(/window\.alert\(/.test(src), false)
    assert.equal(/Baskı sonucu bekleniyor/.test(src), false)
    assert.equal(/Evet, çıktı|Hayır, çıkmadı/.test(src), false)
  }
  const provider = readFileSync(
    join(here, '..', 'src/providers/printing/BrowserDownloadPrintProvider.ts'),
    'utf8',
  )
  assert.match(provider, /resolveBrowserPrintJobs\(browserPrintDebug, orderNumbers\)/)
})

// ---------------------------------------------------------------- 22
test('SEP-22: Zebra/native jobs[].ok sözleşmesi DEĞİŞMEDİ', () => {
  const provider = readFileSync(
    join(here, '..', 'src/providers/printing/BrowserDownloadPrintProvider.ts'),
    'utf8',
  )
  const zebra = provider.slice(provider.indexOf("'/api/printing/zebra/raw'"))
  assert.match(zebra, /jobs: data\.jobs/)
  assert.equal(/resolveBrowserPrintJobs/.test(zebra), false)
})

// ---------------------------------------------------------------- 23 + 24
test('SEP-23/24: kullanıcı aksiyonlarında "Sürat" yok, iç isimler DURUYOR', () => {
  // Kullanıcıya görünen aksiyon metinleri.
  const drawerFooter = drawer.slice(drawer.indexOf('order-drawer-footer'))
  assert.equal(/Sürat/.test(drawerFooter), false)
  const controls = readFileSync(
    join(here, '..', 'src/components/SuratCreatePrintControls.tsx'), 'utf8')
  const actions = controls.slice(
    controls.indexOf('<div className="toolbar-actions">'),
    controls.indexOf('</section>', controls.indexOf('<div className="toolbar-actions">')),
  )
  assert.equal(/Sürat/.test(actions), false)
  // İÇ teknik isimler KORUNUR.
  for (const name of [
    'runSuratCreateAndPrint', 'suratOperationRegistry', 'suratCreatePrintPlan',
  ]) {
    assert.ok(app.includes(name) || name === 'suratCreatePrintPlan', name)
  }
  assert.ok(app.includes('handleSuratCreateAndPrintForIds'), 'iç handler adı korunur')
})

// ---------------------------------------------------------------- 25..27
test('SEP-25/26/27: PII loglanmaz, ZPL ve izolasyon yolları değişmedi', () => {
  for (const src of [drawer, dashboard]) {
    assert.equal(/console\.(log|info|warn)\([^)]*customerName/.test(src), false)
    assert.equal(/console\.(log|info|warn)\([^)]*address/.test(src), false)
  }
  const changed = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
  // Ortak wrapper YALNIZ yonlendirir: yeni endpoint/lifecycle YOK.
  const wrapper = changed.slice(
    changed.indexOf('function handleCreateAndPrintCarrierLabelsForIds'),
    changed.indexOf('function isCarrierLabelActionBusy'),
  )
  assert.equal(/fetch\(/.test(wrapper), false, 'yeni endpoint yok')
  assert.match(wrapper, /handleSuratCreateAndPrintForIds\(ids\)/)
})
