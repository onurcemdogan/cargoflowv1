import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// TRACE V2 KALICILAŞTIRMA ADLİ İNCELEMESİ — üretim çelişkisi CF-4088628726.
//
// ═══ ÜRETİM KANITI ════════════════════════════════════════════════════════
//   stages: PRE_FLIGHT → ROUTING → REQUEST_READY → ACTUAL_WIRE_READY →
//           CARRIER_CALL_STARTED → CARRIER_CALL → CARRIER_RESPONSE →
//           VERIFICATION → FINAL
//   carrierCalled=true · REJECTED · SURAT_CANONICAL_VENDOR_ERROR
//
// AMA denetçi TÜM tel alanlarını `ABSENT` gösterdi. Aşama VARKEN yük yoksa
// dört olasılık vardı; bu dosya HANGİSİ olduğunu ÖLÇER:
//   A) yük hiç kalıcılaşmıyor
//   B) denetçi YANLIŞ aşamayı/anahtarları okuyor
//   C) serileştirme alan düşürüyor
//   D) FINAL kaydı üzerine yazıyor
//
// AĞ YOK · GERÇEK TAŞIYICI CREATE YOK.
assert.notEqual(process.env.REAL_CARRIER_CREATE, '1')
assert.notEqual(process.env.LIVE_CREATE, '1')

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const repo = await import('./shipments/suratTraceRepository.ts')
const trace = await import('./shipments/suratCreateTrace.ts')
const WIRE = await import('./shipments/suratActualWireCapture.ts')
// DENETÇİNİN KULLANDIĞI izdüşümün TA KENDİSİ — kopya değil.
const PROJ = await import('./shipments/suratTraceProjection.ts')

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

async function freshDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'forensics', slug: `f-${randomBytes(4).toString('hex')}` })
    .returning()
  return { db, organizationId: org.id }
}

/** Üretimdeki NİHAİ gövde şekli. */
const finalizedRequest = () => ({
  KullaniciAdi: '1234562622',
  Sifre: 'tenant-secret',
  Gonderi: {
    KisiKurum: 'Ad Soyad', AliciAdresi: 'Gizli adres',
    Il: 'İstanbul', Ilce: 'Kadıköy',
    KargoTuru: 3, OdemeTipi: 1,
    ReferansNo: '4088628726',
    OzelKargoTakipNo: '7270036060751541',
    Adet: 1, Pazaryerimi: 1, EntegrasyonFirmasi: 'Trendyol', Iademi: 0,
  },
})

const VENDOR_ERROR =
  "System.InvalidCastException: Unable to cast object of type 'System.String' "
  + "to type 'KargoBarkod' at OrtakBarkodOlusturSonuc line 1836"

/** Üretimdeki 9 aşamalı sağlıklı-çağrı dizisi (yanıt REDDEDİLMİŞ). */
function buildProductionLikeAttempt() {
  const capture = WIRE.captureActualWire(finalizedRequest())
  const fp = capture.credential.networkBoundaryAccountFingerprint
  const verdict = WIRE.verifyWireFingerprints({
    resolverAccountFingerprint: fp,
    snapshotAccountFingerprint: fp,
    requestBuilderAccountFingerprint: fp,
    networkBoundaryAccountFingerprint: fp,
  })
  let attempt = trace.createTraceAttempt({
    traceId: 'CF-4088628726', createdAt: '2026-08-19T15:00:00.000Z',
  })
  const add = (stage, section, data) => {
    attempt = trace.appendTraceStage(attempt, {
      stage, section, at: '2026-08-19T15:00:01.000Z', data,
    })
  }
  add('PRE_FLIGHT', 'BILLING', { preflightValid: true })
  add('ROUTING', 'CREDENTIAL_ROUTING', {
    credentialRole: 'PRIMARY_MARKETPLACE',
    credentialSource: 'tenant.surat.primary',
  })
  add('REQUEST_READY', 'REQUEST', { intent: true })
  add('ACTUAL_WIRE_READY', 'REQUEST', { ...capture, ...verdict })
  add('CARRIER_CALL_STARTED', 'SERVICE_ROUTING', { wireCaptured: true })
  add('CARRIER_CALL', 'SERVICE_ROUTING', { attempts: 1 })
  add('CARRIER_RESPONSE', 'RESPONSE', {
    carrierCalled: true, createCallCount: 1,
    carrierCreateStatus: 'REJECTED',
    carrierCode: 'SURAT_CANONICAL_VENDOR_ERROR',
    carrierMessage: VENDOR_ERROR,
    trackingPresent: false, barcodePresent: false,
    zplPresent: false, zplLength: 0,
  })
  add('VERIFICATION', 'VERIFICATION', { verificationStage: 'none' })
  add('FINAL', 'FINAL_RESULT', {
    outcome: 'REJECTED', carrierCalled: true,
    carrierExceptionSummary: VENDOR_ERROR,
  })
  return attempt
}

