import assert from 'node:assert/strict'
import test from 'node:test'

// SURAT CANONICAL GONDERI ORKESTRASYONU — SOZLESME TESTLERI (AG YOK).
//
// EN KRITIK DEGISMEZ: tasiyici gonderisi olustuysa, etiket artifact'i
// cozulemese bile IKINCI create cagrisi YAPILMAZ.

const S = await import('./shipments/suratCanonicalShipmentService.ts')
const M = await import('./shipments/suratCanonicalGonderiModel.ts')

const tenantA = { kullaniciAdi: 'TENANT_A_CARI', sifre: 'TENANT_A_SECRET', isActive: true }
const tenantB = { kullaniciAdi: 'TENANT_B_CARI', sifre: 'TENANT_B_SECRET', isActive: true }

const trendyolOrder = {
  marketplace: 'Trendyol',
  customerName: 'Test Alici',
  address: 'Ornek Mah. 1',
  city: 'Istanbul',
  district: 'Kadikoy',
  customerPhone: '5551112233',
  cargoTrackingNumber: '727TEST123',
  orderNumber: '1141234567',
  packageId: 'PKG-1',
}

/** Sahte tasima — her cagriyi kaydeder. */
function makeFetch(responder) {
  const calls = []
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init })
      return responder(calls.length)
    },
  }
}

const okResponse = (extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    isError: false, Message: 'OK', KargoTakipNo: '41176176501029',
    Barcode: ['opaque-vendor-value'], BarcodeNo: ['1234567890'], ...extra,
  }),
  text: async () => '',
})

/** Bellek-ici idempotency limani (3A-2'de gercek kilide baglanacak). */
function makeIdempotency() {
  const held = new Set()
  const done = new Map()
  const events = []
  return {
    events,
    port: {
      acquire(key) {
        events.push(['acquire', key])
        if (held.has(key) || done.has(key)) return false
        held.add(key)
        return true
      },
      complete(key, result) {
        events.push(['complete', key, result.carrierCreateStatus])
        held.delete(key)
        done.set(key, result)
      },
      markUnknown(key, reason) {
        events.push(['markUnknown', key, reason])
        held.delete(key)
        done.set(key, { unknown: reason })
      },
    },
  }
}

function makePersistence() {
  const saved = []
  return { saved, port: { persist: (input) => { saved.push(input) } } }
}

function paramsFor(order, account, fetchImpl, extra = {}) {
  const context = M.resolveSuratMarketplaceContext(order)
  return {
    organizationId: extra.organizationId ?? 'org-A',
    packageId: String(order.packageId ?? 'PKG-1'),
    account,
    context,
    shipment: {
      order, context, referansNo: 'REF-1', adet: 1,
      birimDesi: '2', birimKg: '1.5', kargoIcerigi: 'Icerik',
    },
    fetchImpl,
    ...extra,
  }
}

// ═══ 1. HAPPY PATH ════════════════════════════════════════════════════════

test('SVC-1: Trendyol happy path → SUCCESS, TEK cagri', async () => {
  const f = makeFetch(() => okResponse())
  const idem = makeIdempotency()
  const store = makePersistence()
  const result = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl),
    idempotency: idem.port, persistence: store.port,
  })
  assert.equal(result.carrierCreateStatus, 'SUCCESS')
  assert.equal(result.outcome, 'delivered')
  assert.equal(result.trackingNo, '41176176501029')
  assert.equal(result.carrierCreateAttempts, 1)
  assert.equal(f.calls.length, 1)
  assert.equal(
    f.calls[0].url,
    'https://api02.suratkargo.com.tr/api/OrtakBarkodOlustur',
  )
  assert.equal(store.saved.length, 1)
  const body = JSON.parse(f.calls[0].init.body)
  assert.strictEqual(body.Gonderi.Pazaryerimi, 1)
  assert.equal(body.Gonderi.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(body.Gonderi.OzelKargoTakipNo, '727TEST123')
})

