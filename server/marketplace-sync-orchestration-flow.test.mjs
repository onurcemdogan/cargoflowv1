import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// B3 — ARKA PLAN ARTIMLI SENKRON ORKESTRASYONU.
//
// En kritik davranış: istek sağlayıcı turunu BEKLEMEZ. İkincisi: aynı tenant
// için asla iki paralel sağlayıcı turu olmaz, ama farklı tenantlar birbirini
// BLOKLAMAZ.

const orchestrator = await import('./sync/marketplaceSyncOrchestrator.ts')
const nl = (v) => v.split('\r\n').join('\n')

/** Dışarıdan çözülebilen iş — turu test kontrol eder. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test.beforeEach(() => orchestrator.resetSyncOrchestrator())

/* ═══ TEK UÇUŞ + BİRLEŞTİRME ═══════════════════════════════════════════ */

test('ORC-1: istek saglayici turunu BEKLEMEZ', async () => {
  const gate = deferred()
  let started = 0
  const before = Date.now()
  const result = orchestrator.requestMarketplaceSync({
    organizationId: 'org-a',
    marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH',
    run: async () => {
      started += 1
      await gate.promise
    },
  })
  const acceptMs = Date.now() - before

  assert.equal(result.accepted, true)
  assert.equal(result.state, 'RUNNING')
  assert.match(result.syncRunId, /^sync_/)
  // Kabul, turun süresinden BAĞIMSIZ.
  assert.ok(acceptMs < 50, `kabul ${acceptMs}ms surdu`)
  await flush()
  assert.equal(started, 1, 'tur arka planda BASLAMALI')
  assert.equal(
    orchestrator.getSyncStatus('org-a', 'acc-a').active.state, 'RUNNING',
  )
  gate.resolve()
  await flush()
})

test('ORC-2: TEK UCUS — ayni tenant icin ikinci saglayici turu YOK', async () => {
  const gate = deferred()
  let providerRuns = 0
  const work = async () => {
    providerRuns += 1
    await gate.promise
  }
  const first = orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH', run: work,
  })
  await flush()
  const second = orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH', run: work,
  })

  assert.equal(second.state, 'COALESCED')
  assert.equal(second.syncRunId, first.syncRunId, 'mevcut tura baglanmali')
  assert.equal(providerRuns, 1, 'IKINCI saglayici turu ACILMAMALI')
  gate.resolve()
  await flush()
  await flush()
})

test('ORC-3: GERI BASINC — 20 tiklama 20 tur URETMEZ', async () => {
  const gate = deferred()
  let providerRuns = 0
  const work = async () => {
    providerRuns += 1
    await gate.promise
  }
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH', run: work,
  })
  await flush()
  for (let i = 0; i < 19; i += 1) {
    const result = orchestrator.requestMarketplaceSync({
      organizationId: 'org-a', marketplaceAccountId: 'acc-a',
      reason: 'MANUAL_REFRESH', run: work,
    })
    assert.equal(result.state, 'COALESCED')
  }
  assert.equal(providerRuns, 1, 'kosarken tek tur')
  const status = orchestrator.getSyncStatus('org-a', 'acc-a')
  assert.equal(status.pendingFollowUp, true, 'TEK bekleyen niyet')
  assert.equal(status.active.coalescedRequests, 19)

  gate.resolve()
  await flush()
  await flush()
  // Bitiminde YALNIZ BİR takip turu — sınırsız kuyruk YOK.
  assert.equal(providerRuns, 2, `takip turu 1 olmali (${providerRuns})`)
})

test('ORC-4: bekleyen niyet YOKSA takip turu ACILMAZ', async () => {
  let providerRuns = 0
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'SCHEDULED',
    run: async () => {
      providerRuns += 1
    },
  })
  await flush()
  await flush()
  assert.equal(providerRuns, 1)
  const status = orchestrator.getSyncStatus('org-a', 'acc-a')
  assert.equal(status.active, null)
  assert.equal(status.last.state, 'SUCCEEDED')
  assert.equal(status.pendingFollowUp, false)
})

/* ═══ TENANT AYRIMI ════════════════════════════════════════════════════ */

