import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// FAZ C — GERÇEK ÇALIŞMA ZAMANI BAĞLANTISI.
//
// Bu paket, Trace V2'nin YALNIZ var olduğunu değil, GERÇEK create yolunda
// KULLANILDIĞINI kanıtlar. Önceki Faz C geçişi tam da bu ayrımı test
// etmediği için yanlış pozitifti: modül test ediliyordu, kullanımı değil.

const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')
const TRACE = await import('./shipments/suratCreateTrace.ts')

function fetchSpy(body = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => body,
      text: async () => JSON.stringify(body) }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const CONFIG = {
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: 'PRIMARY_1111', liveSifre: 'PRIMARY_SECRET',
  sellerPaysKullaniciAdi: 'SELLER_2222', sellerPaysSifre: 'SELLER_SECRET',
  codKullaniciAdi: 'COD_3333', codSifre: 'COD_SECRET',
}
const ORDER = {
  marketplace: 'Trendyol', orderNumber: '1141234567', packageId: 'PKG-1',
  cargoTrackingNumber: '7270035942963454', customerName: 'Ad Soyad',
  address: 'Adres 1', city: 'İstanbul', district: 'Kadıköy',
  customerPhone: '5551112233', desi: 2,
  items: [{ productName: 'Ürün', quantity: 1 }], rawOrder: {},
}

async function create(over = {}) {
  const spy = fetchSpy(over.carrierBody)
  try {
    const result = await ADAPTER.createCanonicalSuratShipmentForRequest({
      organizationId: over.org ?? 'org-A',
      config: { ...CONFIG, ...(over.config ?? {}) },
      order: { ...ORDER, ...(over.order ?? {}) },
      reference: over.reference ?? 'PKG-1',
      cashOnDelivery: over.cashOnDelivery === true,
    })
    return { result, networkCalls: spy.calls.length }
  } finally { spy.restore() }
}

const stagesOf = (attempt) => attempt.stages.map((entry) => entry.stage)

/* ═══ A) BLOKLANAN DENEME ═════════════════════════════════════════════ */

test('RUN-A: preflight bloklanirsa iz PRE_FLIGHT→FINAL, CARRIER_CALL YOK', async () => {
  const { result, networkCalls } = await create({
    config: { liveKullaniciAdi: '', liveSifre: '' },
  })
  assert.equal(networkCalls, 0, 'TASIYICIYA GIDILMEMELI')
  const attempt = result.traceAttempt
  assert.ok(attempt, 'GERCEK create izi URETMELI')
  const stages = stagesOf(attempt)
  assert.deepEqual(stages, ['PRE_FLIGHT', 'ROUTING', 'FINAL'])
  assert.equal(stages.includes('CARRIER_CALL'), false, 'cagri YAPILMADI')
  assert.equal(attempt.stages.at(-1).data.carrierCalled, false)
})

/* ═══ B) SAĞLIKLI CREATE ══════════════════════════════════════════════ */

test('RUN-B: saglikli create TUM dongusu TEK traceId ile kaydeder', async () => {
  const { result, networkCalls } = await create()
  assert.equal(networkCalls, 1, 'mock tasiyici TAM 1 kez cagrilmali')
  const attempt = result.traceAttempt
  assert.ok(attempt, 'GERCEK create izi URETMELI')
  assert.deepEqual(stagesOf(attempt), [...TRACE.TRACE_LIFECYCLE_STAGES])
  assert.equal(TRACE.isTraceLifecycleComplete(attempt), true)
  // Iz kimligi ile karar izi kimligi AYNI olmali — iki ayri sistem YOK.
  assert.equal(attempt.traceId, result.suratCreateTrace.traceId)
  assert.ok(attempt.traceId.startsWith('CF-'))
  assert.equal(attempt.schemaVersion, 2)
})

test('RUN-C: tasiyici yanit ve dogrulama GERCEKTEN kaydedilir', async () => {
  const { result } = await create()
  const attempt = result.traceAttempt
  const byStage = Object.fromEntries(
    attempt.stages.map((entry) => [entry.stage, entry.data]),
  )
  assert.ok('carrierCreateStatus' in byStage.CARRIER_RESPONSE)
  assert.ok('trackingPresent' in byStage.VERIFICATION)
  assert.ok('barcodePresent' in byStage.VERIFICATION)
  assert.ok('printArtifactStatus' in byStage.VERIFICATION)
  // Beklenen ve tel AYRI bolumlerde.
  assert.equal(byStage.PRE_FLIGHT.expectedSuratWhoPays, '3')
  assert.equal(byStage.REQUEST_READY.wireWhoPaysPresent, false)
  assert.equal(
    byStage.REQUEST_READY.wireWhoPaysReason, 'CONTRACT_HAS_NO_WHO_PAYS_FIELD',
  )
})

/* ═══ D) İKİ DENEME KARIŞMAZ ══════════════════════════════════════════ */

test('RUN-D: Trace A ile Trace B GERCEK create yolunda karismaz', async () => {
  const a = await create({ org: 'org-A', reference: 'PKG-A',
    order: { packageId: 'PKG-A' } })
  const b = await create({ org: 'org-B', reference: 'PKG-B',
    order: { packageId: 'PKG-B' } })
  const idA = a.result.traceAttempt.traceId
  const idB = b.result.traceAttempt.traceId
  assert.notEqual(idA, idB, 'ayri denemeler ayri kimlik ALMALI')
  // Her denemenin TUM asamalari KENDI kimligi altinda.
  assert.equal(a.result.suratCreateTrace.traceId, idA)
  assert.equal(b.result.suratCreateTrace.traceId, idB)
  assert.equal(JSON.stringify(a.result.traceAttempt).includes(idB), false)
  assert.equal(JSON.stringify(b.result.traceAttempt).includes(idA), false)
})

/* ═══ E) DEĞİŞMEZLİK + MASKELEME (GERÇEK YOLDA) ═══════════════════════ */

test('RUN-E: gercek iz DONDURULMUS ve SIR TASIMAZ', async () => {
  const { result } = await create()
  const attempt = result.traceAttempt
  assert.equal(Object.isFrozen(attempt), true)
  assert.throws(() => { attempt.stages.push({}) }, TypeError)
  const text = JSON.stringify(attempt)
  for (const secret of ['PRIMARY_SECRET', 'SELLER_SECRET', 'COD_SECRET']) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
  // Teshis icin gereken yonlendirme karari KORUNUR.
  const routing = attempt.stages.find((entry) => entry.stage === 'ROUTING')
  assert.equal(routing.data.credentialRole, 'PRIMARY_MARKETPLACE')
})

/* ═══ BAĞLANTI DEĞİŞMEZİ — YANLIŞ POZİTİFİ ÖNLER ═════════════════════ */

test('RUN-F: gercek create adaptoru Trace V2 kaydedicisini CAGIRIR', () => {
  const source = readFileSync(
    'server/shipments/suratCanonicalCreateAdapter.ts', 'utf8',
  )
  const code = source.split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  // Modulun VAR olmasi yetmez; create yolu onu KULLANMALI.
  assert.ok(code.includes('createTraceAttempt('), 'deneme ACILMALI')
  assert.ok(code.includes('appendTraceStage('), 'asamalar KAYDEDILMELI')
  for (const stage of ['PRE_FLIGHT', 'ROUTING', 'REQUEST_READY',
    'CARRIER_CALL', 'CARRIER_RESPONSE', 'VERIFICATION', 'FINAL']) {
    assert.ok(code.includes(`'${stage}'`), `${stage} kaydedilmiyor`)
  }
})