// ═══ 2-3. FAIL-CLOSED: AG ISTEGI YOK ══════════════════════════════════════

test('SVC-2: tenant hesabi YOKSA network 0', async () => {
  const f = makeFetch(() => okResponse())
  const idem = makeIdempotency()
  const result = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, null, f.impl), idempotency: idem.port,
  })
  assert.equal(result.carrierCreateStatus, 'BLOCKED')
  assert.equal(result.errorCode, 'SURAT_ACCOUNT_NOT_CONFIGURED')
  assert.equal(result.carrierCreateAttempts, 0)
  assert.equal(f.calls.length, 0)
})

test('SVC-3: pazaryeri kargo no YOKSA network 0 (fallback YOK)', async () => {
  const f = makeFetch(() => okResponse())
  const idem = makeIdempotency()
  const order = { ...trendyolOrder, cargoTrackingNumber: '' }
  const result = await S.createCanonicalSuratShipment({
    ...paramsFor(order, tenantA, f.impl), idempotency: idem.port,
  })
  assert.equal(result.carrierCreateStatus, 'BLOCKED')
  assert.equal(result.errorCode, 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING')
  assert.equal(f.calls.length, 0)
})

// ═══ 4. VENDOR REJECTED ═══════════════════════════════════════════════════

test('SVC-4: isError=true → REJECTED, legacy 0', async () => {
  const f = makeFetch(() => ({
    ok: true, status: 200,
    json: async () => ({ isError: true, Message: 'Vendor hata' }),
    text: async () => '',
  }))
  const idem = makeIdempotency()
  const result = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
  })
  assert.equal(result.carrierCreateStatus, 'REJECTED')
  assert.equal(result.outcome, 'rejected')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls.filter((c) => /api01|asmx|prova/.test(c.url)).length, 0)
})

// ═══ 5-6. TIMEOUT → UNKNOWN ═══════════════════════════════════════════════

const abortingFetch = () => makeFetch(() => {
  const error = new Error('aborted')
  error.name = 'AbortError'
  throw error
})

test('SVC-5: timeout → UNKNOWN (FAILED sayilmaz)', async () => {
  const f = abortingFetch()
  const result = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl),
    idempotency: makeIdempotency().port,
  })
  assert.equal(result.carrierCreateStatus, 'UNKNOWN')
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.errorCode, 'SURAT_CANONICAL_TIMEOUT')
  assert.equal(result.carrierCreateAttempts, 1)
})

test('SVC-6: UNKNOWN sonrasi otomatik retry YOK, kor tekrar ACILMAZ', async () => {
  const f = abortingFetch()
  const idem = makeIdempotency()
  await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
  })
  assert.equal(f.calls.length, 1, 'otomatik retry YOK')
  assert.ok(idem.events.some(([kind]) => kind === 'markUnknown'))
  assert.equal(idem.events.some(([kind]) => kind === 'complete'), false)
})

// ═══ 7. BASARILI AMA ARTIFACT COZULEMEDI ══════════════════════════════════

test('SVC-7: SUCCESS + artifact UNRESOLVED → IKINCI create YOK', async () => {
  const f = makeFetch(() => okResponse())
  const idem = makeIdempotency()
  const result = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
  })
  // Gonderi olustu; etiket formati DOGRULANMADIGI icin cozulmedi.
  assert.equal(result.carrierCreateStatus, 'SUCCESS')
  assert.equal(result.printArtifactStatus, 'UNRESOLVED')
  // Ham veri AYNEN tasinir; format TAHMIN EDILMEZ.
  assert.deepEqual(result.barcode, ['opaque-vendor-value'])
  assert.deepEqual(result.barcodeNo, ['1234567890'])
  assert.equal(f.calls.length, 1, 'IKINCI create YAPILMAMALI')
})

// ═══ 8-9. IDEMPOTENCY + IZOLASYON ═════════════════════════════════════════