const persistAndReload = async (attempt) => {
  const { db, organizationId } = await freshDb()
  const written = await repo.persistTraceAttempt(db, organizationId, {
    traceId: attempt.traceId,
    createdAt: attempt.createdAt,
    stages: attempt.stages,
    orderNumber: '11519931308',
    packageId: '4088628726',
    serviceMode: 'SURAT_CANONICAL_API',
    operation: 'OrtakBarkodOlustur',
    finalState: 'REJECTED',
  })
  assert.equal(written.persisted, true, 'iz KALICILASMADI')
  const reloaded = await repo.readLatestTraceAttempt(db, organizationId)
  assert.ok(reloaded, 'iz YENIDEN OKUNAMADI')
  return reloaded
}

/* ═══ TRACE-PERSIST-1 — YÜK APPEND/RELOAD'DA HAYATTA KALIR ═════════ */

test('TRACE-PERSIST-1: dolu ACTUAL_WIRE append+reload SONRASI TAM', async () => {
  const attempt = buildProductionLikeAttempt()

  // (1) APPEND anında yük DOLU mu?
  const beforeWire = PROJ.projectActualWire(attempt.stages)
  assert.equal(beforeWire.status, 'PRESENT', 'append aninda asama YOK')
  assert.equal(beforeWire.gonderiRuntimeType, 'object')
  assert.equal(beforeWire.fields.OdemeTipi.value, 1)

  // (2) RELOAD sonrasi HALA dolu mu?
  const reloaded = await persistAndReload(attempt)
  const wire = PROJ.projectActualWire(reloaded.stages)
  assert.equal(wire.status, 'PRESENT', 'ACTUAL_WIRE_READY reloadda KAYBOLDU')
  assert.equal(wire.rootRuntimeType, 'object')
  assert.equal(wire.gonderiRuntimeType, 'object')

  // Alanlar ve TIPLERI korunur.
  assert.equal(wire.fields.OdemeTipi.value, 1)
  assert.equal(wire.fields.Pazaryerimi.value, 1)
  assert.equal(wire.fields.EntegrasyonFirmasi.value, 'Trendyol')
  assert.equal(wire.fields.ReferansNo.value, '4088628726')
  assert.equal(wire.fields.OzelKargoTakipNo.value, '7270036060751541')
  assert.equal(wire.fieldRuntimeTypes.OdemeTipi, 'number')
  assert.equal(wire.fieldRuntimeTypes.EntegrasyonFirmasi, 'string')

  // Kimlik parmak izleri de korunur.
  assert.notEqual(wire.credential.networkBoundaryAccountFingerprint, 'ABSENT')
  assert.equal(wire.credential.credentialFingerprintMatch, true)
  assert.equal(wire.credential.sifrePresent, true)
})

test('TRACE-PERSIST-1b: ReferansNo ile OzelKargoTakipNo reloadda AYRI kalir', async () => {
  const reloaded = await persistAndReload(buildProductionLikeAttempt())
  const wire = PROJ.projectActualWire(reloaded.stages)
  assert.notEqual(wire.fields.ReferansNo.value, wire.fields.OzelKargoTakipNo.value)
})

/* ═══ TRACE-PERSIST-2 — PARSER İSTİSNASI İZİ SİLEMEZ ══════════════ */

test('TRACE-PERSIST-2: satici ayristirma hatasi ACTUAL_WIRE u SILEMEZ', async () => {
  const attempt = buildProductionLikeAttempt()
  const reloaded = await persistAndReload(attempt)

  // Yanit REDDEDILDI ve satici hatasi kayitli.
  const carrier = PROJ.projectCarrierTruth(reloaded.stages)
  assert.equal(carrier.carrierCalled, true)
  assert.equal(carrier.carrierCode, 'SURAT_CANONICAL_VENDOR_ERROR')
  assert.match(String(carrier.carrierMessage), /KargoBarkod/)

  // BUNA RAGMEN tel anlik goruntusu TAM.
  const wire = PROJ.projectActualWire(reloaded.stages)
  assert.equal(wire.status, 'PRESENT')
  assert.equal(wire.fields.ReferansNo.value, '4088628726')
})

/* ═══ TRACE-PERSIST-3 — ABSENT ile STAGE_MISSING AYRIDIR ══════════ */

test('TRACE-PERSIST-3: alan YOK ile asama YOK ayri gosterilir', async () => {
  // (a) Asama HIC yok → STAGE_MISSING.
  let blocked = trace.createTraceAttempt({
    traceId: 'CF-BLOCKED', createdAt: '2026-08-19T15:00:00.000Z',
  })
  blocked = trace.appendTraceStage(blocked, {
    stage: 'PRE_FLIGHT', section: 'BILLING', at: 'x',
    data: { preflightValid: false },
  })
  blocked = trace.appendTraceStage(blocked, {
    stage: 'FINAL', section: 'FINAL_RESULT', at: 'y',
    data: { outcome: 'BLOCKED_BY_PREFLIGHT', carrierCalled: false },
  })
  const missing = PROJ.projectActualWire(blocked.stages)
  assert.equal(missing.status, 'STAGE_MISSING')
  assert.equal(missing.gonderiRuntimeType, 'STAGE_MISSING')
  assert.equal(missing.rootRuntimeType, 'STAGE_MISSING')

  // (b) Asama VAR ama alan telde YOK → ABSENT.
  const present = PROJ.projectActualWire(
    buildProductionLikeAttempt().stages,
  )
  assert.equal(present.status, 'PRESENT')
  // Kanonik sozlesmede WhoPays/KimOder YOK → ABSENT (STAGE_MISSING DEGIL).
  assert.equal(present.fields.WhoPays.value, 'ABSENT')
  assert.equal(present.fields.KimOder.value, 'ABSENT')
  assert.equal(present.fields.FirmaId.value, 'ABSENT')

  // IKI DURUM BIRBIRINE ESIT DEGIL — birlestirilmeleri kusurun kendisiydi.
  assert.notEqual(missing.status, present.status)
})

