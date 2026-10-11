// LANDING-001 — TANITIM SAYFASI SÖZLEŞMELERİ (Node).
//
// Vitest CSS hattı `?raw` içeriğini boşalttığından CSS sözleşmeleri burada,
// dosya doğrudan okunarak sınanır. Paket yalıtımı DERLENMİŞ `dist` üzerinden
// ölçülür — kaynak yapısından ÇIKARIM yapılmaz.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

test('LAND-UI-7: taşma sözleşmesi — kök yatay taşmayı keser, ızgaralar esner, stil KAPSAMLI', () => {
  const raw = read('src/landing/landing.css')
  const css = raw.replace(/\s+/g, ' ')
  assert.match(css, /\.landing-root \{[^}]*overflow-x: clip/)
  assert.match(css, /\.landing-root img \{ max-width: 100%; \}/)
  for (const breakpoint of ['1024px', '768px', '560px']) {
    assert.ok(css.includes(`@media (max-width: ${breakpoint})`), `${breakpoint} kırılımı`)
  }
  // Sabit piksel ızgara sütunu YOK (yalnız minmax(0, …) / esnek).
  for (const match of raw.matchAll(/grid-template-columns:([^;]+);/g)) {
    assert.doesNotMatch(match[1], /^\s*\d{3,}px\s*$/, `sabit ızgara: ${match[1]}`)
  }
  // Stil sayfası giriş parçasıyla yüklenir: YALNIZ `.landing-*` hedeflenir,
  // uygulama sayfalarına SIZMAZ (html/body/genel seçici YOK).
  const selectors = [...raw.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|\})\s*([^{}@]+)\{/g)]
    .map((match) => match[2].trim())
    .filter((selector) => selector && !/^(from|to|\d+%)$/.test(selector))
  assert.ok(selectors.length > 20)
  for (const selector of selectors) {
    for (const part of selector.split(',')) {
      assert.match(part.trim(), /^\.landing-/, `kapsam dışı seçici: ${part.trim()}`)
    }
  }
  // Harici yazı tipi / CDN / uzak görsel YOK.
  assert.doesNotMatch(raw, /@import|url\(\s*['"]?https?:/i)
})

test('LAND-UI-9: hareket azaltma tercihi süs animasyonlarını KAPATIR; sürekli animasyon YOK', () => {
  const raw = read('src/landing/landing.css')
  const css = raw.replace(/\s+/g, ' ')
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{ \.landing-root \*, \.landing-root \*::before, \.landing-root \*::after \{ animation: none !important; transition: none !important;/,
  )
  assert.doesNotMatch(raw, /infinite/)
})

test('LAND-ROUTE-5: üretim SPA geri dönüşü /app dahil her GET yolunu index.html ile karşılar', () => {
  const index = read('server/index.mjs')
  const start = index.indexOf("if (process.env.NODE_ENV === 'production' && existsSync(indexHtmlPath))")
  assert.ok(start > 0, 'üretim statik bloğu bulunamadı')
  const block = index.slice(start, index.indexOf('\n}\n', start))
  // Yol süzgeci YOK: yalnız yöntem GET kontrolü → /app 404 VERMEZ.
  assert.match(block, /if \(request\.method !== 'GET'\)/)
  assert.match(block, /response\.sendFile\(indexHtmlPath/)
  assert.doesNotMatch(block, /request\.path|request\.url|startsWith\('\/app'\)/)
  // API 404 işleyicisi geri dönüşten ÖNCE: /api istekleri SPA'ya DÜŞMEZ.
  assert.ok(index.indexOf("'API endpoint bulunamadı.'") < start)
  // nginx tüm yolları uygulama sunucusuna iletir.
  const nginx = read('deploy/nginx/cargoflow.conf')
  assert.match(nginx, /location \/ \{\s*proxy_pass http:\/\/127\.0\.0\.1:8787;/)
})

test('LAND-BUNDLE-1: `/` giriş parçası operasyon kodunu ve uygulama stilini YÜKLEMEZ', () => {
  const dist = join(root, 'dist')
  const html = existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : ''
  if (!html) assert.fail('dist/index.html yok — önce `npm run build` çalıştırın')
  const entryName = html.match(/assets\/(index-[^"']+\.js)/)?.[1]
  const entryCssName = html.match(/assets\/(index-[^"']+\.css)/)?.[1]
  assert.ok(entryName && entryCssName, 'giriş parçaları index.html içinde')
  const entry = readFileSync(join(dist, 'assets', entryName), 'utf8')

  // Tanıtım GİRİŞTE; uygulama/yönetici dalları AYRI (tembel) parçalarda.
  assert.ok(entry.includes('Siparişten kargo etiketine tek operasyon akışı.'))
  const organizationChunk = entry.match(/OrganizationApp-[A-Za-z0-9_-]+\.js/)?.[0]
  const adminChunk = entry.match(/AdminEntry-[A-Za-z0-9_-]+\.js/)?.[0]
  assert.ok(organizationChunk, 'OrganizationApp ayrı parça')
  assert.ok(adminChunk, 'AdminEntry ayrı parça')

  // Operasyon/kimlik kodu girişte YOK.
  for (const marker of [
    '/api/auth/me',
    '/api/onboarding',
    '/api/orders',
    '/api/products',
    '/api/integrations',
    '/api/platform-admin',
    'Oturum kontrol ediliyor',
    'Kurulum durumu kontrol ediliyor',
  ]) {
    assert.equal(entry.includes(marker), false, `giriş parçası "${marker}" içeriyor`)
  }
  // Tek `fetch(` Vite'ın modulepreload çoklu doldurmasıdır (varlık önyüklemesi).
  const fetches = [...entry.matchAll(/fetch\(([^,)]+)/g)].map((match) => match[1])
  assert.deepEqual(fetches, ['e.href'], `beklenmeyen fetch: ${fetches.join(', ')}`)

  // Başlangıç stili YALNIZ tanıtım stilidir; uygulamanın genel stili dalla gelir.
  const entryCss = readFileSync(join(dist, 'assets', entryCssName), 'utf8')
  assert.ok(entryCss.includes('.landing-root'))
  assert.equal(entryCss.includes('.app-shell'), false, 'uygulama stili girişte')
  assert.ok(statSync(join(dist, 'assets', entryCssName)).size < 20_000)

  // Uygulamanın ilk yükü (giriş + organizasyon dalı) PERF-1 bütçesini AŞMAZ.
  const appInitial =
    statSync(join(dist, 'assets', entryName)).size +
    statSync(join(dist, 'assets', organizationChunk)).size
  assert.ok(appInitial <= 620_000, `uygulama ilk JS ${appInitial} > 620000`)
})