test('SVC-8: ayni tenant/paket icin eszamanli 2 istek → create 1', async () => {
  const f = makeFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return okResponse()
  })
  const idem = makeIdempotency()
  const [first, second] = await Promise.all([
    S.createCanonicalSuratShipment({
      ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
    }),
    S.createCanonicalSuratShipment({
      ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
    }),
  ])
  assert.equal(f.calls.length, 1, 'tasiyici create sayisi 1 olmali')
  const statuses = [first.carrierCreateStatus, second.carrierCreateStatus].sort()
  assert.deepEqual(statuses, ['BLOCKED', 'SUCCESS'])
})

test('SVC-18: tamamlanmis paket icin YENIDEN create YAPILMAZ', async () => {
  const f = makeFetch(() => okResponse())
  const idem = makeIdempotency()
  const first = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
  })
  const replay = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
  })
  assert.equal(first.carrierCreateStatus, 'SUCCESS')
  assert.equal(replay.carrierCreateStatus, 'BLOCKED')
  assert.equal(replay.carrierCreateAttempts, 0)
  assert.equal(f.calls.length, 1, 'tekrar create YAPILMAMALI')
})

test('SVC-9: farkli tenant AYNI paket → kimlikler AYRI', async () => {
  const f = makeFetch(() => okResponse())
  const idem = makeIdempotency()
  await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl, { organizationId: 'org-A' }),
    idempotency: idem.port,
  })
  await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantB, f.impl, { organizationId: 'org-B' }),
    idempotency: idem.port,
  })
  assert.equal(f.calls.length, 2, 'ayri tenant ayri gonderi')
  const bodies = f.calls.map((c) => JSON.parse(c.init.body))
  assert.equal(bodies[0].KullaniciAdi, 'TENANT_A_CARI')
  assert.equal(bodies[1].KullaniciAdi, 'TENANT_B_CARI')
  // Capraz sizinti YOK.
  assert.equal(f.calls[0].init.body.includes('TENANT_B'), false)
  assert.equal(f.calls[1].init.body.includes('TENANT_A'), false)
  // Idempotency anahtari tenant iceriyor.
  const keyA = S.buildCanonicalIdempotencyKey({
    organizationId: 'org-A', marketplace: 'TRENDYOL', packageId: 'PKG-1',
  })
  const keyB = S.buildCanonicalIdempotencyKey({
    organizationId: 'org-B', marketplace: 'TRENDYOL', packageId: 'PKG-1',
  })
  assert.notEqual(keyA, keyB)
})

// ═══ 10-14. KAYNAK VE HEDEF SOZLESMESI ════════════════════════════════════

test('SVC-10: govde UNITE 1 builder ciktisiyla AYNI', async () => {
  const f = makeFetch(() => okResponse())
  const idem = makeIdempotency()
  const params = paramsFor(trendyolOrder, tenantA, f.impl)
  await S.createCanonicalSuratShipment({ ...params, idempotency: idem.port })
  const expected = M.buildSuratCanonicalGonderiModel(params.shipment)
  const body = JSON.parse(f.calls[0].init.body)
  assert.deepEqual(body.Gonderi, JSON.parse(JSON.stringify(expected)))
  for (const field of M.FORBIDDEN_CANONICAL_FIELDS) {
    assert.equal(field in body.Gonderi, false, field)
  }
})

/** Basarili tek cagri yapip cagri kaydini dondurur. */
async function runOnce() {
  const f = makeFetch(() => okResponse())
  await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl),
    idempotency: makeIdempotency().port,
  })
  return f.calls
}

test('SVC-11: TEK ag adaptoru kullanilir', async () => {
  const calls = await runOnce()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.startsWith('https://api02.suratkargo.com.tr/'))
})

test('SVC-12: api01 / legacy host hedefi YOK', async () => {
  const calls = await runOnce()
  for (const forbidden of ['api01', 'sandbox', 'prova']) {
    assert.equal(calls[0].url.includes(forbidden), false, forbidden)
  }
})

