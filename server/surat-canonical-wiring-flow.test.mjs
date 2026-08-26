import assert from 'node:assert/strict'
import test from 'node:test'

// UNITE 3A-2 — GERCEK PRODUCTION CREATE ZINCIRINE WIRING SOZLESMESI.
//
// Gercek api02 cagrisi YOK: globalThis.fetch stub'lanir ve HER cagri sayilir.

const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')
const SNAPSHOT = await import('./shipments/suratCredentialSnapshot.ts')
const ROUTING = await import('./shipments/suratRoutingModel.ts')
const MODE = await import('./shipments/suratCanonicalServiceMode.mjs')

const INDEX_SOURCE = await (async () => {
  const { readFile } = await import('node:fs/promises')
  return readFile(new URL('./index.mjs', import.meta.url), 'utf8')
})()

/** globalThis.fetch'i sayan stub ile degistirir. */
function installFetchSpy(responder) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return responder(calls.length)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const okBody = (extra = {}) => ({
  isError: false, Message: 'OK', KargoTakipNo: '41176176501029',
  Barcode: ['opaque'], BarcodeNo: ['1234567890'], ...extra,
})

const jsonResponse = (body) => ({
  ok: true, status: 200, json: async () => body, text: async () => '',
})

// 3B sozlesmesi: NORMAL gonderi BIRINCIL canli tenant hesabini kullanir.
const tenantAConfig = {
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: 'TENANT_A_CARI',
  liveSifre: 'TENANT_A_SECRET',
  codKullaniciAdi: 'TENANT_A_COD',
  codSifre: 'TENANT_A_COD_SECRET',
  // ENV'in EZDIGI taban alanlar: kanonik yol bunlari OKUMAMALI.
  kullaniciAdi: 'ENV_POISONED_ACCOUNT',
  sifre: 'ENV_POISONED_SECRET',
}
const tenantBConfig = {
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: 'TENANT_B_CARI',
  liveSifre: 'TENANT_B_SECRET',
}

const baseOrder = {
  marketplace: 'Trendyol',
  orderNumber: '1141234567',
  packageId: 'PKG-1',
  cargoTrackingNumber: '727TEST123',
  customerName: 'Test Alici',
  address: 'Ornek Mah. 1',
  city: 'Istanbul',
  district: 'Kadikoy',
  customerPhone: '5551112233',
  desi: 2,
  items: [{ productName: 'Urun', quantity: 1 }],
}

async function runCanonical(overrides = {}) {
  // KIMLIK ARTIK OTORITER ANLIK GORUNTUDEN gelir. Bu testler `config` ile
  // KIRACI hesabini temsil ediyordu; artik ayni degerler KIRACI DEPOSU olarak
  // anlik goruntuye verilir. Guard GEVSETILMEDI — kaynak duzeltildi.
  const storeConfig = overrides.config ?? tenantAConfig
  // ROL, reponun KENDI politika cozucusunden gelir; burada kopya mantik YOK.
  const order = { ...baseOrder, ...(overrides.order ?? {}) }
  const role = ROUTING.resolveSuratCredentialContext({
    config: storeConfig,
    billingParty: ROUTING.resolveBillingPartyV2(
      order.rawOrder ?? {},
    ).billingParty,
    cod: ROUTING.resolveCodContext({
      enabled: overrides.cashOnDelivery === true,
      collectionType: storeConfig?.kapidanOdemeTahsilatTipi,
      amount: order.cashOnDeliveryAmount,
    }),
    codPolicy: ROUTING.resolveCodCredentialPolicy(
      storeConfig?.codCredentialPolicy,
    ),
  }).role
  const credentialSnapshot = SNAPSHOT.buildSuratCredentialSnapshot({
    storedSuratConfig: storeConfig,
    role,
  })
  return ADAPTER.createCanonicalSuratShipmentForRequest({
    organizationId: overrides.organizationId ?? 'org-A',
    credentialSnapshot,
    config: storeConfig,
    order: { ...baseOrder, ...(overrides.order ?? {}) },
    reference: 'PKG-1',
    cashOnDelivery: overrides.cashOnDelivery === true,
  })
}

// ═══ 1. CANONICAL SERVICE MODE GERCEK ROUTE ═══════════════════════════════

