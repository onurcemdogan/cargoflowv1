import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// P2/B3 — SINIRLI ÇEKİM · SINIFLANDIRILMIŞ BACKOFF · 429/Retry-After.
//
// DENETİM DÜZELTMESİ. P2_AUDIT bu üç maddeyi "ölçülmedi" / "görülmedi" diye
// AÇIK bırakmıştı. Kod okundu: ÜÇÜ DE VAR. P1 dersi ("zaten var" iddiası
// ölçülmeden yazılmaz) ters yönde de geçerlidir — "YOK" iddiası da ölçülmeden
// yazılmaz. Bu dosya davranışı kilitler ki gelecekte sessizce kaybolmasın.
//
// Ağ YOK: saf yardımcılar index.mjs'ten IZOLE çalıştırılır (boot YOK).

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, 'index.mjs'), 'utf8')
  .split('\r\n')
  .join('\n')
const LINES = SOURCE.split('\n')

/** Adı verilen üst düzey bildirimi kaynaktan aynen çıkarır. */
function block(prefix) {
  const start = LINES.findIndex((line) => line.startsWith(prefix))
  assert.ok(start >= 0, `bulunamadi: ${prefix}`)
  if (prefix.startsWith('const ') && LINES[start].includes('=') &&
      !LINES[start].trimEnd().endsWith('{')) {
    return LINES[start]
  }
  const end = LINES.findIndex((line, index) => index > start && line === '}')
  assert.ok(end > start, `kapanmadi: ${prefix}`)
  return LINES.slice(start, end + 1).join('\n')
}

function load(names, returns) {
  return new Function(
    `${names.map(block).join('\n\n')}\nreturn ${returns}`,
  )()
}

/* ═══ SINIFLANDIRMA: kalıcı hata TEKRAR DENENMEZ ═════════════════════ */

test('B3P-1: gecici/kalici hata AYRILIR', () => {
  const isRetryable = load(['function isRetryableTrendyolStatus'],
    'isRetryableTrendyolStatus')
  // Gecici: rate limit, 5xx, ag hatasi (kod yok/0).
  assert.equal(isRetryable(429), true, '429 tekrar denenmeli')
  assert.equal(isRetryable(500), true)
  assert.equal(isRetryable(502), true)
  assert.equal(isRetryable(599), true)
  assert.equal(isRetryable(0), true, 'ag hatasi tekrar denenmeli')
  assert.equal(isRetryable(undefined), true)
  // Kalici: credential/validation. Tekrar denemek YALNIZ yuk uretir.
  assert.equal(isRetryable(400), false)
  assert.equal(isRetryable(401), false, '401 tekrar denenirse hesap kilitlenir')
  assert.equal(isRetryable(403), false)
  assert.equal(isRetryable(404), false)
})

test('B3P-2: cekim dongusu de AYNI siniflandirmayi uygular', () => {
  // callTrendyolOrders icindeki dongude 429/5xx/ag ayrimi ACIKCA yapilir ve
  // kalici 4xx break eder.
  assert.match(SOURCE, /const isRateLimited = code === 429/)
  assert.match(SOURCE, /const isServerError = code >= 500 && code <= 599/)
  assert.match(
    SOURCE,
    /const isNetworkError = !result\.ok && \(!Number\.isFinite\(code\) \|\| code === 0\)/,
  )
  assert.match(
    SOURCE,
    /if \(result\.ok \|\| !isTransient \|\| attempt === retryDelaysMs\.length\)/,
  )
})

/* ═══ BACKOFF SINIRLI: sonsuz retry YOK ══════════════════════════════ */

