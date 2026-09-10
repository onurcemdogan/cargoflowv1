import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ═══ YASAKLI DIS SAGLAYICI ADI — DUZ METIN OLARAK TUTULMAZ ══════════════
//
// Kural: kaldirilmis ucuncu taraf saglayici adi proje dosyalarinin HICBIR
// yerinde gecmemeli. Bu kurali uygulayan kontrol, adi ARAMAK zorundadir —
// ama adi kaynaga yazmak kuralin kendisini ihlal ederdi.
//
// Cozum: ad yerine tek yonlu SHA-256 ozeti tutulur. Kontrol, taranan metnin
// adaylarini ayni uzunlukta pencerelere bolup ozetlerini karsilastirir.
// Ozetten ad geri uretilemez; bolunmus dizgi veya base64 gibi tersine
// cevrilebilir bir maskeleme DE KULLANILMAZ.
const FORBIDDEN_VENDOR_TOKEN_SHA256 =
  '338272b74dfd70e2e4027ef5070ceccd6dddaafc52e19fa1d5ea80a3dd31f36c'
/** Aranan token'in karakter uzunlugu — pencere boyu; ad hakkinda bilgi tasimaz. */
const FORBIDDEN_VENDOR_TOKEN_LENGTH = 8

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * Metin, yasakli saglayici adini ICERIYOR MU?
 *
 * Kucuk harfe indirgenmis metinde, token uzunlugundaki HER alfanumerik
 * pencerenin ozeti karsilastirilir. Ad bir tanimlayicinin ORTASINDA da
 * gecebilecegi icin pencere sabitlenmez (`suratXComposer` gibi).
 */
function containsForbiddenVendor(text) {
  const lower = String(text).toLowerCase()
  const length = FORBIDDEN_VENDOR_TOKEN_LENGTH
  for (let start = 0; start + length <= lower.length; start += 1) {
    let alphanumeric = true
    for (let index = start; index < start + length; index += 1) {
      const code = lower.charCodeAt(index)
      const isDigit = code >= 48 && code <= 57
      const isLetter = code >= 97 && code <= 122
      if (!isDigit && !isLetter) {
        start = index // alfanumerik olmayan karakteri atla
        alphanumeric = false
        break
      }
    }
    if (!alphanumeric) continue
    if (sha256(lower.slice(start, start + length)) === FORBIDDEN_VENDOR_TOKEN_SHA256) {
      return true
    }
  }
  return false
}

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

test('COPY-1: kullaniciya gorunen hicbir yuzeyde saglayici adi YOK', () => {
  for (const relative of UI_SOURCES) {
    const visible = withoutComments(readSource(relative))
    assert.equal(
      containsForbiddenVendor(visible),
      false,
      `${relative} kullaniciya gorunen metinde dis saglayici adi tasimamali`,
    )
  }
})

test('COPY-1b: DEPONUN TAMAMINDA dis saglayici adi YOK (muhafizin kendisi DAHIL)', () => {
  // Kabul kriteri calistirilabilir: yorumlarda, testlerde, fixture'larda,
  // dosya adlarinda ve BU DOSYADA da geri gelemez. Ad artik yalnizca ozet
  // olarak tutuldugu icin muhafizin kendisi de kapsam ICINDEDIR.
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const offenders = []
  for (const relative of tracked) {
    if (containsForbiddenVendor(relative)) offenders.push(`${relative} (dosya adi)`)
    let content
    try {
      content = readFileSync(relative, 'utf8')
    } catch {
      continue // ikili dosya veya okunamiyor
    }
    if (containsForbiddenVendor(content)) offenders.push(relative)
  }
  assert.deepEqual(
    offenders,
    [],
    `dis saglayici adi geri gelmis: ${offenders.join(', ')}`,
  )
})

test('COPY-2: tooltip marka bagimsiz metni gosterir', () => {
  const dashboard = readSource('src/pages/DashboardPage.tsx')
  assert.ok(
    dashboard.includes(
      'Satış raporlarında aynı gün sınırı kullanılır. Sipariş saatleri Türkiye saatiyle gösterilmeye devam eder.',
    ),
  )
  // Hicbir `title` ipucu dis saglayici adini tasimaz. Eskiden yalnizca adla
  // BASLAYAN ipucu araniyordu; artik TUM title degerleri kontrol edilir.
  const titles = [...dashboard.matchAll(/title="([^"]*)"/g)].map(
    (match) => match[1],
  )
  for (const title of titles) {
    assert.equal(
      containsForbiddenVendor(title),
      false,
      `tooltip dis saglayici adi tasimamali: ${title}`,
    )
  }
})

test('COPY-3: rapor gunu / saat davranisi DEGISMEDI', () => {
  const range = readSource('src/dashboard/reportingRange.ts')
  assert.ok(range.includes('UTC'))
  const metric = readSource('src/dashboard/dashboardSalesMetricDefinition.ts')
  assert.ok(metric.includes('SALES_DATE_BASIS'))
})

test('COPY-4: ic tanimlayicilar (composer/render contract) KORUNUR', () => {
  const composer = readSource('src/utils/suratLabelComposer.ts')
  assert.ok(composer.includes('composeSuratLabel'))
  assert.ok(composer.includes('carrier_composed'))
  const augmented = readSource('src/utils/augmentedSuratZpl.ts')
  assert.ok(augmented.includes('composeSuratLabel'))
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
