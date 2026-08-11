import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, before } from 'node:test'

// GECICI STATU HATASI ICIN SINIRLI YENIDEN DENEME.
//
// URETIM GOZLEMI: "Simdi Yenile" bazen
//   "Senkron kismi kaldi ... Basarisiz statuler: Delivered — yeniden
//    denenebilir ... Sunucu kaydi silinmedi; 2382 siparis korundu."
// uyarisi veriyor; kullanici biraz sonra tekrar bastiginda ayni istek
// sorunsuz tamamlaniyor. Yani hata GECICI.
//
// SOZLESME:
//   · YALNIZ dusen statu yeniden denenir (basarililar TEKRAR CEKILMEZ),
//   · sayfalama dusen SAYFADAN devam eder,
//   · yalniz retryable sinif denenir (401/403/400 DENENMEZ),
//   · denemeler tukenirse mevcut PARTIAL sozlesmesi ve veri guvencesi KORUNUR.
//
// Surat/SSP, ZPL/etiket, retention, stage resolver, paket kimligi guard'i,
// hesap kapsami ve freshness merge KAPSAM DISIDIR.

const SOURCE = readFileSync('server/index.mjs', 'utf8')

// Gercek beklemeleri kisaltir (sozlesme ayni, sure kisa).
const ORIGINAL_DELAYS = process.env.TRENDYOL_STATUS_RETRY_DELAYS_MS
before(() => {
  process.env.TRENDYOL_STATUS_RETRY_DELAYS_MS = '1,2,3'
})
after(() => {
  if (ORIGINAL_DELAYS === undefined) {
    delete process.env.TRENDYOL_STATUS_RETRY_DELAYS_MS
  } else {
    process.env.TRENDYOL_STATUS_RETRY_DELAYS_MS = ORIGINAL_DELAYS
  }
})

/**
 * `retryTrendyolStatusPass` + yardimcilarini index.mjs'ten IZOLE calistirir
 * (express uygulamasini BOOT ETMEDEN). `callTrendyolOrdersForStatus` disaridan
 * enjekte edilir; boylece ag cagrisi YAPILMAZ.
 */
function loadRetry(callForStatus) {
  const lines = SOURCE.split(/\r?\n/)
  const names = [
    'const TRENDYOL_STATUS_RETRY_DELAYS_MS',
    'const TRENDYOL_STATUS_RETRY_MAX_DELAY_MS',
    'const TRENDYOL_STATUS_RETRY_BUDGET_MS',
    'function getStatusRetryBudgetMs',
    'function getStatusRetryDelaysMs',
    'function resolveStatusRetryDelayMs',
    'function isRetryableTrendyolStatus',
    'async function retryTrendyolStatusPass',
  ]
  const blocks = names.map((needle) => {
    const start = lines.findIndex((line) => line.startsWith(needle))
    assert.ok(start >= 0, `bulunamadi: ${needle}`)
    if (needle.startsWith('const')) return lines[start]
    const end = lines.findIndex((line, index) => index > start && line === '}')
    return lines.slice(start, end + 1).join('\n')
  })
  const factory = new Function(
    'callTrendyolOrdersForStatus',
    `${blocks.join('\n\n')}\nreturn { retryTrendyolStatusPass, isRetryableTrendyolStatus, resolveStatusRetryDelayMs, getStatusRetryDelaysMs, getStatusRetryBudgetMs }`,
  )
  return factory(callForStatus)
}

const fail = (statusCode, overrides = {}) => ({
  ok: false,
  source: 'real',
  statusCode,
  message: 'gecici hata',
  ...overrides,
})
const success = (content = []) => ({
  ok: true,
  source: 'real',
  statusCode: 200,
  message: 'Gerçek API başarılı.',
  data: { content },
})

// ═══ RETRYABLE SINIFLANDIRMA ══════════════════════════════════════════════

test('SYNC-RETRY-4: kalici hatalar (400/401/403) TEKRAR DENENMEZ', async () => {
  let calls = 0
  const { retryTrendyolStatusPass, isRetryableTrendyolStatus } = loadRetry(
    async () => {
      calls += 1
      return success()
    },
  )
  for (const code of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableTrendyolStatus(code), false, String(code))
  }
  const result = await retryTrendyolStatusPass({}, {}, 'Delivered', fail(401))
  assert.equal(result.ok, false)
  assert.equal(calls, 0, 'tek bir istek bile YAPILMAZ')
})

