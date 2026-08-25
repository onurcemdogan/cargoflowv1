import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// SOAP BİRİNCİL CREATE — PAZARYERİ.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// Kanonik REST yolu DOĞRU kiracı, DOĞRU birincil kimlik ve dört sınırda tam
// parite ile çağrıldı ve yine reddedildi: taşıyıcının KENDİ sonuç
// kurucusunda `InvalidCastException`. Depoda DOĞRULANMIŞ başarı SOAP
// yolundadır (`OrtakBarkodOlusturSoap` · 013 · verifiedShipment).
//
// Bu testler yeni birincil rotanın, kanonik yolun kazandığı güvenceleri
// KAYBETMEDEN çalıştığını kilitler: dondurulmuş kimlik, ağa çıkmadan parite,
// Trace V2, ve "HTTP 200 ≠ başarı" sınıflandırması.
//
// AĞ ÇAĞRISI YOKTUR: taşıyıcı yürütücüsü enjekte edilir.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const ROUTE = await import('./shipments/suratPrimaryCreateRoute.ts')
const SOAP = await import('./shipments/suratSoapPrimaryCreate.ts')
const WIRE = await import('./shipments/suratSoapWireCapture.ts')
const SNAP = await import('./shipments/suratCredentialSnapshot.ts')
const GATE = await import('./shipments/suratFinancialGate.ts')
const repo = await import('./shipments/suratTraceRepository.ts')

const INDEX_SOURCE = await readFile(
  new URL('./index.mjs', import.meta.url), 'utf8',
)

// Depo deseni: YALNIZ tam satır yorumları düşürülür. Blok yorum deseni
// dizeler ve regex literalleri içindeki `/*` ile eşleşip kaynağın büyük
// bölümünü sessizce yutuyor ve iddiayı ANLAMSIZ yapıyordu.
const stripComments = (source) => source
  .split(/\r?\n/).filter((line) => !line.trim().startsWith('//'))
  .join('\n')

const TENANT_STORE = {
  serviceMode: 'ORTAK_BARKOD_SOAP',
  liveKullaniciAdi: '1537690944',
  liveSifre: 'TENANT_SECRET',
}

const authoritativeSnapshot = () => SNAP.buildSuratCredentialSnapshot({
  storedSuratConfig: SNAP.normalizeAuthoritativeSuratStore(TENANT_STORE),
  role: 'PRIMARY_MARKETPLACE',
})

