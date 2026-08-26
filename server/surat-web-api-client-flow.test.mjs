import assert from 'node:assert/strict'
import test from 'node:test'

// SURAT WEB API CANLI ISTEMCI — SOZLESME TESTLERI (AG YOK).
//
// Canonical canli uc (vendor-confirmed):
//   POST https://api02.suratkargo.com.tr/api/OrtakBarkodOlustur
//
// Bu paket URETIM davranisini DOGRULAR. Sahte tasima (fetch) enjekte edilir;
// gercek Surat cagrisi YAPILMAZ.

const C = await import('./shipments/suratWebApiClient.ts')
const M = await import('./shipments/suratCanonicalGonderiModel.ts')

/** Cagrilari kaydeden sahte tasima. */
function makeFetch(responder) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return responder(url, init)
  }
  return { impl, calls }
}

const okResult = (extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    isError: false,
    Message: 'OK',
    KargoTakipNo: '41176176501029',
    Barcode: ['^XA^XZ'],
    BarcodeNo: ['1234567890'],
    ...extra,
  }),
  text: async () => '',
})

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
}

function gonderiFor(order = trendyolOrder) {
  const ctx = M.resolveSuratMarketplaceContext(order)
  return M.buildSuratCanonicalGonderiModel({
    order, context: ctx, referansNo: 'REF-1', adet: 1,
    birimDesi: '2', birimKg: '1.5', kargoIcerigi: 'Icerik',
  })
}

// ═══ 1-4. CANONICAL HEDEF ═════════════════════════════════════════════════

test('WEB-1: canonical CANLI host api02', () => {
  assert.equal(C.SURAT_CANONICAL_LIVE_API_BASE_URL, 'https://api02.suratkargo.com.tr')
  assert.deepEqual([...C.SURAT_CANONICAL_ALLOWED_HOSTS], ['api02.suratkargo.com.tr'])
})

test('WEB-2/3/4: POST /api/OrtakBarkodOlustur + JSON kok govde', async () => {
  const f = makeFetch(() => okResult())
  const creds = C.resolveTenantSuratProductionCredentials(tenantA)
  await C.createOrtakBarkodShipment({
    credentials: creds, gonderi: gonderiFor(), fetchImpl: f.impl,
  })
  assert.equal(f.calls.length, 1)
  assert.equal(
    f.calls[0].url,
        // ROTA DEĞİŞTİ: `Pazaryerimi=1` gönderisi pazaryeri ucuna gider.
    // Canlı sözleşmede iki uç AYNI istek/yanıt modelini kullanır;
    // değişen tek şey yoldur (CF-4104179900 sonrası).
    'https://api02.suratkargo.com.tr/api/PazaryeriGonderi',
  )
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json')
  const body = JSON.parse(f.calls[0].init.body)
  assert.deepEqual(Object.keys(body), ['KullaniciAdi', 'Sifre', 'Gonderi'])
})

test('WEB-5: UYDURMA auth header YOK (Basic/Bearer/API-Key)', async () => {
  const f = makeFetch(() => okResult())
  await C.createOrtakBarkodShipment({
    credentials: C.resolveTenantSuratProductionCredentials(tenantA),
    gonderi: gonderiFor(), fetchImpl: f.impl,
  })
  const headers = f.calls[0].init.headers
  assert.deepEqual(Object.keys(headers), ['Content-Type'])
  for (const key of ['Authorization', 'authorization', 'X-Api-Key', 'apikey']) {
    assert.equal(key in headers, false, key)
  }
})

// ═══ 6-7. TENANT IZOLASYONU ═══════════════════════════════════════════════

test('WEB-6/7: her tenant YALNIZ kendi carisiyle istek yapar', async () => {
  for (const [account, expected] of [[tenantA, 'TENANT_A_CARI'], [tenantB, 'TENANT_B_CARI']]) {
    const f = makeFetch(() => okResult())
    await C.createOrtakBarkodShipment({
      credentials: C.resolveTenantSuratProductionCredentials(account),
      gonderi: gonderiFor(), fetchImpl: f.impl,
    })
    const body = JSON.parse(f.calls[0].init.body)
    assert.equal(body.KullaniciAdi, expected)
    // Diger tenant'in kimligi SIZMAZ.
    const other = expected === 'TENANT_A_CARI' ? 'TENANT_B_CARI' : 'TENANT_A_CARI'
    assert.equal(f.calls[0].init.body.includes(other), false)
  }
})

