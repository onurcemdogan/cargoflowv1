import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// A) MARKA REFERANSI TEMIZLIGI  B) SON SENKRONIZASYON DURUMU — KAYNAK SOZLESMELERI
//
// Saf cozumleyici davranisi src/test/syncStatusCopy.dom.test.tsx icinde
// sinanir. Burada kullaniciya gorunen metin ve state baglantisi kilitlenir.
// Satis hesaplari, rapor gunu (UTC), Turkiye saat gosterimi ve sync
// algoritmasi KAPSAM DISIDIR.

const readSource = (relative) => readFileSync(relative, 'utf8')

/** Yorum satirlari ayiklanir: sozlesme KULLANICIYA GORUNEN metne bakar. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(
      (line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'),
    )
    .join('\n')
}

const UI_SOURCES = [
  'src/pages/DashboardPage.tsx',
  'src/pages/OrdersPage.tsx',
  'src/pages/ProductsPage.tsx',
  'src/pages/CargoOperationsPage.tsx',
  'src/pages/LabelTemplatesPage.tsx',
  'src/pages/IntegrationsPage.tsx',
  'src/pages/IntegrationDebugPage.tsx',
  'src/pages/AuditLogsPage.tsx',
  'src/pages/OnboardingPage.tsx',
  'src/pages/LoginPage.tsx',
  'src/pages/BootstrapPage.tsx',
  'src/components/OrderDetailDrawer.tsx',
  'src/components/ProductDetailDrawer.tsx',
  'src/components/OrdersTable.tsx',
  'src/components/PickingProductsCard.tsx',
  'src/components/SuratCreatePrintControls.tsx',
  'src/components/AppShell.tsx',
  'src/components/StatusBadge.tsx',
  'src/components/ActionResult.tsx',
]

test('COPY-1: kullaniciya gorunen hicbir yuzeyde marka referansi YOK', () => {
  for (const relative of UI_SOURCES) {
    const visible = withoutComments(readSource(relative))
    assert.equal(
      /durusoft/i.test(visible),
      false,
      `${relative} kullaniciya gorunen metinde marka referansi tasimamali`,
    )
  }
})

test('COPY-2: tooltip marka bagimsiz metni gosterir', () => {
  const dashboard = readSource('src/pages/DashboardPage.tsx')
  assert.ok(
    dashboard.includes(
      'Satış raporlarında aynı gün sınırı kullanılır. Sipariş saatleri Türkiye saatiyle gösterilmeye devam eder.',
    ),
  )
  assert.equal(/title="Durusoft/i.test(dashboard), false)
})

test('COPY-3: rapor gunu / saat davranisi DEGISMEDI', () => {
  const range = readSource('src/dashboard/reportingRange.ts')
  assert.ok(range.includes('UTC'))
  const metric = readSource('src/dashboard/dashboardSalesMetricDefinition.ts')
  assert.ok(metric.includes('SALES_DATE_BASIS'))
})

test('COPY-4: ic tanimlayicilar (composer/render contract) KORUNUR', () => {
  const composer = readSource('src/utils/suratDurusoftComposer.ts')
  assert.ok(composer.includes('composeSuratDurusoftLabel'))
  assert.ok(composer.includes('durusoft_composed'))
  const augmented = readSource('src/utils/augmentedSuratZpl.ts')
  assert.ok(augmented.includes('composeSuratDurusoftLabel'))
})

test('SYNC-STATUS-6: basarisiz yenileme onceki basariyi SILMEZ', () => {
  // ordersState.lastSyncedAt YALNIZ basarida yazilir; hicbir yerde
  // undefined'a cekilmez.
  const app = readSource('src/App.tsx')
  assert.ok(app.includes('lastSyncedAt: new Date().toISOString()'))
  assert.equal(/lastSyncedAt:\s*undefined/.test(app), false)
})

test('SYNC-STATUS-7: Dashboard ve Siparisler AYNI kanonik degeri alir', () => {
  const app = readSource('src/App.tsx')
  assert.ok(app.includes('lastSyncedAt={resolvedLastSyncedAt}'))
  assert.ok(app.includes('lastSyncAt={resolvedLastSyncedAt}'))
  assert.ok(
    app.includes('resolveLastSuccessfulSyncAt(orders, ordersState.lastSyncedAt)'),
    'tek kanonik kaynak',
  )
})

test('SYNC-STATUS-PERSIST: kalici okuma yolu sync damgasini URETIR', () => {
  // KOK NEDEN: rowToOrder bu alani hic uretmiyordu → auth modunda dashboard
  // fallback'i bos kaliyor ve reload sonrasi hep "Bekleniyor" gorunuyordu.
  const mapper = readSource('server/orders/orderMapper.ts')
  assert.ok(mapper.includes('lastMarketplaceSyncedAt'))
  assert.ok(mapper.includes('orderRow.lastSeenAt'))
})

test('SYNC-STATUS-NO-BACKEND-CHANGE: yeni endpoint/kolon/cache YOK', () => {
  const helper = withoutComments(readSource('src/utils/orderSyncStatus.ts'))
  assert.equal(helper.includes('fetch('), false)
  assert.equal(helper.includes('localStorage'), false)
  const mapper = readSource('server/orders/orderMapper.ts')
  assert.equal(mapper.includes('last_successful_sync_at'), false)
  // Sync algoritmasi / scheduler / normalize DEGISMEDI.
  const app = readSource('src/App.tsx')
  assert.ok(app.includes('resolveLastSuccessfulSyncAt'))
})