test('B3P-3: cekim backoff suresi USTEL ve SAYICA SINIRLI', () => {
  const originalEnv = process.env.TRENDYOL_ORDER_RETRY_DELAYS_MS
  try {
    delete process.env.TRENDYOL_ORDER_RETRY_DELAYS_MS
    const getDelays = load(['function getOrderRetryDelaysMs'],
      'getOrderRetryDelaysMs')
    const delays = getDelays()
    assert.deepEqual(delays, [2000, 4000, 8000], 'ustel gecikme bekleniyor')
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i] > delays[i - 1], 'gecikme ARTMIYOR')
    }
    // En cok 3 gecikme → en cok 4 istek. Sonsuz retry MUMKUN DEGIL.
    assert.ok(delays.length <= 3, `retry sayisi sinirsiz: ${delays.length}`)

    // Enjekte edilen deger de UST SINIRA kelepcelenir.
    process.env.TRENDYOL_ORDER_RETRY_DELAYS_MS = '1,2,3,4,5,6,7,8,9'
    assert.equal(getDelays().length, 3, 'enjekte edilen liste kelepcelenmedi')
    // Bozuk/bos deger VARSAYILANA duser (retry'i kapatmaz).
    process.env.TRENDYOL_ORDER_RETRY_DELAYS_MS = '   '
    assert.deepEqual(getDelays(), [2000, 4000, 8000])
    process.env.TRENDYOL_ORDER_RETRY_DELAYS_MS = 'abc,def'
    assert.deepEqual(getDelays(), [2000, 4000, 8000])
  } finally {
    if (originalEnv === undefined) delete process.env.TRENDYOL_ORDER_RETRY_DELAYS_MS
    else process.env.TRENDYOL_ORDER_RETRY_DELAYS_MS = originalEnv
  }
})

test('B3P-4: statu gecisi backoff suresi de sinirli ve BUTCELI', () => {
  const original = process.env.TRENDYOL_STATUS_RETRY_BUDGET_MS
  try {
    delete process.env.TRENDYOL_STATUS_RETRY_BUDGET_MS
    const getBudget = load(
      ['const TRENDYOL_STATUS_RETRY_BUDGET_MS', 'function getStatusRetryBudgetMs'],
      'getStatusRetryBudgetMs',
    )
    assert.equal(getBudget(), 10_000)
    // Bos deger Number('') ile 0'a duserse retry TAMAMEN kapanirdi.
    process.env.TRENDYOL_STATUS_RETRY_BUDGET_MS = ''
    assert.equal(getBudget(), 10_000, 'bos deger retry kapatti')
    // Butce UST SINIRLI: kullanici suresiz bekletilmez.
    process.env.TRENDYOL_STATUS_RETRY_BUDGET_MS = '999999'
    assert.equal(getBudget(), 30_000)
  } finally {
    if (original === undefined) delete process.env.TRENDYOL_STATUS_RETRY_BUDGET_MS
    else process.env.TRENDYOL_STATUS_RETRY_BUDGET_MS = original
  }
})

/* ═══ 429 / Retry-After GERÇEKTEN OKUNUR ═════════════════════════════ */

test('B3P-5: Retry-After saniye ve HTTP tarihi olarak COZULUR', () => {
  const parse = load(['function parseRetryAfterMs'], 'parseRetryAfterMs')
  assert.equal(parse('5'), 5000, 'saniye formati cozulmedi')
  assert.equal(parse('0'), 0)
  assert.equal(parse(''), 0)
  assert.equal(parse(null), 0)
  assert.equal(parse('cok-yakinda'), 0, 'anlamsiz deger 0 olmali')
  // Ust sinir: saglayici 1 saat derse sunucu 1 saat BEKLEMEZ.
  assert.equal(parse('3600'), 60_000, 'Retry-After ust siniri uygulanmadi')
  // HTTP-date formu da desteklenir ve sinirlanir.
  const future = new Date(Date.now() + 10_000).toUTCString()
  const parsed = parse(future)
  assert.ok(parsed > 0 && parsed <= 60_000, `HTTP-date cozulmedi: ${parsed}`)
  // GECMIS tarih negatif bekleme URETMEZ.
  assert.equal(parse(new Date(Date.now() - 60_000).toUTCString()), 0)
})