test('SYNC-RETRY-ALLOWLIST: 429/5xx ve ag hatasi retryable', async () => {
  const { isRetryableTrendyolStatus } = loadRetry(async () => success())
  for (const code of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableTrendyolStatus(code), true, String(code))
  }
  // Ag hatasi: statusCode yok/0 (ECONNRESET, ETIMEDOUT, DNS/TLS, abort).
  for (const code of [undefined, null, 0, NaN]) {
    assert.equal(isRetryableTrendyolStatus(code), true, String(code))
  }
})

// ═══ GECICI HATADAN KURTULMA ══════════════════════════════════════════════

test('SYNC-RETRY-1: 503 sonra basari → statu BASARILI doner', async () => {
  let calls = 0
  const { retryTrendyolStatusPass } = loadRetry(async () => {
    calls += 1
    return success([{ packageId: '1' }])
  })
  const result = await retryTrendyolStatusPass({}, {}, 'Delivered', fail(503))
  assert.equal(result.ok, true)
  assert.equal(calls, 1, 'tek yeniden deneme yetti')
  assert.equal(result.debug.statusRetryAttempts, 1)
})

test('SYNC-RETRY-2: ag hatasi (ECONNRESET) yeniden denenir', async () => {
  let calls = 0
  const { retryTrendyolStatusPass } = loadRetry(async () => {
    calls += 1
    // Ilk yeniden deneme de duser, ikincisi basarili olur.
    return calls === 1 ? fail(undefined) : success()
  })
  const result = await retryTrendyolStatusPass(
    {},
    {},
    'Delivered',
    fail(undefined, { message: 'ECONNRESET' }),
  )
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
  assert.equal(result.debug.statusRetryAttempts, 2)
})

test('SYNC-RETRY-3: 429 Retry-After saygi gorur ama TAVAN asilmaz', async () => {
  const { resolveStatusRetryDelayMs } = loadRetry(async () => success())
  // Retry-After taban gecikmeden buyukse ona saygi gosterilir.
  const respected = resolveStatusRetryDelayMs(0, {
    statusCode: 429,
    debug: { retryAfterMs: 5000 },
  })
  assert.ok(respected >= 5000, `Retry-After uygulanmali: ${respected}`)
  // ANCAK sert tavan asilamaz (kullanici butonu kilitlenmesin).
  const capped = resolveStatusRetryDelayMs(0, {
    statusCode: 429,
    debug: { retryAfterMs: 600_000 },
  })
  assert.equal(capped, 8000, 'tavan 8 sn')
  // 429 disinda Retry-After DIKKATE ALINMAZ.
  const plain = resolveStatusRetryDelayMs(0, {
    statusCode: 503,
    debug: { retryAfterMs: 600_000 },
  })
  assert.ok(plain <= 8000)
})

test('SYNC-RETRY-5: denemeler tukenirse SON sonuc aynen doner', async () => {
  let calls = 0
  const { retryTrendyolStatusPass } = loadRetry(async () => {
    calls += 1
    return fail(503)
  })
  const result = await retryTrendyolStatusPass({}, {}, 'Delivered', fail(503))
  assert.equal(result.ok, false)
  assert.equal(calls, 3, 'en fazla 3 yeniden deneme')
  assert.equal(result.debug.statusRetryAttempts, 3)
  // Mevcut kismi/basarisiz sozlesmesi BOZULMAZ.
  assert.equal(result.statusCode, 503)
})

// ═══ SAYFA DEVAMLILIGI ════════════════════════════════════════════════════

test('SYNC-RETRY-7: dusen SAYFADAN devam edilir, sayfa 0 tekrar ISTENMEZ', async () => {
  const seen = []
  const { retryTrendyolStatusPass } = loadRetry(async (_credentials, query) => {
    seen.push({ page: query.page, carried: query.carryOverContent?.length ?? 0 })
    return success([{ packageId: 'p2' }])
  })
  const first = fail(503, {
    failedPage: 2,
    partialContent: [{ packageId: 'p0' }, { packageId: 'p1' }],
  })
  const result = await retryTrendyolStatusPass({}, {}, 'Delivered', first)
  assert.equal(result.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].page, 2, 'dusen sayfadan devam')
  assert.equal(seen[0].carried, 2, 'onceki sayfalar TASINIR')
})

test('SYNC-RETRY-7b: failedPage yoksa normal (bastan) deneme yapilir', async () => {
  const seen = []
  const { retryTrendyolStatusPass } = loadRetry(async (_credentials, query) => {
    seen.push(query.page)
    return success()
  })
  await retryTrendyolStatusPass({}, {}, 'Delivered', fail(503))
  assert.deepEqual(seen, [undefined], 'sayfa zorlanmaz')
})