/* ═══ TRACE-PERSIST-4 — TEK KİMLİK ═══════════════════════════════ */

test('TRACE-PERSIST-4: tum asamalar TEK traceId altinda', async () => {
  const attempt = buildProductionLikeAttempt()
  const reloaded = await persistAndReload(attempt)
  assert.equal(reloaded.traceId, 'CF-4088628726')
  assert.equal(reloaded.stages.length, attempt.stages.length)
  assert.deepEqual(
    reloaded.stages.map((s) => s.stage),
    [...trace.TRACE_LIFECYCLE_STAGES],
    'uretimdeki 9 asamali dizi korunmadi',
  )
})

/* ═══ KÖK NEDEN — DENETÇİ YANLIŞ AŞAMAYI OKUYORDU ════════════════ */

test('FORENSIC-1: KOK NEDEN okuma tarafinda, kalicilastirmada DEGIL', async () => {
  const reloaded = await persistAndReload(buildProductionLikeAttempt())

  // Kalicilastirma SAGLAM: yuk aynen duruyor.
  const raw = reloaded.stages.find((s) => s.stage === 'ACTUAL_WIRE_READY')
  assert.ok(raw, 'ACTUAL_WIRE_READY kaydedilmemis')
  assert.ok(raw.data && typeof raw.data === 'object', 'yuk BOS')
  assert.equal(raw.data.gonderiRuntimeType, 'object')
  assert.ok(Object.keys(raw.data.gonderiFieldTypes ?? {}).length > 5)

  // ESKI OKUMA (REQUEST_READY + ham anahtarlar) her seyi ABSENT gosterirdi.
  const wrongStage = PROJ.stageData(reloaded.stages, 'REQUEST_READY')
  assert.ok(wrongStage, 'REQUEST_READY yok')
  assert.equal(wrongStage.Gonderi, undefined, 'ham Gonderi anahtari orada DEGIL')
  assert.equal(wrongStage.OdemeTipi, undefined)

  // DOGRU OKUMA calisir.
  assert.equal(PROJ.projectActualWire(reloaded.stages).status, 'PRESENT')
})

/* ═══ REDAKSİYON — SIR GİDER, TEŞHİS KALIR ═══════════════════════ */

test('FORENSIC-2: *Present/*Fingerprint alanlari REDAKTE EDILMEZ', () => {
  const redacted = trace.redactTraceValue({
    // GERCEK SIRLAR — gitmeli.
    Sifre: 'super-secret',
    password: 'p',
    apiSecret: 'a',
    authorization: 'Bearer x',
    // TESHIS ALANLARI — kalmali (yapisal olarak sir tasiyamaz).
    sifrePresent: true,
    kullaniciAdiPresent: true,
    networkBoundaryAccountFingerprint: 'LEN10:****2622',
    serializedLength: 412,
    gonderiRuntimeType: 'object',
    credentialRole: 'PRIMARY_MARKETPLACE',
    credentialSource: 'tenant.surat.primary',
  })
  // Sirlar maskelendi.
  for (const key of ['Sifre', 'password', 'apiSecret', 'authorization']) {
    assert.equal(redacted[key], '«REDACTED»', `${key} maskelenmedi`)
  }
  // Teshis alanlari KORUNDU.
  assert.equal(redacted.sifrePresent, true, 'sifrePresent redakte edildi')
  assert.equal(redacted.kullaniciAdiPresent, true)
  assert.equal(redacted.networkBoundaryAccountFingerprint, 'LEN10:****2622')
  assert.equal(redacted.serializedLength, 412)
  assert.equal(redacted.gonderiRuntimeType, 'object')
  assert.equal(redacted.credentialRole, 'PRIMARY_MARKETPLACE')
})

test('FORENSIC-2b: ham parola HICBIR sekilde kalicilasmaz', async () => {
  const attempt = buildProductionLikeAttempt()
  const reloaded = await persistAndReload(attempt)
  const serialized = JSON.stringify(reloaded)
  for (const secret of ['tenant-secret', '1234562622', 'Ad Soyad', 'Gizli adres']) {
    assert.equal(
      serialized.includes(secret), false,
      `kalicilasan izde sizinti: ${secret}`,
    )
  }
})