test('WIRE-1: index.mjs create zinciri canonical serviceMode dalina sahip', () => {
  assert.equal(MODE.SURAT_CANONICAL_SERVICE_MODE, 'SURAT_CANONICAL_API')
  // Dal createSuratShipmentCore icinde ve canonical adaptore gidiyor.
  assert.match(
    INDEX_SOURCE,
    /config\.serviceMode === SURAT_CANONICAL_SERVICE_MODE/,
  )
  assert.match(
    INDEX_SOURCE,
    /createCanonicalSuratShipmentForRequest/,
  )
  // Sabit index.mjs icinde tekrar hardcode EDILMEMIS.
  assert.equal(
    (INDEX_SOURCE.match(/'SURAT_CANONICAL_API'/g) ?? []).length, 0,
  )
})

test('WIRE-2: mevcut idempotency adaptoru kullanilir, ikinci sistem YOK', () => {
  // Kanonik servis kendi kilidini kurmaz; disaridaki rezervasyonu tasir.
  const port = ADAPTER.createHeldIdempotencyPort()
  assert.equal(port.acquire('k'), true)
  // Gercek kilit index.mjs'teki mevcut rezervasyondur.
  assert.match(INDEX_SOURCE, /reserveShipmentCreateOperation/)
  assert.match(INDEX_SOURCE, /suratCreateLocks\.set/)
})

test('WIRE-3: canonical sonuc mevcut kayit siniflandirmasina baglanir', () => {
  // BLOCKED disindaki her canonical sonuc "tasiyiciya gidildi" sayilir;
  // aksi hâlde kayit silinir ve ikinci create riski dogar.
  assert.match(
    INDEX_SOURCE,
    /canonicalCreate\.carrierCreateStatus !== 'BLOCKED'/,
  )
  // UNKNOWN, FAILED'a normalize EDILMEZ.
  assert.match(INDEX_SOURCE, /carrierCreateStatus === 'REJECTED'\s*\n?\s*\?\s*'FAILED_SAFE'/)
})

// ═══ 4-5. MEVCUT KAYIT DURUMLARI ══════════════════════════════════════════

test('WIRE-4: mevcut SUCCESS kaydi → tasiyiciya GIDILMEZ', () => {
  // executeIdempotentSuratCreate SUCCESS kaydinda persisted yanit doner.
  assert.match(
    INDEX_SOURCE,
    /existing\?\.status === 'SUCCESS'[\s\S]{0,120}buildPersistedSuratCreateResponse/,
  )
})

test('WIRE-5: onceki UNKNOWN kaydi → otomatik yeni create YOK', () => {
  assert.match(
    INDEX_SOURCE,
    /\['IN_PROGRESS', 'UNKNOWN'\]\.includes\(existing\.status\)[\s\S]{0,200}buildSuratIdempotencyBlockedResponse/,
  )
})

// ═══ 6. TENANT IZOLASYONU ═════════════════════════════════════════════════

test('WIRE-6: tenant A/B capraz credential kullanmaz', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical({ organizationId: 'org-A', config: tenantAConfig })
    await runCanonical({ organizationId: 'org-B', config: tenantBConfig })
    assert.equal(spy.calls.length, 2)
    const bodies = spy.calls.map((c) => JSON.parse(c.init.body))
    assert.equal(bodies[0].KullaniciAdi, 'TENANT_A_CARI')
    assert.equal(bodies[1].KullaniciAdi, 'TENANT_B_CARI')
    assert.equal(spy.calls[0].init.body.includes('TENANT_B'), false)
    assert.equal(spy.calls[1].init.body.includes('TENANT_A'), false)
  } finally { spy.restore() }
})

test('WIRE-6B: ENV taban credential alanlari KANONIK yolda KULLANILMAZ', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical()
    const body = spy.calls[0].init.body
    assert.equal(body.includes('ENV_POISONED_ACCOUNT'), false)
    assert.equal(body.includes('ENV_POISONED_SECRET'), false)
  } finally { spy.restore() }
  // Tenant sellerPays/cod alanlari yoksa fail-closed.
  assert.equal(
    ADAPTER.resolveCanonicalTenantSuratAccount(
      { kullaniciAdi: 'ENV_ONLY', sifre: 'ENV_ONLY' }, false,
    ),
    null,
  )
})

test('WIRE-6C: kapida odeme siparisi COD hesabini kullanir', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical({ cashOnDelivery: true })
    assert.equal(
      JSON.parse(spy.calls[0].init.body).KullaniciAdi, 'TENANT_A_COD',
    )
  } finally { spy.restore() }
})