// ═══ KAYNAK SOZLESMESI ════════════════════════════════════════════════════

test('SYNC-RETRY-6: YALNIZ dusen statuler yeniden denenir', () => {
  const lines = SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function callTrendyolOrdersByStatusesFiltered'),
  )
  assert.ok(start >= 0)
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines
    .slice(start, end)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  // Basarili statu ATLANIR.
  assert.ok(body.includes('if (entry.result.ok) continue'))
  // Kalici hata ATLANIR.
  assert.ok(
    body.includes('if (!isRetryableTrendyolStatus(entry.result.statusCode)) continue'),
  )
  assert.ok(body.includes('retryTrendyolStatusPass('))
})

test('SYNC-RETRY-8: PARTIAL veri guvencesi ve reconcile sozlesmesi KORUNUR', () => {
  // Kismi sonuc hala 207/partial olarak raporlanir ve mevcut liste korunur.
  assert.ok(SOURCE.includes("syncStatus: 'PARTIAL'"))
  assert.ok(SOURCE.includes('partial: true'))
  assert.ok(SOURCE.includes('Mevcut tam liste korunur.'))
  // Arsiv/reconcile YALNIZ COMPLETE sync'te calisir.
  assert.ok(
    SOURCE.includes("const complete = Boolean(result.ok) && syncStatus === 'COMPLETE'"),
  )
  // Arka plan turu reconcile ETMEZ (complete:false) — cadence degismedi.
  assert.ok(SOURCE.includes('complete: false'))
  assert.ok(SOURCE.includes('resolveActiveMarketplaceAccountId('))
})

test('SYNC-RETRY-BOUNDS: gecikmeler sinirli ve yapilandirilabilir', () => {
  const { getStatusRetryDelaysMs } = loadRetry(async () => success())
  // Test ortami kisa gecikme enjekte edebilir; uzunluk ust siniri 3.
  assert.ok(getStatusRetryDelaysMs().length <= 3)
  assert.ok(SOURCE.includes('const TRENDYOL_STATUS_RETRY_DELAYS_MS = [1000, 3000, 7000]'))
  assert.ok(SOURCE.includes('const TRENDYOL_STATUS_RETRY_MAX_DELAY_MS = 8000'))
})

test('SYNC-RETRY-SCOPE: kapsam disi katmanlar DEGISMEDI', () => {
  // Paket kimligi guard'i, hesap kapsami, freshness merge, stale-open yerinde.
  assert.ok(SOURCE.includes('function resolveTrendyolPackageIdentity'))
  assert.ok(SOURCE.includes('incomingIsNewer'))
  assert.ok(SOURCE.includes('startStaleOpenReconcileOnBoot'))
  assert.ok(SOURCE.includes('const marketplaceStatus = normalizeStatus(item.status)'))
  // Yeniden deneme yardimcisi tasiyici/etiket katmanina DOKUNMAZ.
  const lines = SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function retryTrendyolStatusPass'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n').toLowerCase()
  for (const forbidden of ['surat', 'zpl', 'barkod', 'persistsyncresult']) {
    assert.equal(body.includes(forbidden), false, forbidden)
  }
})

test('SYNC-RETRY-BUDGET: TUM senkron icin tek ust sinir', async () => {
  let calls = 0
  const { retryTrendyolStatusPass, getStatusRetryBudgetMs } = loadRetry(
    async () => {
      calls += 1
      return fail(503)
    },
  )
  // Varsayilan butce ve tavan.
  assert.equal(getStatusRetryBudgetMs(), 10_000)
  assert.ok(SOURCE.includes('const TRENDYOL_STATUS_RETRY_BUDGET_MS = 10_000'))

  // Gecmis bir deadline → HIC deneme yapilmaz.
  const result = await retryTrendyolStatusPass(
    {},
    {},
    'Delivered',
    fail(503),
    Date.now() - 1,
  )
  assert.equal(calls, 0, 'butce dolduysa istek YOK')
  assert.equal(result.debug.statusRetryBudgetExhausted, true)
  assert.equal(result.ok, false)
})

test('SYNC-RETRY-BUDGET-2: butce statu dongusunde de uygulanir', () => {
  const lines = SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function callTrendyolOrdersByStatusesFiltered'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.ok(body.includes('const retryDeadlineMs = Date.now() + getStatusRetryBudgetMs()'))
  assert.ok(body.includes('if (Date.now() >= retryDeadlineMs) break'))
  assert.ok(body.includes('retryDeadlineMs,'))
})
