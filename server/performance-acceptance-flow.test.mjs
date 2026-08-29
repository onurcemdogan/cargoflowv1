import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ UYGULAMA PERFORMANSI — YAPISAL BÜTÇELER ════════════════════════════
//
// ═══ NEDEN ZAMAN DEĞİL, BÜTÇE ═══════════════════════════════════════════
// CI'da milisaniye eşiği kırılgandır ve gürültüyle dalgalanır. Kalıcı olarak
// ölçülebilen şeyler YAPISALDIR:
//   • ilk JS bayt sayısı
//   • bir sayfa için DB sorgu sayısı
//   • Node'a dönen satır sayısı
//   • gezinmede pazaryeri çağrısı sayısı
// Bunlar regresyonu zamanlama gürültüsü olmadan yakalar. Süre ölçümleri
// ayrıca raporlanır, eşik olarak KULLANILMAZ.
//
// GERÇEK TAŞIYICI/PAZARYERİ ÇAĞRISI YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')

function migrationStatements() {
  const dir = join(root, 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

/** Sorguları SAYAN sarmalayıcı — gerçek sorgular çalışır, sadece sayılır. */
async function makeCountingDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const stats = { queries: 0, rows: 0 }
  const base = drizzle(pglite, { schema })
  const proxy = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === 'select' || property === 'execute') {
        return (...args) => {
          stats.queries += 1
          const result = value.apply(target, args)
          // Drizzle builder'ı thenable'dır; satır sayısını sonuçtan alırız.
          const originalThen = result?.then
          if (typeof originalThen === 'function') {
            const patched = Object.create(result)
            patched.then = (resolve, reject) =>
              originalThen.call(
                result,
                (rows) => {
                  if (Array.isArray(rows)) stats.rows += rows.length
                  return resolve ? resolve(rows) : rows
                },
                reject,
              )
            return patched
          }
          return result
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { pglite, db: proxy, stats }
}

async function seedOrders(db, organizationId, count) {
  const encryption = await import('./orders/orderEncryption.ts')
  const rows = []
  for (let index = 0; index < count; index += 1) {
    const packageId = `PERF-${String(index).padStart(7, '0')}`
    rows.push({
      organizationId, marketplace: 'Trendyol', packageId,
      orderNumber: `ORD-${packageId}`,
      orderDate: new Date(2026, 7, 1 + (index % 27)),
      cargoTrackingNumber: `72810${index}`,
      operationStatus: 'NEW',
      marketplaceStatus: index % 3 === 0 ? 'Picking' : 'Created',
      cargoProviderName: 'Surat Kargo',
      firstSeenAt: new Date(2026, 7, 1 + (index % 27)),
      totalAmount: String(100 + (index % 50)),
      rawPayloadEncrypted: encryption.encryptOrderPayload({
        orderNumber: `ORD-${packageId}`, id: packageId,
      }),
    })
  }
  // Toplu insert — parametre sınırını aşmamak için parçalanır.
  for (let start = 0; start < rows.length; start += 200) {
    await db.insert(schema.orders).values(rows.slice(start, start + 200))
  }
}

/* ═══ PERF-1 — İLK JS BÜTÇESİ ════════════════════════════════════════ */

test('PERF-1: ilk JS butcesi — rota kodu ilk yukte TASINMAZ', async () => {
  const assets = join(root, 'dist', 'assets')
  if (!existsSync(assets)) {
    // `npm run build` calistirilmadiysa olcum YAPILAMAZ; sessizce GECMEZ.
    assert.fail('dist/assets yok — once `npm run build` calistirin')
  }
  // GIRIS PARCASI `dist/index.html`'den okunur. Dosya listesi OTORITE
  // DEGILDIR: eski derlemelerden kalan `index-*.js` artiklari olcumu
  // yaniltir (temizlenmemis bir `dist` testi sessizce anlamsizlastirirdi).
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8')
  const entryMatch = html.match(/assets\/(index-[^"']+\.js)/)
  assert.ok(entryMatch, 'dist/index.html giris parcasini isaret etmiyor')
  const files = readdirSync(assets).filter((name) => name.endsWith('.js'))
  const entryBytes = statSync(join(assets, entryMatch[1])).size

  // OLCULEN TABAN : 815.264 bayt (tek parca, kod bolme YOK).
  // OLCULEN SONUC : 575.380 bayt (rota parcalari + ertelenen baski yigini).
  // Butce olculen degerin hemen ustunde: regresyon geri gelirse test DUSER.
  const BASELINE = 815_264
  const BUDGET = 620_000
  assert.ok(
    entryBytes <= BUDGET,
    `ilk JS ${entryBytes} bayt > butce ${BUDGET} (taban ${BASELINE})`,
  )

  // Rota parcalari GERCEKTEN ayrildi mi?
  const routeChunks = files.filter((name) => !name.startsWith('index-'))
  assert.ok(
    routeChunks.length >= 5,
    `rota parcasi bekleniyordu, bulunan ${routeChunks.length}`,
  )
  for (const expected of [
    'IntegrationsPage', 'IntegrationDebugPage', 'LabelTemplatesPage',
    'ProductsPage', 'CargoOperationsPage', 'AuditLogsPage',
  ]) {
    assert.ok(
      routeChunks.some((name) => name.startsWith(expected)),
      `${expected} ayri parcada DEGIL`,
    )
  }
})

/* ═══ PERF-2 — SİPARİŞ SAYFASI SORGU BÜTÇESİ ════════════════════════ */

test('PERF-2: tek siparis sayfasi SABIT sorgu sayisi (N+1 YOK)', async (t) => {
  const { pglite, db, stats } = await makeCountingDb()
  t.after(() => pglite.close())
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Perf', slug: `perf-${randomBytes(4).toString('hex')}` })
    .returning()
  await seedOrders(db, org.id, 300)

  const service = await import('./orders/orderPersistenceService.ts')

  // 25'lik sayfa
  stats.queries = 0
  stats.rows = 0
  const small = await service.listOrders(db, org.id, { page: 1, pageSize: 25 })
  const smallQueries = stats.queries
  const smallRows = stats.rows
  assert.equal(small.orders.length, 25)
  assert.equal(small.total, 300)

  // 100'luk sayfa — SORGU SAYISI ARTMAMALI (N+1 olsaydi 4 KAT artardi).
  stats.queries = 0
  stats.rows = 0
  const large = await service.listOrders(db, org.id, { page: 1, pageSize: 100 })
  assert.equal(large.orders.length, 100)
  assert.equal(
    stats.queries, smallQueries,
    `sorgu sayisi sayfa boyutuyla degisti: ${smallQueries} → ${stats.queries}`,
  )
  assert.ok(smallQueries <= 8, `sayfa basina ${smallQueries} sorgu cok fazla`)

  // Node'a donen satirlar SAYFA ile sinirli: tum tabloyu CEKMEZ.
  assert.ok(
    smallRows < 300,
    `25'lik sayfa icin ${smallRows} satir cekildi — tum tablo geliyor olabilir`,
  )
})

/* ═══ PERF-3 — SUNUCU TARAFI SAYFALAMA DOĞRULUĞU ════════════════════ */

test('PERF-3: sayfalama/siralama/filtre SUNUCUDA ve DOGRU', async (t) => {
  const { pglite, db } = await makeCountingDb()
  t.after(() => pglite.close())
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Perf', slug: `perf-${randomBytes(4).toString('hex')}` })
    .returning()
  await seedOrders(db, org.id, 120)
  const service = await import('./orders/orderPersistenceService.ts')

  const first = await service.listOrders(db, org.id, { page: 1, pageSize: 25 })
  const middle = await service.listOrders(db, org.id, { page: 3, pageSize: 25 })
  const last = await service.listOrders(db, org.id, { page: 5, pageSize: 25 })
  assert.equal(first.total, 120)
  assert.equal(first.orders.length, 25)
  assert.equal(middle.orders.length, 25)
  assert.equal(last.orders.length, 20, 'son sayfa kalan kayitlari dondurmeli')

  // Sayfalar AYRISIK olmali (ayni kayit iki sayfada olmamali).
  const ids = new Set()
  for (const page of [first, middle, last]) {
    for (const order of page.orders) {
      assert.ok(!ids.has(order.id), 'ayni kayit birden fazla sayfada')
      ids.add(order.id)
    }
  }

  // Siralama sunucuda uygulanir ve TERS cevrildiginde farkli sonuc verir.
  const desc = await service.listOrders(db, org.id, {
    page: 1, pageSize: 10, sort: 'orderDateDesc',
  })
  const asc = await service.listOrders(db, org.id, {
    page: 1, pageSize: 10, sort: 'orderDateAsc',
  })
  assert.notDeepEqual(
    desc.orders.map((o) => o.id), asc.orders.map((o) => o.id),
    'siralama SUNUCUDA uygulanmiyor',
  )

  // Sayfa boyutu tavani SESSIZCE asilamaz.
  const capped = await service.listOrders(db, org.id, { page: 1, pageSize: 99999 })
  assert.ok(capped.pageSize <= 500, 'sayfa boyutu tavani asildi')
})

/* ═══ PERF-4 — GEZİNME PAZARYERİNE ÇIKMAZ ═══════════════════════════ */

test('PERF-4: Pano/Siparisler gezinmesi TRENDYOL cagirmaz', async () => {
  // Gezinme yollari YALNIZ kalici yerel duruma dayanmalidir.
  const orders = readFileSync(join(root, 'src', 'pages', 'OrdersPage.tsx'), 'utf8')
  const dashboard = readFileSync(
    join(root, 'src', 'pages', 'DashboardPage.tsx'), 'utf8',
  )
  // "Trendyol" KELIMESI masumdur: pazaryeri etiketi, tip adi ve yorumlar
  // gezinmede ag cagrisi ANLAMINA GELMEZ. Olculmesi gereken sey PAZARYERI
  // CAGRISIDIR — bu sayfalar dogrudan fetch/sync tetiklememelidir.
  const NEWLINE = String.fromCharCode(10)
  for (const [name, source] of [['OrdersPage', orders], ['DashboardPage', dashboard]]) {
    const executable = source
      .split(NEWLINE)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join(NEWLINE)
    assert.ok(
      !/\bfetch\(|syncTrendyol|fetchTrendyol|callTrendyol/i.test(executable),
      `${name} gezinmede dogrudan pazaryeri/ag cagrisi yapiyor`,
    )
  }
  // Sunucu tarafi: /api/orders yalniz kalici DB'den okur.
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  const at = server.indexOf("app.get('/api/orders'")
  const handler = server.slice(at, at + 2000)
  assert.ok(!/fetchTrendyol|callTrendyol/i.test(handler), '/api/orders Trendyol cagiriyor')
})

/* ═══ PERF-5 — SAYFALAMA SÖZLEŞMESİ KORUNUR ════════════════════════ */

test('PERF-5: sayfalama sozlesmesi (25 varsayilan / 100 tavan) KORUNUR', async () => {
  // ═══ NEDEN BU TEST BOYLE ═══════════════════════════════════════════
  // Acilis yukunu azaltmak icin toplu sayfa boyutunu 500'e cikarmak
  // DENENDI ve GERI ALINDI: `?pageSize=<1..100>` sozlesmesi
  // `orderPagination.ts` basinda BELGELENMIS ve 20 testte dogrulanmistir.
  // Dogru cozum daha buyuk sayfa DEGIL, Siparisler icin sunucu tarafi
  // sayfalamadir; sozlesmeyi gevsetmek onun yerine GECMEZ.
  const repository = readFileSync(
    join(here, 'orders', 'orderRepository.ts'), 'utf8',
  )
  assert.match(repository, /const DEFAULT_PAGE_SIZE = 25/)
  assert.match(repository, /const MAX_PAGE_SIZE = 100/)

  const client = readFileSync(
    join(root, 'src', 'services', 'orderWorkflowService.ts'), 'utf8',
  )
  const match = client.match(/const ORDERS_LOAD_PAGE_SIZE = (\d+)/)
  assert.ok(match, 'ORDERS_LOAD_PAGE_SIZE bulunamadi')
  assert.ok(
    Number(match[1]) <= 100,
    `istemci sayfa boyutu ${match[1]} backend tavanini asiyor — sessiz kirpma`,
  )
  // Sinirsiz sorgu HICBIR yoldan mumkun olmamali.
  assert.match(repository, /Math\.min\(parsed, MAX_PAGE_SIZE\)/)
})

/* ═══ PERF-6 — ROTA İSKELETİ GLOBAL BLOKLAMAZ ═══════════════════════ */

test('PERF-6: rota yuklenirken kabuk KAYBOLMAZ (yerel iskelet)', async () => {
  const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8')
  // Her tembel rota KENDI Suspense sinirinda; tek global sarmalayici YOK.
  const boundaries = (app.match(/<Suspense fallback=\{<RouteSkeleton \/>\}>/g) ?? []).length
  assert.ok(boundaries >= 6, `beklenen >=6 yerel sinir, bulunan ${boundaries}`)
  // Kabuk (AppShell) tembel DEGIL: gezinme her zaman gorunur.
  assert.match(app, /import \{ AppShell \} from '\.\/components\/AppShell'/)
  // Ilk ekranlar (Pano/Siparisler) statik: gorunur bosluk olusmaz.
  assert.match(app, /import \{ DashboardPage \} from '\.\/pages\/DashboardPage'/)
  assert.match(app, /import \{ OrdersPage[^}]*\} from '\.\/pages\/OrdersPage'/)

  const skeleton = readFileSync(
    join(root, 'src', 'components', 'RouteSkeleton.tsx'), 'utf8',
  )
  assert.match(skeleton, /aria-busy="true"/)
  assert.match(skeleton, /aria-live="polite"/)
})

/* ═══ PERF-7 — BASKI YIĞINI İLK YÜKTE DEĞİL ════════════════════════ */

test('PERF-7: barkod/QR/ZPL yigini ILK YUKTE tasinmaz', async () => {
  const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8')
  // Statik import KALDIRILDI; talep uzerine yuklenir.
  assert.ok(
    !/^import \{[^}]*\} from '\.\/utils\/browserLabelPrint'/m.test(app),
    'browserLabelPrint hala statik import',
  )
  assert.match(app, /const loadPrintStack = \(\) => import\('\.\/utils\/browserLabelPrint'\)/)
  // Baski onizlemesi de tembel.
  assert.match(app, /const PrintPreviewModal = lazy\(/)

  // Barkod/QR kutuphaneleri yalniz baski yigininda.
  const printStack = readFileSync(
    join(root, 'src', 'utils', 'browserLabelPrint.ts'), 'utf8',
  )
  assert.match(printStack, /import JsBarcode from 'jsbarcode'/)
})

/* ═══ REG ══════════════════════════════════════════════════════════ */

test('PERF-REG: performans paketi kayitli ve komut mevcut', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts['test:performance:acceptance'])
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/performance-acceptance-flow.test.mjs'))
})