/** Doğrulanmış SOAP zarfı — `buildSuratGonderiXml` yapısıyla AYNI. */
const buildEnvelope = ({ kullaniciAdi = '1537690944' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <OrtakBarkodOlustur xmlns="http://tempuri.org/">
      <KullaniciAdi>${kullaniciAdi}</KullaniciAdi>
      <Sifre>TENANT_SECRET</Sifre>
      <Gonderi>
        <KisiKurum>Test Alici</KisiKurum>
        <AliciAdresi>Ornek Mah. 1</AliciAdresi>
        <Il>Istanbul</Il>
        <Ilce>Kadikoy</Ilce>
        <TelefonCep>5551112233</TelefonCep>
        <KargoTuru>1</KargoTuru>
        <OdemeTipi>1</OdemeTipi>
        <ReferansNo>4088628726</ReferansNo>
        <OzelKargoTakipNo>727TEST123</OzelKargoTakipNo>
        <Adet>1</Adet>
        <KapidanOdemeTahsilatTipi>0</KapidanOdemeTahsilatTipi>
        <TasimaSekli>1</TasimaSekli>
        <TeslimSekli>1</TeslimSekli>
        <GonderiSekli>1</GonderiSekli>
        <Pazaryerimi>1</Pazaryerimi>
        <EntegrasyonFirmasi>Trendyol</EntegrasyonFirmasi>
        <Iademi>0</Iademi>
      </Gonderi>
    </OrtakBarkodOlustur>
  </soap:Body>
</soap:Envelope>`

let clock = 0
const stamp = () => `2026-08-19T12:00:${String(clock++).padStart(2, '0')}.000Z`

async function runSoap({ snapshot, execution, envelope, wireAccount } = {}) {
  const calls = []
  const outcome = await SOAP.createSuratSoapPrimaryShipment({
    traceId: 'CF-SOAP-TEST-1',
    stamp,
    credentialSnapshot: snapshot ?? authoritativeSnapshot(),
    financialContext: {
      billingParty: 'TRENDYOL_PAYS',
      expectedSuratWhoPays: '3',
      odemeTipi: 1,
      codEnabled: false,
      pazaryerimi: 1,
      entegrasyonFirmasi: 'Trendyol',
    },
    marketplace: 'Trendyol',
    wireAccountPreview: wireAccount ?? '1537690944',
    credentialRecordIdentity: {
      organizationIdMasked: '****f4ad', integrationIdMasked: '****8c4f',
    },
    executeCreate: async ({ onWireReady }) => {
      calls.push('execute')
      onWireReady(envelope ?? buildEnvelope())
      return execution ?? {}
    },
  })
  return { outcome, calls }
}

/* ═══ SOAP-PRIMARY-1 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-1: yeni Trendyol pazaryeri create ORTAK_BARKOD_SOAP secer', () => {
  const route = ROUTE.resolveSuratPrimaryCreateRoute({
    configuredServiceMode: 'SURAT_CANONICAL_API',
    marketplace: 'Trendyol',
  })
  assert.equal(route.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(route.serviceType, 'OrtakBarkodOlusturSoap')
  assert.equal(route.operation, 'OrtakBarkodOlustur')
  assert.equal(route.soapPrimarySelected, true)
  // Kayitli mod ezildi — SESSIZ degil, gorunur.
  assert.equal(route.overrodeConfiguredMode, true)
  assert.equal(route.configuredServiceMode, 'SURAT_CANONICAL_API')

  // Ilgisiz pazaryerlerinin modu DEGISMEZ: onlar icin depo kaniti YOK.
  const other = ROUTE.resolveSuratPrimaryCreateRoute({
    configuredServiceMode: 'GONDERI_YENI_SOAP', marketplace: 'Hepsiburada',
  })
  assert.equal(other.serviceMode, 'GONDERI_YENI_SOAP')
  assert.equal(other.soapPrimarySelected, false)

  // Sunucu karari GERCEKTEN uyguluyor.
  const server = stripComments(INDEX_SOURCE)
  assert.match(server, /resolveSuratPrimaryCreateRoute\(/)
  assert.match(server, /primaryRoute\.soapPrimarySelected/)
})

/* ═══ SOAP-PRIMARY-2 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-2: kanonik API cagrilmaz', async () => {
  const route = ROUTE.resolveSuratPrimaryCreateRoute({
    configuredServiceMode: 'SURAT_CANONICAL_API', marketplace: 'trendyol',
  })
  assert.notEqual(route.serviceMode, 'SURAT_CANONICAL_API')

  // Rota kanonikten ONCE hesaplanmali; yoksa kanonik dal once eslesirdi.
  const server = stripComments(INDEX_SOURCE)
  const routeAt = server.indexOf('resolveSuratPrimaryCreateRoute(')
  const canonicalBranchAt = server.indexOf(
    'if (config.serviceMode === SURAT_CANONICAL_SERVICE_MODE) {',
  )
  assert.ok(routeAt > 0 && canonicalBranchAt > 0)
  assert.ok(
    routeAt < canonicalBranchAt,
    'birincil rota karari kanonik daldan SONRA hesaplaniyor',
  )
  // SOAP yurutucusu kanonik adaptoru CAGIRMAZ.
  const soapSource = readFileSync(
    join(here, 'shipments', 'suratSoapPrimaryCreate.ts'), 'utf8',
  )
  assert.equal(soapSource.includes('suratCanonicalCreateAdapter'), false)
  assert.equal(soapSource.includes('createOrtakBarkodShipment'), false)
})

/* ═══ SOAP-PRIMARY-3 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-3: SOAP dondurulmus kiraci anlik goruntusunu kullanir', async () => {
  const { outcome } = await runSoap({
    execution: {
      httpSuccess: true, businessCode: '013', codeCategory: 'BARCODE_SUCCESS',
      trackingNumber: '41176176501029', barcode: 'Web00157962154',
      zpl: '^XA^FDTEST^FS^XZ', verifiedShipment: true, response: { ok: true },
    },
  })
  const routing = outcome.traceAttempt.stages
    .find((entry) => entry.stage === 'ROUTING')?.data
  assert.equal(routing.credentialSource, 'tenant.surat.primary')
  assert.equal(routing.credentialResolved, true)
  assert.equal(routing.snapshotAccountFingerprint, 'LEN10:****0944')

  const wire = outcome.traceAttempt.stages
    .find((entry) => entry.stage === 'ACTUAL_WIRE_READY')?.data
  // Ag sinirinda GERCEKTEN giden hesap ile anlik goruntu AYNI.
  assert.equal(wire.networkBoundaryAccountFingerprint, 'LEN10:****0944')
  assert.equal(wire.credentialFingerprintMatch, true)

  // Kimlik degeri hicbir asamada HAM gecmez.
  const serialized = JSON.stringify(outcome.traceAttempt)
  assert.equal(serialized.includes('TENANT_SECRET'), false)
  assert.equal(serialized.includes('1537690944'), false)
})

/* ═══ SOAP-PRIMARY-4 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-4: istemci kimligi SOAP hesabini EZEMEZ', async () => {
  // Istemci baska bir cari secmeye calisti.
  const { outcome, calls } = await runSoap({
    wireAccount: '1537692622',
    envelope: buildEnvelope({ kullaniciAdi: '1537692622' }),
    execution: { httpSuccess: true, businessCode: '016' },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'SURAT_CREDENTIAL_WIRE_MISMATCH')
  // DOGRULANMIS ZINCIRIN ILK cagrisi SOAP DEGILDIR (once kayit tescili).
  // Bu yuzden kapi zincir BASLAMADAN duser: yurutucu HIC cagrilmaz.
  assert.equal(calls.length, 0)
  assert.equal(outcome.carrierCalled, false)
  assert.equal(outcome.carrierCreateAttempts, 0)

  const blockedStage = outcome.traceAttempt.stages
    .find((entry) => entry.stage === 'WIRE_BLOCKED')?.data
  assert.equal(blockedStage.networkCallCount, 0)
  assert.equal(blockedStage.carrierCalled, false)
  assert.equal(blockedStage.boundary, 'PRE_CHAIN')

  // Sunucu kimligi anlik goruntuden BAGLAR; istek govdesinden DEGIL.
  const server = stripComments(INDEX_SOURCE)
  assert.match(server, /kullaniciAdi: credentialSnapshot\.kullaniciAdi/)
  assert.match(server, /sifre: credentialSnapshot\.sifre/)
})

/* ═══ SOAP-PRIMARY-5 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-5: finansal kapi SOAP agindan ONCE calisir', () => {
  // Kapi ORTAK_BARKOD_SOAP'i KAPSAR.
  assert.ok(GATE.GUARDED_SURAT_SERVICE_MODES.includes('ORTAK_BARKOD_SOAP'))

  const server = stripComments(INDEX_SOURCE)
  const gateAt = server.indexOf('evaluateSuratFinancialGate({')
  const soapBranchAt = server.indexOf("if (config.serviceMode === 'ORTAK_BARKOD_SOAP') {")
  assert.ok(gateAt > 0 && soapBranchAt > 0)
  assert.ok(gateAt < soapBranchAt, 'kapi SOAP dalindan SONRA calisiyor')

  // Kapi dustugunde dal HIC calismaz: erken donus var.
  const between = server.slice(gateAt, soapBranchAt)
  assert.match(between, /if \(!financialGate\.ok\)/)
  assert.match(between, /return/)

  // Gecersiz baglam: kapi ag cagrisi YAPMADAN reddeder.
  const blocked = GATE.evaluateSuratFinancialGate({
    config: { serviceMode: 'ORTAK_BARKOD_SOAP' },
    order: { marketplace: 'Trendyol' },
    cashOnDelivery: false,
    serviceMode: 'ORTAK_BARKOD_SOAP',
  })
  assert.equal(blocked.ok, false)
})

/* ═══ SOAP-PRIMARY-6 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-6: cozulemeyen kimlikte ag cagrisi SIFIR', async () => {
  const unresolved = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: {}, role: 'PRIMARY_MARKETPLACE',
  })
  const { outcome, calls } = await runSoap({ snapshot: unresolved })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'PRIMARY_CREDENTIAL_NOT_CONFIGURED')
  // Yurutucu HIC cagrilmadi: zarf bile kurulmadi.
  assert.equal(calls.length, 0)
  assert.equal(outcome.carrierCalled, false)
  assert.equal(outcome.carrierCreateAttempts, 0)
  // Cozulmemis kimlik "kiraci birincil hesabi" gibi ETIKETLENMEZ.
  const routing = outcome.traceAttempt.stages
    .find((entry) => entry.stage === 'ROUTING')?.data
  assert.equal(routing.credentialSource, 'UNRESOLVED_SNAPSHOT')
})

/* ═══ SOAP-PRIMARY-7 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-7: tarihsel 013 basarisi BASARILI kalir', async () => {
  // docs/surat-finalization: 11415535074 · OrtakBarkodOlusturSoap · 013
  // BARCODE_SUCCESS · verifiedShipment=true · Web00157962154
  const { outcome } = await runSoap({
    execution: {
      httpSuccess: true,
      businessCode: '013',
      businessMessage: 'Barkod tekrardan iletilmistir',
      codeCategory: 'BARCODE_SUCCESS',
      trackingNumber: '41176176501029',
      barcode: 'Web00157962154',
      zpl: '^XA^FO50,50^FDTEST^FS^XZ',
      verifiedShipment: true,
      response: { ok: true },
    },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.classification.finalClassification, 'CREATED_CONFIRMED')
  assert.equal(outcome.classification.carrierRegistrationConfirmed, true)
  assert.equal(outcome.suratCreateTrace.carrierCreateStatus, 'SUCCESS')
  const verification = outcome.traceAttempt.stages
    .find((entry) => entry.stage === 'VERIFICATION')?.data
  assert.equal(verification.verifiedShipment, true)
  assert.equal(verification.zplPresent, true)
})

/* ═══ SOAP-PRIMARY-8 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-8: dogrulanmis kimlik olmadan 016 BASARI DEGILDIR', async () => {
  // 016 + barkod var, takip numarasi YOK.
  const partial = await runSoap({
    execution: {
      httpSuccess: true, businessCode: '016', codeCategory: 'BARCODE_SUCCESS',
      trackingNumber: '', barcode: 'Web00157962154', zpl: '^XA^XZ',
      verifiedShipment: false, response: { ok: true },
    },
  })
  assert.equal(partial.outcome.ok, false)
  assert.equal(
    partial.outcome.classification.finalClassification,
    'CREATED_VERIFICATION_INCOMPLETE',
  )
  assert.equal(partial.outcome.classification.carrierRegistrationConfirmed, false)

  // Artefaktlar TAM ama read teyidi YOK: yine "olusturuldu" DENMEZ.
  const unverified = await runSoap({
    execution: {
      httpSuccess: true, businessCode: '016', codeCategory: 'BARCODE_SUCCESS',
      trackingNumber: '41176176501029', barcode: 'Web00157962154',
      zpl: '^XA^XZ', verifiedShipment: false, response: { ok: true },
    },
  })
  assert.equal(unverified.outcome.ok, false)
  assert.equal(
    unverified.outcome.suratCreateTrace.carrierCreateStatus,
    'TRACKING_CONFIRMATION_MISSING',
  )
})

/* ═══ SOAP-PRIMARY-9 ═══════════════════════════════════════════════ */

test('SOAP-PRIMARY-9: 039 SAVED_BARCODE_FAILED demektir', async () => {
  const { outcome } = await runSoap({
    execution: {
      httpSuccess: true,
      businessCode: '039',
      businessMessage: 'Siparis kaydedildi, barkod olusturulamadi',
      codeCategory: 'PARTIAL',
      trackingNumber: '', barcode: '', zpl: '',
      verifiedShipment: false,
      response: { ok: false },
    },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.classification.finalClassification, 'SAVED_BARCODE_FAILED')
  // KAYIT OLUSTU: kor tekrar MUKERRER gonderi demektir.
  assert.equal(outcome.classification.carrierRegistrationConfirmed, true)
  assert.equal(outcome.classification.retryAllowed, false)
  assert.equal(outcome.suratCreateTrace.carrierCreateStatus, 'SAVED_BARCODE_FAILED')
})

/* ═══ SOAP-PRIMARY-10 ══════════════════════════════════════════════ */

test('SOAP-PRIMARY-10: basarisiz kanonik siparis SOAP ile OTOMATIK tekrarlanmaz', async () => {
  // Karar fonksiyonu onceki denemenin sonucunu GIRDI OLARAK ALMAZ.
  const params = ROUTE.resolveSuratPrimaryCreateRoute.length
  assert.equal(params, 1, 'rota karari ek girdi aliyor')
  const routeSource = readFileSync(
    join(here, 'shipments', 'suratPrimaryCreateRoute.ts'), 'utf8',
  )
  for (const forbidden of ['retry', 'fallback', 'previousAttempt', 'lastError']) {
    assert.equal(
      new RegExp(`${forbidden}\\s*[:.]`, 'i').test(stripComments(routeSource)),
      false,
      `rota karari ${forbidden} girdisi tasiyor`,
    )
  }

  // Sunucuda kanonik hatadan SOAP'a otomatik gecis YOKTUR.
  const server = stripComments(INDEX_SOURCE)
  const canonicalAt = server.indexOf(
    'if (config.serviceMode === SURAT_CANONICAL_SERVICE_MODE) {',
  )
  const soapAt = server.indexOf("if (config.serviceMode === 'ORTAK_BARKOD_SOAP') {")
  const canonicalBlock = server.slice(canonicalAt, soapAt)
  assert.equal(
    canonicalBlock.includes('createSuratRegisteredCommonBarcode'), false,
    'kanonik dal SOAP create cagiriyor',
  )
  assert.equal(
    canonicalBlock.includes('createSuratSoapPrimaryShipment'), false,
    'kanonik dal SOAP birincil yolunu cagiriyor',
  )
})

/* ═══ SOAP-PRIMARY-11 ══════════════════════════════════════════════ */

test('SOAP-PRIMARY-11: yeni siparis SOAP yolunu YALNIZ BIR KEZ kullanir', async () => {
  const { outcome, calls } = await runSoap({
    execution: {
      httpSuccess: true, businessCode: '013', codeCategory: 'BARCODE_SUCCESS',
      trackingNumber: '41176176501029', barcode: 'Web00157962154',
      zpl: '^XA^XZ', verifiedShipment: true, response: { ok: true },
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(outcome.carrierCreateAttempts, 1)
  const started = outcome.traceAttempt.stages
    .filter((entry) => entry.stage === 'CARRIER_CALL_STARTED')
  assert.equal(started.length, 1)
  const responses = outcome.traceAttempt.stages
    .filter((entry) => entry.stage === 'CARRIER_RESPONSE')
  assert.equal(responses.length, 1)
  assert.equal(responses[0].data.createCallCount, 1)
})

/* ═══ SOAP-PRIMARY-12 ══════════════════════════════════════════════ */

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}

test('SOAP-PRIMARY-12: Trace V2 gercek tel + yanit yeniden okumada DURUR', async (t) => {
  const pglite = new PGlite()
  t.after(() => pglite.close())
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'Soap Tenant', slug: 'soap-tenant' }).returning()

  const { outcome } = await runSoap({
    execution: {
      httpSuccess: true, businessCode: '013', codeCategory: 'BARCODE_SUCCESS',
      trackingNumber: '41176176501029', barcode: 'Web00157962154',
      zpl: '^XA^FO50,50^FDTEST^FS^XZ', verifiedShipment: true,
      response: { ok: true },
    },
  })

  await repo.persistTraceAttempt(db, org.id, {
    traceId: outcome.traceAttempt.traceId,
    createdAt: outcome.traceAttempt.createdAt,
    stages: outcome.traceAttempt.stages,
    summary: outcome.suratCreateTrace,
    orderNumber: '11415535074',
    serviceMode: 'ORTAK_BARKOD_SOAP',
    operation: 'OrtakBarkodOlustur',
    finalState: outcome.suratCreateTrace.carrierCreateStatus,
  })

  const reloaded = await repo.readLatestTraceAttempt(db, org.id)
  const stages = reloaded.stages.map((entry) => entry.stage)
  for (const stage of [
    'PRE_FLIGHT', 'ROUTING', 'REQUEST_READY', 'ACTUAL_WIRE_READY',
    'CARRIER_CALL_STARTED', 'CARRIER_RESPONSE', 'VERIFICATION', 'FINAL',
  ]) {
    assert.ok(stages.includes(stage), `${stage} yeniden okumada YOK`)
  }

  const wire = reloaded.stages
    .find((entry) => entry.stage === 'ACTUAL_WIRE_READY').data
  // GERCEK TEL: alan adlari/tipleri ve guvenli degerler AYNEN duruyor.
  assert.equal(wire.gonderiPresent, true)
  assert.equal(wire.safeValues.OdemeTipi, '1')
  assert.equal(wire.safeValues.Pazaryerimi, '1')
  assert.equal(wire.safeValues.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(wire.safeValues.ReferansNo, '4088628726')
  assert.equal(wire.safeValues.OzelKargoTakipNo, '727TEST123')
  assert.equal(wire.gonderiFieldTypes.OdemeTipi, 'integer')
  assert.equal(wire.gonderiFieldTypes.EntegrasyonFirmasi, 'string')
  // Sozlesmede olmayan alanlar UYDURULMAZ.
  assert.equal(wire.contractAbsentFields.WhoPays.present, false)
  assert.equal(wire.contractAbsentFields.KimOder.present, false)
  assert.equal(wire.contractAbsentFields.FirmaId.present, false)
  // Kimlik: parmak izi VAR, ham deger YOK.
  assert.equal(wire.credential.sifrePresent, true)
  assert.equal(wire.networkBoundaryAccountFingerprint, 'LEN10:****0944')

  const response = reloaded.stages
    .find((entry) => entry.stage === 'CARRIER_RESPONSE').data
  assert.equal(response.carrierCode, '013')
  assert.equal(response.trackingPresent, true)
  assert.equal(response.barcodePresent, true)
  assert.equal(response.zplPresent, true)
  assert.equal(response.zplLength > 0, true)

  // PII ve sir yeniden okumada da YOK.
  const serialized = JSON.stringify(reloaded)
  for (const secret of ['TENANT_SECRET', '1537690944', 'Test Alici', '5551112233']) {
    assert.equal(serialized.includes(secret), false, `${secret} kalici izde`)
  }
})

/* ═══ TEL YAKALAMA BIRIM IDDIALARI ═════════════════════════════════ */

test('SOAP-WIRE-1: zarf yoksa alanlar UYDURULMAZ', () => {
  const capture = WIRE.captureSoapActualWire({ envelope: '' })
  assert.equal(capture.envelopePresent, false)
  assert.equal(capture.gonderiPresent, false)
  assert.deepEqual(capture.gonderiFieldNames, [])
  // "Alan yok" ile "alan bos" AYNI SEY DEGILDIR.
  assert.equal(capture.safeValues.OdemeTipi, null)
  assert.equal(WIRE.soapValueRuntimeType(null), 'absent')
  assert.equal(WIRE.soapValueRuntimeType(''), 'empty')
})

test('SOAP-WIRE-2: PII alan ADI gorunur, DEGERI asla', () => {
  const capture = WIRE.captureSoapActualWire({ envelope: buildEnvelope() })
  assert.ok(capture.gonderiFieldNames.includes('KisiKurum'))
  assert.ok(capture.gonderiFieldNames.includes('TelefonCep'))
  assert.equal(capture.gonderiFieldTypes.KisiKurum, 'string')
  const serialized = JSON.stringify(capture)
  assert.equal(serialized.includes('Test Alici'), false)
  assert.equal(serialized.includes('5551112233'), false)
  assert.equal(serialized.includes('Ornek Mah'), false)
})

/* ═══ SOAP-PRIMARY-4b — AG SINIRI IKINCI KAPIDIR ═══════════════════ */

test('SOAP-PRIMARY-4b: on kapi gecse bile zarf ayrisirsa gonderilmez', async () => {
  // On izleme dogru hesabi soyluyor ama zarf BASKA hesap tasiyor: iki kapi
  // ayri sinirlarda olcer, biri digerinin yerine gecmez.
  const { outcome, calls } = await runSoap({
    wireAccount: '1537690944',
    envelope: buildEnvelope({ kullaniciAdi: '1537692622' }),
    execution: { httpSuccess: true, businessCode: '016' },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'SURAT_CREDENTIAL_WIRE_MISMATCH')
  assert.equal(calls.length, 1)
  assert.equal(outcome.carrierCalled, false)
  const blocked = outcome.traceAttempt.stages
    .find((entry) => entry.stage === 'WIRE_BLOCKED')?.data
  assert.equal(blocked.networkCallCount, 0)
})

/* ═══ SOAP-PRIMARY-6b — IDEMPOTENCY ANAHTARI MOD TASIMAZ ═══════════ */

test('SOAP-PRIMARY-6b: mod degisimi yeni idempotency anahtari URETMEZ', () => {
  const server = stripComments(INDEX_SOURCE)
  // Anahtar: tenant + siparis + CREATE. `serviceMode` KATILMAZ; katilsaydi
  // birincil mod degisimi ayni siparis icin IKINCI fiziksel gonderi acardi.
  assert.match(server, /idempotencyKey: `SURAT:\$\{tenantId\}:\$\{orderId\}:CREATE`/)
  const keyAt = server.indexOf('idempotencyKey: `SURAT:')
  const keyLine = server.slice(keyAt, server.indexOf('\n', keyAt))
  assert.equal(keyLine.includes('serviceMode'), false)

  // Onceki BASARISIZ kayit yeni modla SESSIZCE uygun hale GELMEZ.
  assert.match(server, /existing\?\.status === 'FAILED_SAFE' && !retryAuthorized/)
  assert.match(server, /\['IN_PROGRESS', 'UNKNOWN'\]\.includes\(existing\.status\)/)
  assert.match(server, />= operation\.maxCreateCalls/)

  // Kayit GERCEKTEN kullanilan modu yazar; kanit yalan soylemez.
  assert.match(server, /operationRoute\.soapPrimarySelected/)
})