test('ORC-5: farkli tenantlar birbirini BLOKLAMAZ (global kilit YOK)', async () => {
  const gateA = deferred()
  let runsA = 0
  let runsB = 0
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH',
    run: async () => {
      runsA += 1
      await gateA.promise
    },
  })
  await flush()
  const b = orchestrator.requestMarketplaceSync({
    organizationId: 'org-b', marketplaceAccountId: 'acc-b',
    reason: 'MANUAL_REFRESH',
    run: async () => {
      runsB += 1
    },
  })
  await flush()

  assert.equal(b.state, 'RUNNING', 'B kendi turunu BASLATABILMELI')
  assert.equal(runsA, 1)
  assert.equal(runsB, 1)
  assert.notEqual(orchestrator.getSyncStatus('org-b', 'acc-b').last, null)
  assert.equal(
    orchestrator.getSyncStatus('org-a', 'acc-a').active.state, 'RUNNING',
    'A hala kosuyor olmali',
  )
  gateA.resolve()
  await flush()
})

test('ORC-6: AYNI org, FARKLI hesap ayri uctur', async () => {
  const gate = deferred()
  let runs = 0
  const work = async () => {
    runs += 1
    await gate.promise
  }
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-1',
    reason: 'MANUAL_REFRESH', run: work,
  })
  await flush()
  const other = orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-2',
    reason: 'MANUAL_REFRESH', run: work,
  })
  await flush()
  assert.equal(other.state, 'RUNNING')
  assert.equal(runs, 2, 'hesap bazinda ayri ucus')
  gate.resolve()
  await flush()
})

test('ORC-7: hesap kapsami ZORUNLU degil ama AYRI anahtar', () => {
  assert.equal(orchestrator.syncKey('org-a', null), 'org-a::null')
  assert.equal(orchestrator.syncKey('org-a', 'acc-1'), 'org-a::acc-1')
  assert.notEqual(
    orchestrator.syncKey('org-a', null),
    orchestrator.syncKey('org-a', 'acc-1'),
  )
  assert.throws(
    () =>
      orchestrator.requestMarketplaceSync({
        organizationId: '', marketplaceAccountId: null,
        reason: 'MANUAL_REFRESH', run: async () => {},
      }),
    /SYNC_ORGANIZATION_REQUIRED/,
  )
})

/* ═══ HATA SEMANTİĞİ ═══════════════════════════════════════════════════ */

test('ORC-8: tur COKSE bile istek DUSMEZ ve durum kaydedilir', async () => {
  const result = orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH',
    run: async () => {
      throw Object.assign(new Error('gecici'), { statusCode: 503 })
    },
  })
  assert.equal(result.accepted, true, 'kabul ETKILENMEZ')
  await flush()
  await flush()
  const status = orchestrator.getSyncStatus('org-a', 'acc-a')
  assert.equal(status.last.state, 'FAILED')
  assert.equal(status.last.errorCategory, 'TRANSIENT')
  assert.equal(status.active, null, 'anahtar SERBEST kalmali')
})

test('ORC-9: BASARISIZ tur lastSuccessfulAt i EZMEZ', async () => {
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'SCHEDULED', run: async () => {},
  })
  await flush()
  await flush()
  const success = orchestrator.getSyncStatus('org-a', 'acc-a').lastSuccessfulAt
  assert.ok(success, 'basarili damga olmali')

  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH',
    run: async () => {
      throw new Error('patladi')
    },
  })
  await flush()
  await flush()
  const status = orchestrator.getSyncStatus('org-a', 'acc-a')
  assert.equal(status.last.state, 'FAILED')
  assert.equal(status.lastSuccessfulAt, success, 'onceki basari KORUNMALI')
})

test('ORC-10: hata siniflandirmasi — YETKI hatasinda tekrar firtinasi YOK', () => {
  const c = orchestrator.classifySyncFailure
  assert.equal(c({ statusCode: 401 }), 'AUTH')
  assert.equal(c({ statusCode: 403 }), 'AUTH')
  assert.equal(c({ statusCode: 429 }), 'TRANSIENT')
  assert.equal(c({ statusCode: 500 }), 'TRANSIENT')
  assert.equal(c({ statusCode: 503 }), 'TRANSIENT')
  assert.equal(c({ statusCode: 422 }), 'CONTRACT')
  assert.equal(c(new Error('socket timeout')), 'TRANSIENT')
  assert.equal(c(new Error('database constraint ihlali')), 'PERSISTENCE')

  assert.equal(orchestrator.isRetryableCategory('TRANSIENT'), true)
  assert.equal(orchestrator.isRetryableCategory('PERSISTENCE'), true)
  assert.equal(orchestrator.isRetryableCategory('AUTH'), false, 'YETKI tekrar YOK')
  assert.equal(orchestrator.isRetryableCategory('CONTRACT'), false)
})

/* ═══ BAYAT TUR KURTARMA ═══════════════════════════════════════════════ */