test('B3P-6: 429 gecikmesi Retry-After ile TABANDAN buyuk olur', () => {
  const original = process.env.TRENDYOL_STATUS_RETRY_DELAYS_MS
  try {
    delete process.env.TRENDYOL_STATUS_RETRY_DELAYS_MS
    const resolve = load(
      [
        'const TRENDYOL_STATUS_RETRY_DELAYS_MS',
        'const TRENDYOL_STATUS_RETRY_MAX_DELAY_MS',
        'function getStatusRetryDelaysMs',
        'function resolveStatusRetryDelayMs',
      ],
      'resolveStatusRetryDelayMs',
    )
    // 429 + Retry-After: taban gecikme YETMEZ, saglayicinin dedigi beklenir.
    const withRetryAfter = resolve(0, {
      statusCode: 429,
      debug: { retryAfterMs: 6000 },
    })
    assert.ok(
      withRetryAfter >= 6000,
      `Retry-After yok sayildi: ${withRetryAfter}`,
    )
    // Her halukarda UST SINIR uygulanir.
    const huge = resolve(0, { statusCode: 429, debug: { retryAfterMs: 900_000 } })
    assert.ok(huge <= 8000, `ust sinir asildi: ${huge}`)
    // 429 OLMAYAN gecici hata Retry-After'i KULLANMAZ (taban + jitter).
    const server = resolve(0, { statusCode: 502, debug: { retryAfterMs: 6000 } })
    assert.ok(server <= 8000)
  } finally {
    if (original === undefined) delete process.env.TRENDYOL_STATUS_RETRY_DELAYS_MS
    else process.env.TRENDYOL_STATUS_RETRY_DELAYS_MS = original
  }
})

test('B3P-7: Retry-After yaniti gercekten TASINIR', () => {
  // Header parse edilip debug'a konur; retry yolu oradan okur.
  assert.match(
    SOURCE,
    /retryAfterMs: parseRetryAfterMs\(response\.headers\.get\('retry-after'\)\)/,
  )
  assert.match(SOURCE, /const retryAfterMs = Number\(result\.debug\?\.retryAfterMs \?\? 0\)/)
})

/* ═══ SINIRLI ÇEKİM (bounded pull) ═══════════════════════════════════ */

test('B3P-8: sayfa sayisi UST SINIRLI (sonsuz sayfalama YOK)', () => {
  assert.match(
    SOURCE,
    /const maxPages = Math\.min\(totalPages, Number\(query\.maxPages \?\? 100\)\)/,
    'sayfalama ust siniri kaldirilmis',
  )
  // Dongu maxPages ile sinirlidir; saglayici totalPages sismis dese bile
  // istemci tarafi sinir korunur.
  assert.match(SOURCE, /for \(let page = firstPage \+ 1; page < maxPages; page \+= 1\)/)
})

test('B3P-9: sayfa boyutu 200 ile KELEPCELENIR', () => {
  assert.match(
    SOURCE,
    /size: String\(Math\.min\(Number\(query\.size \?\? 20\), 200\)\)/,
    'sayfa boyutu kelepcesi kaldirilmis',
  )
})

test('B3P-10: tarih araligi 30 gun ile SINIRLI kalir', () => {
  // Artimli pencere bu sinirin ICINDE kalmali; imlec + emniyet payi bunu
  // asamaz (24 saat + artimli aralik ≪ 30 gun).
  assert.match(SOURCE, /const maxRangeMs = 1000 \* 60 \* 60 \* 24 \* 30/)
  assert.match(SOURCE, /if \(endDate - startDate > maxRangeMs\)/)
  assert.match(SOURCE, /if \(endDate < startDate\)/)
})

test('B3P-11: dusen sayfa BASTAN degil KALDIGI yerden devam eder', () => {
  // Sinirli cekimin ikinci yuzu: kismi sonuc ve dusen sayfa numarasi TASINIR,
  // yeniden deneme sayfa 0'dan baslamaz (istek sayisi ikiye katlanmaz).
  assert.match(SOURCE, /partialContent: combinedContent/)
  assert.match(SOURCE, /failedPage: page/)
})