// ═══ 7-9. GERCEK MARKETPLACE ALANLARI + FAIL-CLOSED ═══════════════════════

test('WIRE-7: gercek Trendyol cargoTrackingNumber gonderilir', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical()
    const body = JSON.parse(spy.calls[0].init.body)
    assert.equal(body.Gonderi.OzelKargoTakipNo, '727TEST123')
    assert.strictEqual(body.Gonderi.Pazaryerimi, 1)
    assert.equal(body.Gonderi.EntegrasyonFirmasi, 'Trendyol')
  } finally { spy.restore() }
})

test('WIRE-8: kargo takip numarasi yoksa HTTP 0', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical({ order: { cargoTrackingNumber: '' } })
    assert.equal(result.ok, false)
    assert.equal(spy.calls.length, 0)
  } finally { spy.restore() }
})

test('WIRE-9: tenant credential yoksa HTTP 0', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical({
      config: { serviceMode: 'SURAT_CANONICAL_API' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'SURAT_ACCOUNT_NOT_CONFIGURED')
    assert.equal(spy.calls.length, 0)
  } finally { spy.restore() }
})

// ═══ 10-11. FALLBACK YOK ══════════════════════════════════════════════════

test('WIRE-10: vendor rejected → legacy cagri 0', async () => {
  const spy = installFetchSpy(() =>
    jsonResponse({ isError: true, Message: 'Vendor red' }))
  try {
    const result = await runCanonical()
    assert.equal(result.ok, false)
    assert.equal(spy.calls.length, 1)
    assert.equal(result.canonicalCreate.carrierCreateStatus, 'REJECTED')
  } finally { spy.restore() }
})

test('WIRE-11: timeout → legacy cagri 0, UNKNOWN korunur', async () => {
  const spy = installFetchSpy(() => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  })
  try {
    const result = await runCanonical()
    assert.equal(spy.calls.length, 1)
    assert.equal(result.canonicalCreate.carrierCreateStatus, 'UNKNOWN')
    assert.equal(result.canonicalCreate.outcome, 'unknown')
  } finally { spy.restore() }
})

// ═══ 12-14. PERSISTENCE + ARTIFACT ════════════════════════════════════════

test('WIRE-12: success yaniti mevcut persistence alanlarini besler', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical()
    assert.equal(result.ok, true)
    // KargoTakipNo = tasiyici kimligi.
    assert.equal(result.shipment.tNo, '41176176501029')
    assert.equal(result.shipment.trackingNumber, '41176176501029')
    // OzelKargoTakipNo = pazaryeri disi numarasi. AYRI alan.
    assert.equal(result.shipment.ozelKargoTakipNo, '727TEST123')
    assert.notEqual(result.shipment.tNo, result.shipment.ozelKargoTakipNo)
    // Mevcut kayit yazicisi bu bayragi okur.
    assert.equal(result.shipment.dispatchRegistrationConfirmed, true)
    assert.equal(result.suratCreateLog.rawRequest.OzelKargoTakipNo, '727TEST123')
    assert.equal(result.suratCreateLog.responseStatus, 200)
  } finally { spy.restore() }
})

test('WIRE-13: SUCCESS + artifact unresolved AYRI temsil edilir', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical()
    assert.equal(result.ok, true)
    assert.equal(result.canonicalCreate.carrierCreateStatus, 'SUCCESS')
    assert.equal(result.canonicalCreate.printArtifactStatus, 'UNRESOLVED')
    // print-ready ASLA true degil; etiket alanlari doldurulmaz.
    assert.equal(result.shipment.printEnabled, false)
    assert.equal(result.shipment.printReady, false)
    assert.equal(result.shipment.labelStatus, 'UNRESOLVED')
    assert.equal('zpl' in result.shipment, false)
    assert.equal('barkodNo' in result.shipment, false)
    // Ham vendor verisi format SECILMEDEN tasinir.
    assert.deepEqual(result.shipment.canonicalVendorBarcode, ['opaque'])
    assert.deepEqual(result.shipment.canonicalVendorBarcodeNo, ['1234567890'])
  } finally { spy.restore() }
})