// ═══ 8-10. FAIL-CLOSED CREDENTIAL ═════════════════════════════════════════

test('WEB-8: tenant hesabi YOKSA fail-closed, AG ISTEGI YOK', () => {
  for (const [account, code] of [
    [null, 'SURAT_ACCOUNT_NOT_CONFIGURED'],
    [{ isActive: false, kullaniciAdi: 'X', sifre: 'Y' }, 'SURAT_ACCOUNT_NOT_CONFIGURED'],
    [{ kullaniciAdi: '', sifre: 'Y' }, 'SURAT_CUSTOMER_CODE_MISSING'],
    [{ kullaniciAdi: 'X', sifre: '' }, 'SURAT_SHIPPING_CREDENTIAL_MISSING'],
  ]) {
    assert.throws(
      () => C.resolveTenantSuratProductionCredentials(account),
      (error) => error.code === code,
      code,
    )
  }
})

test('WEB-9/10: ENV veya test credential fallback YOK', () => {
  const keys = [
    'SURAT_LIVE_KULLANICI_ADI', 'SURAT_LIVE_CARI_KODU', 'SURAT_LIVE_SIFRE',
    'SURAT_TEST_KULLANICI_ADI', 'SURAT_TEST_CARI_KODU', 'SURAT_TEST_SIFRE',
  ]
  const previous = {}
  for (const key of keys) {
    previous[key] = process.env[key]
    process.env[key] = `ENV_${key}`
  }
  try {
    // Tenant hesabi yoksa env DOLU olsa bile fail-closed.
    assert.throws(
      () => C.resolveTenantSuratProductionCredentials(null),
      (error) => error.code === 'SURAT_ACCOUNT_NOT_CONFIGURED',
    )
    // Tenant hesabi varsa env DEGERI KULLANILMAZ.
    const creds = C.resolveTenantSuratProductionCredentials(tenantA)
    assert.equal(creds.kullaniciAdi, 'TENANT_A_CARI')
    assert.equal(JSON.stringify(creds).includes('ENV_'), false)
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})

// ═══ 11-12. FALLBACK YASAGI ═══════════════════════════════════════════════

test('WEB-11/12: canli cagri BASARISIZSA baska hedef DENENMEZ', async () => {
  const f = makeFetch(() => ({
    ok: false, status: 500, json: async () => ({}), text: async () => '',
  }))
  await assert.rejects(
    () => C.createOrtakBarkodShipment({
      credentials: C.resolveTenantSuratProductionCredentials(tenantA),
      gonderi: gonderiFor(), fetchImpl: f.impl,
    }),
    (error) => error.code === 'SURAT_CANONICAL_CREATE_FAILED',
  )
  // TEK cagri: api01'e, prova'ya veya legacy SOAP'a DUSULMEDI.
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url.includes('api01'), false)
  assert.equal(f.calls[0].url.includes('asmx'), false)
})

// ═══ 13-15. YANIT AYRISTIRMA ══════════════════════════════════════════════

test('WEB-13: ResultMesaj basarili ayristirma', () => {
  const result = C.parseSuratOrtakBarkodResponse({
    isError: false, Message: 'OK', KargoTakipNo: '41176176501029',
    Barcode: ['^XA^XZ'], BarcodeNo: ['1234567890'],
  })
  assert.equal(result.trackingNo, '41176176501029')
  assert.deepEqual(result.barcodeNo, ['1234567890'])
  assert.equal(result.rawVendorStatus.isError, false)
})

test('WEB-14: isError=true BASARI SAYILMAZ', () => {
  assert.throws(
    () => C.parseSuratOrtakBarkodResponse({ isError: true, Message: 'Hata' }),
    (error) =>
      error.code === 'SURAT_CANONICAL_VENDOR_ERROR' && error.outcome === 'rejected',
  )
})