test('SVC-13: SOAP/ASMX cagrisi YOK', async () => {
  const calls = await runOnce()
  for (const forbidden of ['asmx', 'tempuri', 'services.asmx']) {
    assert.equal(calls[0].url.includes(forbidden), false, forbidden)
  }
  assert.equal('SOAPAction' in calls[0].init.headers, false)
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
})

test('SVC-14: ikinci adim (GonderiyiKargoyaGonder) CAGRILMAZ', async () => {
  const calls = await runOnce()
  assert.equal(calls.length, 1)
  assert.equal(
    calls.filter((c) => c.url.includes('GonderiyiKargoyaGonder')).length, 0,
  )
})

// ═══ 15. LOG GUVENLIGI ════════════════════════════════════════════════════

test('SVC-15: log baglami SIR ICERMEZ', async () => {
  const f = makeFetch(() => okResponse())
  const idem = makeIdempotency()
  const result = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
  })
  const context = S.buildCanonicalShipmentLogContext({
    organizationId: 'org-A', marketplace: 'TRENDYOL', result,
  })
  assert.equal(context.adapter, 'SURAT_WEB_API')
  assert.equal(context.carrierCreateStatus, 'SUCCESS')
  assert.equal(context.barcodeCount, 1)
  assert.equal(context.barcodeNoCount, 1)
  const json = JSON.stringify(context)
  for (const secret of [
    'TENANT_A_SECRET', 'TENANT_A_CARI', '727TEST123', 'opaque-vendor-value',
  ]) {
    assert.equal(json.includes(secret), false, secret)
  }
})

// ═══ 16-17. VERI VE DURUM AYRIMI ══════════════════════════════════════════

test('SVC-16: barcode/barcodeNo DEGISTIRILMEDEN tasinir', async () => {
  const f = makeFetch(() => okResponse({
    Barcode: ['A', 'B'], BarcodeNo: ['N1', 'N2'],
  }))
  const idem = makeIdempotency()
  const result = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f.impl), idempotency: idem.port,
  })
  assert.deepEqual(result.barcode, ['A', 'B'])
  assert.deepEqual(result.barcodeNo, ['N1', 'N2'])
})

test('SVC-17: create sonucu ile etiket durumu BAGIMSIZ temsil edilir', async () => {
  // Basarili create + cozulemeyen etiket.
  const f1 = makeFetch(() => okResponse())
  const r1 = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f1.impl),
    idempotency: makeIdempotency().port,
  })
  assert.equal(r1.carrierCreateStatus, 'SUCCESS')
  assert.equal(r1.printArtifactStatus, 'UNRESOLVED')
  // Reddedilen create → etiket durumu UYGULANAMAZ.
  const f2 = makeFetch(() => ({
    ok: true, status: 200,
    json: async () => ({ isError: true, Message: 'red' }), text: async () => '',
  }))
  const r2 = await S.createCanonicalSuratShipment({
    ...paramsFor(trendyolOrder, tenantA, f2.impl),
    idempotency: makeIdempotency().port,
  })
  assert.equal(r2.carrierCreateStatus, 'REJECTED')
  assert.equal(r2.printArtifactStatus, 'NOT_APPLICABLE')
})

// ═══ URETIM MODULU IZOLASYONU ═════════════════════════════════════════════

test('SVC-ISOLATION: orkestrasyon ENV okumaz, index.mjs bilmez', async () => {
  const keys = ['SURAT_LIVE_KULLANICI_ADI', 'SURAT_TEST_KULLANICI_ADI', 'SURAT_LIVE_SIFRE']
  const previous = {}
  for (const key of keys) { previous[key] = process.env[key]; process.env[key] = `ENV_${key}` }
  try {
    const f = makeFetch(() => okResponse())
    await S.createCanonicalSuratShipment({
      ...paramsFor(trendyolOrder, tenantA, f.impl),
      idempotency: makeIdempotency().port,
    })
    assert.equal(f.calls[0].init.body.includes('ENV_'), false, 'env SIZMAMALI')
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})