test('WIRE-14: artifact unresolved → ikinci create tetiklenmez', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical()
    assert.equal(spy.calls.length, 1)
    assert.equal(result.canonicalCreate.carrierCreateAttempts, 1)
    // Kayit "gonderilmedi" sayilmaz → kilit acilmaz.
    assert.equal(result.suratCreateLog.rawRequest.skipped, false)
  } finally { spy.restore() }
})

// ═══ 15. REPRINT ══════════════════════════════════════════════════════════

test('WIRE-15: reprint yolu canonical create endpointini CAGIRMAZ', () => {
  const reprintSection = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('async function createSuratLabelForRegisteredShipment'),
    INDEX_SOURCE.indexOf('function buildSuratCreateOperationContext'),
  )
  assert.ok(reprintSection.length > 0)
  assert.equal(
    reprintSection.includes('createCanonicalSuratShipmentForRequest'), false,
  )
  assert.equal(reprintSection.includes('SURAT_CANONICAL_SERVICE_MODE'), false)
})

// ═══ 16-18. STRUCTURAL: RUNTIME FALLBACK YOK ══════════════════════════════

test('WIRE-16/17/18: canonical modullerde api01/SOAP/prova runtime dali YOK', async () => {
  const { readFile } = await import('node:fs/promises')
  const files = [
    './shipments/suratCanonicalCreateAdapter.ts',
    './shipments/suratCanonicalShipmentService.ts',
    './shipments/suratWebApiClient.ts',
  ]
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    // Yorum satirlari cikarilarak YALNIZ calisan kod incelenir.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    for (const forbidden of [
      'api01', '.asmx', 'tempuri', 'SOAPAction', 'prova', 'sandbox',
      'PRE_REGISTRATION_REST', 'SURAT_TEST_', 'SURAT_LIVE_',
    ]) {
      assert.equal(code.includes(forbidden), false, `${file}: ${forbidden}`)
    }
  }
})

// ═══ 19-20. BASELINE KORUNUMU ═════════════════════════════════════════════

test('WIRE-19: legacy service mode dallari BASELINE olarak korunur', () => {
  for (const mode of [
    'ORTAK_BARKOD_SOAP',
    'GONDERI_YENI_SOAP',
    'KARGO_BARKODU_SIPARIS_SOAP',
    'PRE_REGISTRATION_REST',
    'GONDERI_OLUSTUR_V2_EXPERIMENTAL',
  ]) {
    assert.ok(
      INDEX_SOURCE.includes(`config.serviceMode === '${mode}'`),
      `${mode} dali korunmali`,
    )
  }
  // Varsayilan mod DEGISMEDI: bulk migration YOK.
  assert.match(INDEX_SOURCE, /:\s*'ORTAK_BARKOD_SOAP'\s*\n\s*const ortam/)
})

test('WIRE-20: create response sozlesmesi geriye donuk uyumlu', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical()
    for (const key of ['ok', 'source', 'serviceType', 'operationName', 'shipment']) {
      assert.ok(key in result, key)
    }
    assert.equal(result.source, 'real')
    assert.equal(result.operationName, 'OrtakBarkodOlustur')
    assert.equal(result.serviceType, 'SuratCanonicalWebApi')
  } finally { spy.restore() }
})

// ═══ HOST + LOG GUVENLIGI ═════════════════════════════════════════════════

test('WIRE-HOST: hedef host kullanici girdisinden ALINMAZ', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical({
      config: { ...tenantAConfig, baseUrl: 'https://evil.example.com' },
    })
    assert.equal(
      spy.calls[0].url,
            // ROTA DEĞİŞTİ: `Pazaryerimi=1` gönderisi pazaryeri ucuna gider.
      // Canlı sözleşmede iki uç AYNI istek/yanıt modelini kullanır;
      // değişen tek şey yoldur (CF-4104179900 sonrası).
      'https://api02.suratkargo.com.tr/api/PazaryeriGonderi',
    )
  } finally { spy.restore() }
})

test('WIRE-LOG: create yaniti credential SIZDIRMAZ', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const json = JSON.stringify(await runCanonical())
    for (const secret of [
      'TENANT_A_CARI', 'TENANT_A_SECRET', 'ENV_POISONED_ACCOUNT',
      'ENV_POISONED_SECRET', 'KullaniciAdi', 'Sifre',
    ]) {
      assert.equal(json.includes(secret), false, secret)
    }
  } finally { spy.restore() }
})