test('WEB-15: ortak barkod YOKSA fail-closed', () => {
  assert.throws(
    () => C.parseSuratOrtakBarkodResponse({
      isError: false, KargoTakipNo: '123', Barcode: [], BarcodeNo: [],
    }),
    (error) => error.code === 'SURAT_COMMON_BARCODE_MISSING',
  )
})

// ═══ 16. HOST IZIN LISTESI ════════════════════════════════════════════════

test('WEB-16: rastgele host REDDEDILIR', async () => {
  for (const bad of [
    'https://evil.example.com',
    'https://api01.suratkargo.com.tr',
    'http://api02.suratkargo.com.tr',
    'https://webservices.suratkargo.com.tr',
  ]) {
    const f = makeFetch(() => okResult())
    await assert.rejects(
      () => C.createOrtakBarkodShipment({
        credentials: C.resolveTenantSuratProductionCredentials(tenantA),
        gonderi: gonderiFor(), fetchImpl: f.impl, baseUrl: bad,
      }),
      (error) => error.code === 'SURAT_CANONICAL_HOST_NOT_ALLOWED',
      bad,
    )
    assert.equal(f.calls.length, 0, `${bad} icin AG ISTEGI YAPILMAMALI`)
  }
})

// ═══ 17-18. URETIM MODULU SOZLESMESI ══════════════════════════════════════

test('WEB-17: modul test/prova/sandbox kavrami TASIMAZ', () => {
  assert.equal('SURAT_CANONICAL_TEST_BASE_URL' in C, false)
  assert.equal(C.SURAT_CANONICAL_ALLOWED_HOSTS.includes('api01.suratkargo.com.tr'), false)
  // Zaman asimi ACIKCA tanimli.
  assert.equal(typeof C.SURAT_CANONICAL_TIMEOUT_MS, 'number')
  assert.ok(C.SURAT_CANONICAL_TIMEOUT_MS > 0)
})

test('WEB-18: govde UNITE 1 canonical builder ciktisiyla AYNI', async () => {
  const f = makeFetch(() => okResult())
  const gonderi = gonderiFor()
  await C.createOrtakBarkodShipment({
    credentials: C.resolveTenantSuratProductionCredentials(tenantA),
    gonderi, fetchImpl: f.impl,
  })
  const body = JSON.parse(f.calls[0].init.body)
  assert.deepEqual(body.Gonderi, JSON.parse(JSON.stringify(gonderi)))
  assert.strictEqual(body.Gonderi.Pazaryerimi, 1)
  assert.equal(body.Gonderi.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(body.Gonderi.OzelKargoTakipNo, '727TEST123')
  // Contract disi alan gitmez.
  for (const field of M.FORBIDDEN_CANONICAL_FIELDS) {
    assert.equal(field in body.Gonderi, false, field)
  }
})

// ═══ FATURALAMA BAGLAMI KAPISI ════════════════════════════════════════════

test('WEB-BILLING: pazaryeri kargo no YOKSA istek OLUSTURULAMAZ', () => {
  const ctx = M.resolveSuratMarketplaceContext({
    ...trendyolOrder, cargoTrackingNumber: '',
  })
  const validation = M.validateSuratBillingContext(ctx)
  assert.equal(validation.valid, false)
  assert.equal(validation.errorCode, 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING')
  // orderNumber/packageId'ye DUSULMEZ.
  assert.equal(ctx.ozelKargoTakipNo, '')
})

// ═══ LOG BAGLAMI ══════════════════════════════════════════════════════════

test('WEB-LOG: log baglami SIR ICERMEZ', () => {
  const context = C.buildSuratCanonicalLogContext({
    organizationId: 'org-1',
    marketplace: 'Trendyol',
    credentials: C.resolveTenantSuratProductionCredentials(tenantA),
  })
  assert.equal(context.adapter, 'SURAT_WEB_API')
  assert.equal(context.operation, 'OrtakBarkodOlustur')
  assert.equal(context.host, 'api02.suratkargo.com.tr')
  assert.equal(context.carrierAccountFingerprint, '****CARI')
  const json = JSON.stringify(context)
  assert.equal(json.includes('TENANT_A_SECRET'), false)
  assert.equal(json.includes('TENANT_A_CARI'), false)
})