test('ORC-11: askida kalan tur anahtari SONSUZA KADAR kilitlemez', async () => {
  const gate = deferred()
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH',
    run: async () => {
      await gate.promise
    },
  })
  await flush()
  assert.notEqual(orchestrator.getSyncStatus('org-a', 'acc-a').active, null)

  // "Süreç yeniden başladı / tur askıda kaldı".
  const future = new Date(Date.now() + 60 * 60 * 1000)
  const recovery = orchestrator.recoverStaleRuns(5 * 60 * 1000, future)
  assert.equal(recovery.recovered, 1)

  const status = orchestrator.getSyncStatus('org-a', 'acc-a')
  assert.equal(status.active, null, 'anahtar SERBEST')
  assert.equal(status.last.state, 'FAILED')
  // Kurtarma sonrası yeni tur açılabilmeli.
  let restarted = 0
  const next = orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'STARTUP_RECOVERY',
    run: async () => {
      restarted += 1
    },
  })
  assert.equal(next.state, 'RUNNING')
  await flush()
  assert.equal(restarted, 1)
  gate.resolve()
  await flush()
})

test('ORC-12: TAZE tur kurtarma ile DUSURULMEZ', async () => {
  const gate = deferred()
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH',
    run: async () => {
      await gate.promise
    },
  })
  await flush()
  assert.equal(orchestrator.recoverStaleRuns(5 * 60 * 1000).recovered, 0)
  assert.notEqual(orchestrator.getSyncStatus('org-a', 'acc-a').active, null)
  gate.resolve()
  await flush()
})

/* ═══ YAPISAL SINIRLAR ═════════════════════════════════════════════════ */

test('ORC-13: orkestratör SAGLAYICIYI TANIMAZ (ikinci istemci YOK)', () => {
  const raw = nl(
    readFileSync('server/sync/marketplaceSyncOrchestrator.ts', 'utf8'),
  )
  const code = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ')
  for (const forbidden of [
    'trendyol', 'Trendyol', 'fetch(', 'axios', 'https://',
    'suratWebApiClient', 'callTrendyol',
  ]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  // Sır/kimlik bilgisi saklamaz.
  for (const forbidden of ['credential', 'password', 'apiKey', 'sifre']) {
    assert.equal(code.toLowerCase().includes(forbidden.toLowerCase()), false)
  }
})

test('ORC-14: kayit alanlari yalniz KIMLIK/DURUM/ZAMAN/OZET', async () => {
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH', run: async () => {},
  })
  await flush()
  await flush()
  const status = orchestrator.getSyncStatus('org-a', 'acc-a')
  assert.deepEqual(Object.keys(status.last).sort(), [
    'coalescedRequests', 'errorCategory', 'finishedAt', 'marketplaceAccountId',
    'organizationId', 'reason', 'startedAt', 'state', 'summary', 'syncRunId',
  ])
})

test('ORC-15: tur ozeti BEYAZ LISTE — ham yanit SIZMAZ', async () => {
  // Kısmi senkron uyarısı kullanıcıya ulaşmalı; ama YALNIZ izin verilen alanlar.
  orchestrator.requestMarketplaceSync({
    organizationId: 'org-a', marketplaceAccountId: 'acc-a',
    reason: 'MANUAL_REFRESH',
    run: async () => ({
      ok: true,
      partial: true,
      syncStatus: 'PARTIAL',
      successfulStatuses: ['Created', 'Picking'],
      failedStatuses: [{ status: 'Shipped', httpStatus: 429, retryable: true }],
      persistedCount: 12,
      failedCount: 1,
      // AŞAĞIDAKİLER ASLA DIŞARI ÇIKMAMALI:
      credentials: { apiKey: 'SIR', sifre: 'SIR' },
      rawResponse: { customerName: 'Ömer Şahin', phone: '05550001111' },
      debug: { url: 'https://api.trendyol.com/...' },
    }),
  })
  await flush()
  await flush()
  const summary = orchestrator.getSyncStatus('org-a', 'acc-a').last.summary
  assert.deepEqual(Object.keys(summary).sort(), [
    'failedCount', 'failedStatuses', 'partial', 'persistedCount',
    'successfulStatuses', 'syncStatus',
  ])
  assert.equal(summary.partial, true)
  assert.deepEqual(summary.successfulStatuses, ['Created', 'Picking'])
  assert.deepEqual(summary.failedStatuses, ['Shipped'], 'yalniz statu adi')
  const text = JSON.stringify(summary)
  for (const secret of ['SIR', 'Ömer', '05550001111', 'trendyol.com', 'apiKey']) {
    assert.equal(text.includes(secret), false, `sizinti: ${secret}`)
  }
})
