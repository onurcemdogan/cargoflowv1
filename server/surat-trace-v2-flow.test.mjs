import assert from 'node:assert/strict'
import test from 'node:test'

// FAZ C — TRACE V2: tek kimlik, tam yaşam döngüsü, değişmez anlık görüntü,
// denemeler arası SIZINTISIZ yalıtım.

const T = await import('./shipments/suratCreateTrace.ts')

const open = (id) => T.createTraceAttempt({
  traceId: id, createdAt: '2026-08-18T00:00:00.000Z',
})

const full = (id, payload) => {
  let attempt = open(id)
  const stages = [
    ['PRE_FLIGHT', 'BILLING'], ['ROUTING', 'CREDENTIAL_ROUTING'],
    ['REQUEST_READY', 'REQUEST'], ['CARRIER_CALL', 'SERVICE_ROUTING'],
    ['CARRIER_RESPONSE', 'RESPONSE'], ['VERIFICATION', 'VERIFICATION'],
    ['FINAL', 'FINAL_RESULT'],
  ]
  for (const [stage, section] of stages) {
    attempt = T.appendTraceStage(attempt, {
      stage, section, at: '2026-08-18T00:00:01.000Z', data: { payload },
    })
  }
  return attempt
}

/* ═══ ŞEMA + YAŞAM DÖNGÜSÜ ════════════════════════════════════════════ */

test('TRC-1: sema surumu 2', () => {
  assert.equal(T.SURAT_TRACE_SCHEMA_VERSION, 2)
  assert.equal(open('CF-1').schemaVersion, 2)
})

test('TRC-2: yasam dongusu PRE_FLIGHT → FINAL tam', () => {
  const attempt = full('CF-1', 'A')
  assert.equal(T.isTraceLifecycleComplete(attempt), true)
  assert.equal(attempt.stages.length, T.TRACE_LIFECYCLE_STAGES.length)
  for (const entry of attempt.stages) {
    assert.ok(T.TRACE_LIFECYCLE_STAGES.includes(entry.stage), entry.stage)
    assert.ok(T.TRACE_SECTIONS.includes(entry.section), entry.section)
  }
})

test('TRC-3: eksik dongu TAM sayilmaz', () => {
  const partial = T.appendTraceStage(open('CF-1'), {
    stage: 'PRE_FLIGHT', at: 'x', section: 'BILLING',
  })
  assert.equal(T.isTraceLifecycleComplete(partial), false)
})

/* ═══ DEĞİŞMEZLİK ═════════════════════════════════════════════════════ */

test('TRC-4: deneme DONDURULMUS — sonradan degistirilemez', () => {
  const attempt = full('CF-1', 'A')
  assert.equal(Object.isFrozen(attempt), true)
  assert.equal(Object.isFrozen(attempt.stages), true)
  assert.throws(() => { attempt.traceId = 'CF-HACK' }, TypeError)
  assert.throws(() => { attempt.stages.push({}) }, TypeError)
})

test('TRC-5: asama eklemek ONCEKI denemeyi DEGISTIRMEZ', () => {
  const before = full('CF-1', 'A')
  const after = T.appendTraceStage(before, {
    stage: 'FINAL', at: 'y', section: 'FINAL_RESULT', data: { payload: 'Z' },
  })
  assert.equal(before.stages.length, 7, 'gecmis deneme BUYUMEMELI')
  assert.equal(after.stages.length, 8)
  // Config sonradan degisse bile gecmis karar AYNI kalir.
  assert.deepEqual(before.stages[0].data, { payload: 'A' })
})

/* ═══ KORELASYON YALITIMI ═════════════════════════════════════════════ */

test('TRC-6: Trace A ile Trace B KARISMAZ', () => {
  const a = full('CF-A', 'A')
  const b = full('CF-B', 'B')
  assert.equal(a.traceId, 'CF-A')
  assert.equal(b.traceId, 'CF-B')
  for (const entry of a.stages) assert.deepEqual(entry.data, { payload: 'A' })
  for (const entry of b.stages) assert.deepEqual(entry.data, { payload: 'B' })
  // Ayni nesneyi PAYLASMAZLAR.
  assert.notEqual(a.stages, b.stages)
  assert.notEqual(JSON.stringify(a), JSON.stringify(b))
})

test('TRC-7: tek denemede tum asamalar AYNI traceId altinda', () => {
  const attempt = full('CF-ONE', 'A')
  assert.equal(new Set([attempt.traceId]).size, 1)
  assert.ok(attempt.traceId.startsWith('CF-'))
})

/* ═══ SIR MASKELEME ═══════════════════════════════════════════════════ */

test('TRC-8: sirlar ize HIC girmez, maskeli hesap KORUNUR', () => {
  const attempt = T.appendTraceStage(open('CF-1'), {
    stage: 'ROUTING', at: 'x', section: 'CREDENTIAL_ROUTING',
    data: {
      sifre: 'COK_GIZLI', webPassword: 'WP1', apiKey: 'AK',
      maskedAccount: '49****56', credentialRole: 'PRIMARY_MARKETPLACE',
    },
  })
  const text = JSON.stringify(attempt)
  for (const secret of ['COK_GIZLI', 'WP1', 'AK']) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
  assert.equal(attempt.stages[0].data.maskedAccount, '49****56')
  assert.equal(attempt.stages[0].data.credentialRole, 'PRIMARY_MARKETPLACE')
})

/* ═══ SAKLAMA SINIRI ══════════════════════════════════════════════════ */

test('TRC-9: saklama 7 gun VEYA kiracı basina 200 iz', () => {
  assert.equal(T.TRACE_RETENTION_DAYS, 7)
  assert.equal(T.TRACE_RETENTION_MAX_PER_TENANT, 200)
  const many = Array.from({ length: 260 }, () => ({
    createdAt: new Date().toISOString(),
  }))
  assert.ok(T.applyTraceRetention(many).length <= 200, 'sayi siniri')
})

test('TRC-10: eski sema izleri GUNCEL gorunume karismaz', () => {
  const mixed = [
    { schemaVersion: 1, id: 'eski' }, { schemaVersion: 2, id: 'yeni' },
  ]
  const current = T.selectCurrentSchemaTraces(mixed)
  assert.deepEqual(current.map((t) => t.id), ['yeni'])
})

/* ═══ BEKLENEN vs TEL ═════════════════════════════════════════════════ */

test('TRC-11: sozlesmede WhoPays yoksa tel alani UYDURULMAZ', () => {
  const wire = T.describeWireWhoPays({ contractFields: ['KullaniciAdi', 'Sifre', 'Gonderi'] })
  assert.equal(wire.wireWhoPaysPresent, false)
  assert.equal(wire.wireWhoPaysReason, 'CONTRACT_HAS_NO_WHO_PAYS_FIELD')
})