/* ═══ SOAP-PRIMARY-1b — ACIK MOD SECIMI ELE GECIRILMEZ ═════════════ */

test('SOAP-PRIMARY-1b: acikca secilmis baska mod DEGISTIRILMEZ', () => {
  // Kapsam KIRIK KANONIK MODDUR. Kiraci baska bir modu ACIKCA sectiyse o
  // secim onundur; aksi halde bu duzeltme ilgisiz modlari ele gecirirdi.
  for (const mode of [
    'PRE_REGISTRATION_REST',
    'GONDERI_YENI_SOAP',
    'KARGO_BARKODU_SIPARIS_SOAP',
    'GONDERI_OLUSTUR_V2_EXPERIMENTAL',
  ]) {
    const route = ROUTE.resolveSuratPrimaryCreateRoute({
      configuredServiceMode: mode, marketplace: 'Trendyol',
    })
    assert.equal(route.serviceMode, mode, `${mode} ele gecirildi`)
    assert.equal(route.soapPrimarySelected, false)
    assert.match(route.reason, /CONFIGURED_MODE_NOT_REPLACEABLE/)
  }
  // Zaten SOAP olan kiracinin rotasi da DEGISTIRILMEZ: onun `serviceType`
  // secimi hangi SOAP zincirinin calisacagini belirler ve o tenant KIRIK
  // DEGILDIR. Bu turda duzeltilen tek sey kanonik REST'in reddedilmesidir.
  const already = ROUTE.resolveSuratPrimaryCreateRoute({
    configuredServiceMode: 'ORTAK_BARKOD_SOAP', marketplace: 'Trendyol',
  })
  assert.equal(already.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(already.soapPrimarySelected, false)
  assert.equal(already.overrodeConfiguredMode, false)
})
