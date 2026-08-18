import assert from 'node:assert/strict'
import test from 'node:test'

// Orkestratörün KENDİ testleri — ağ, DB, taşıyıcı çağrısı YOK.

const STATE = await import('./state.mjs')
const GATES = await import('./gates.mjs')
const RUNNER = await import('./runner.mjs')
const REPORT = await import('./report.mjs')
const REDACT = await import('./redact.mjs')

const freshState = () => ({
  schemaVersion: 1,
  workflow: 'surat-finalization',
  currentPhase: 'A',
  liveCreateAllowed: false,
  phases: {
    A: { status: 'in_progress', completedAt: null, commit: null },
    B: { status: 'locked', completedAt: null, commit: null },
    C: { status: 'locked', completedAt: null, commit: null },
    D: { status: 'locked', completedAt: null, commit: null },
    E: { status: 'locked', completedAt: null, commit: null },
  },
})

/* ═══ DURUM YÜKLEME ════════════════════════════════════════════════════ */

test('ORCH-1: repodaki STATE.json yuklenir ve TUTARLI', () => {
  const state = STATE.loadState()
  assert.equal(state.schemaVersion, 1)
  // Faz ilerledikce degisen bir deger SABIT beklenmez; degismezler test edilir.
  assert.ok(
    [...STATE.PHASE_ORDER, 'COMPLETE'].includes(state.currentPhase),
    state.currentPhase,
  )
  // Canlı create HER durumda insan karari olarak kapali kalir.
  assert.equal(state.liveCreateAllowed, false)
  // Gecmis fazlar passed olmadan siradaki faz acilamaz.
  const index = STATE.PHASE_ORDER.indexOf(state.currentPhase)
  if (index > 0) {
    for (const earlier of STATE.PHASE_ORDER.slice(0, index)) {
      assert.equal(state.phases[earlier].status, 'passed', earlier)
    }
  }
})

/* ═══ FAZ KİLİDİ ═══════════════════════════════════════════════════════ */

test('ORCH-2: onceki faz PASS degilse sonraki faz KILITLI', () => {
  const state = freshState()
  assert.equal(STATE.isPhaseRunnable(state, 'A'), true)
  for (const phase of ['B', 'C', 'D', 'E']) {
    assert.equal(STATE.isPhaseRunnable(state, phase), false, phase)
  }
})

test('ORCH-3: faz ATLANAMAZ — A gecmeden C acilmaz', () => {
  const state = freshState()
  STATE.advancePhase(state, 'A')
  assert.equal(state.currentPhase, 'B')
  assert.equal(STATE.isPhaseRunnable(state, 'C'), false)
  STATE.advancePhase(state, 'B')
  assert.equal(STATE.isPhaseRunnable(state, 'C'), true)
})

test('ORCH-4: COMPLETE canlı create IZNI VERMEZ', () => {
  const state = freshState()
  for (const phase of STATE.PHASE_ORDER) STATE.advancePhase(state, phase)
  assert.equal(state.currentPhase, 'COMPLETE')
  assert.equal(state.liveCreateAllowed, false)
})

/* ═══ GATE ZİNCİRİ ═════════════════════════════════════════════════════ */

test('ORCH-5: dusen zorunlu gate sonrakileri NOT_RUN birakir', async () => {
  const gates = [
    { id: 'G1', required: true, safe: true, command: null, status: 'BLOCKED',
      evidence: 'x' },
    { id: 'G2', required: true, safe: true, command: ['node', '-e', 'process.exit(0)'],
      status: 'PENDING' },
  ]
  const results = await RUNNER.runGates(gates)
  assert.equal(results[0].status, 'BLOCKED')
  assert.equal(results[1].status, 'NOT_RUN', 'zincir DURMALI')
})

test('ORCH-6: guvenli olmayan gate CALISTIRILMAZ', async () => {
  const result = await RUNNER.runGate({
    id: 'UNSAFE', required: true, safe: false,
    command: ['node', '-e', 'process.exit(0)'], status: 'PENDING',
  })
  assert.equal(result.status, 'BLOCKED')
  assert.match(result.boundedOutput, /UNSAFE_GATE_REQUIRES_MANUAL_REVIEW/)
})

test('ORCH-7: komutsuz gate uydurma komut URETMEZ', async () => {
  const result = await RUNNER.runGate({
    id: 'NOCMD', required: true, safe: true, command: null,
    status: 'PENDING', evidence: 'PHASE_NOT_IMPLEMENTED_YET',
  })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.exitCode, null)
})

test('ORCH-8: E fazi hedefsiz FAIL degil BLOCKED birakir', () => {
  // Faz E artik GERCEK komutlari calistirir; hedef yoksa uydurma komut
  // uretmek yerine guvenli sekilde bloklanir.
  const [gate] = GATES.buildGates('E', undefined, freshState())
  assert.equal(gate.status, 'BLOCKED')
  assert.equal(gate.command, null)
  assert.match(gate.evidence, /PRODUCTION_TARGET_MISSING/)
})

test('ORCH-9: gate komutlari package.json ile dogrulanir, TAHMIN EDILMEZ', () => {
  const gates = GATES.buildPhaseAGates({ 'test:surat': 'x' })
  const missing = gates.find((gate) => gate.id === 'A10_BUILD')
  // build script'i sahte pakette YOK → uydurulmaz, BLOCKED olur.
  assert.equal(missing.status, 'BLOCKED')
  assert.match(missing.evidence, /SCRIPT_NOT_FOUND/)
})

/* ═══ MASKELEME ════════════════════════════════════════════════════════ */

test('ORCH-10: sirlar raporda MASKELENIR, maskeli hesap KORUNUR', () => {
  const masked = REDACT.redactValue({
    sifre: 'GERCEK_SIFRE', apiKey: 'AK-1', maskedAccount: '49****56',
    nested: { password: 'P1', role: 'PRIMARY_MARKETPLACE' },
  })
  const text = JSON.stringify(masked)
  for (const secret of ['GERCEK_SIFRE', 'AK-1', 'P1']) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
  assert.equal(masked.maskedAccount, '49****56')
  assert.equal(masked.nested.role, 'PRIMARY_MARKETPLACE')
})

test('ORCH-11: serbest metindeki sifre=... maskelenir', () => {
  const text = REDACT.redactText('kullaniciAdi=CARI1 sifre=COK_GIZLI son')
  assert.equal(text.includes('COK_GIZLI'), false)
  assert.equal(text.includes('CARI1'), true)
})

test('ORCH-12: cikti SINIRLANIR', () => {
  const bounded = RUNNER.boundOutput('x'.repeat(50_000), 1000)
  assert.ok(bounded.length < 1200)
  assert.match(bounded, /bayt atlandi/)
})

/* ═══ RAPOR ════════════════════════════════════════════════════════════ */

test('ORCH-13: rapor dusen gate ve sonraki adimi tasir, sir tasimaz', () => {
  const report = REPORT.buildReport({
    state: freshState(),
    gates: [
      { id: 'A1', status: 'PASS', durationMs: 5, exitCode: 0, required: true },
      { id: 'A2', status: 'FAIL', durationMs: 7, exitCode: 1, required: true,
        boundedOutput: 'sifre=GIZLI' },
    ],
    gitHead: 'abc1234', worktreeDirty: true, timestamp: '2026-01-01T00:00:00Z',
  })
  assert.equal(report.failedGate, 'A2')
  assert.match(report.nextAction, /A2/)
  assert.equal(report.liveCreateAllowed, false)
  assert.equal(JSON.stringify(report).includes('GIZLI'), false)
  // Guvenlik degismezleri raporda SABIT.
  assert.equal(report.safety.liveCreate, 0)
  assert.equal(report.safety.realCarrierNetwork, 0)
})

test('ORCH-14: markdown rapor uretilir', () => {
  const markdown = REPORT.renderMarkdown({
    timestamp: 't', gitHead: 'h', worktreeDirty: false, currentPhase: 'A',
    liveCreateAllowed: false, failedGate: null, nextAction: 'devam',
    gates: [{ id: 'A1', status: 'PASS', durationMs: 1, exitCode: 0 }],
  })
  assert.match(markdown, /Sürat finalization raporu/)
  assert.match(markdown, /A1 \| PASS/)
})

/* ═══ FAZ E — GERÇEK ÜRETİM KONTROLLERİ ═══════════════════════════════ */

const STATE_WITH_TARGET = {
  ...freshState(),
  productionTarget: { tenantName: 'MonalisaToka', packageId: '7270035942963454' },
}

const gateById = (gates, id) => gates.find((gate) => gate.id === id)

test('ORCH-15: E hedefi yoksa faz GUVENLI sekilde BLOKLANIR', () => {
  const [gate] = GATES.buildGates('E', undefined, freshState())
  assert.equal(gate.id, 'E0_PRODUCTION_TARGET')
  assert.equal(gate.status, 'BLOCKED')
  assert.match(gate.evidence, /PRODUCTION_TARGET_MISSING/)
})

test('ORCH-16: E1 GERCEK canary komutunu hedefle calistirir', () => {
  const gates = GATES.buildGates('E', undefined, STATE_WITH_TARGET)
  const e1 = gateById(gates, 'E1_PRODUCTION_CONFIG_READ_ONLY')
  assert.deepEqual(e1.command, [
    'npm', 'run', 'surat:canary:precheck', '--', '--name', 'MonalisaToka',
  ])
  // Artik sabit BLOCKED DEGIL.
  assert.equal(e1.status, 'PENDING')
})

test('ORCH-17: E2 GERCEK NETWORK=0 kuru kosusunu calistirir', () => {
  const e2 = gateById(
    GATES.buildGates('E', undefined, STATE_WITH_TARGET), 'E2_REAL_ORDER_DRY_RUN',
  )
  assert.deepEqual(e2.command, [
    'npm', 'run', 'surat:billing:inspect', '--', '--name', 'MonalisaToka',
    '--package', '7270035942963454', '--create-context',
  ])
})

/* Gerçek üretim çıktılarının biçimiyle kanıt doğrulaması. */
const CANARY_READY = [
  'DATA_SOURCE                  : POSTGRES',
  'AUTHORITATIVE_SOURCE_RESOLVED: YES',
  'ORGANIZATION FOUND : YES',
  'ACTIVE SURAT INTEGRATION      : YES',
  'CANONICAL MODE SELECTED       : YES',
  'CANARY PRECHECK: READY (config tarafı)',
].join('\n')

const DRY_RUN_OK = [
  '  REAL_RUNTIME_BILLING_PARTY    TRENDYOL_PAYS',
  '  EXPECTED_SURAT_WHO_PAYS       3',
  '  CREDENTIAL_ROLE               PRIMARY_MARKETPLACE',
  '  CREDENTIAL_RESOLVED           YES',
  '  REAL_RUNTIME_CREDENTIAL_CONFIG_PRESENT  YES',
  '  EXPECTED_BILLING_PARTY_WIRED_TO_REAL_CREATE  YES',
  'NETWORK_CALLS 0 · DB_WRITES 0 · CREATE_CALLS 0 · PRINT_CALLS 0',
].join('\n')

/** Kanıt doğrulamasını komut çalıştırmadan sınar. */
const checkEvidence = (gate, text) => {
  const missing = (gate.requireOutput ?? []).filter(
    (pattern) => !new RegExp(pattern).test(text),
  )
  const forbidden = (gate.forbidOutput ?? []).filter(
    (pattern) => new RegExp(pattern).test(text),
  )
  return missing.length === 0 && forbidden.length === 0
}

test('ORCH-18: E1 gercek READY ciktisiyla GECER', () => {
  const e1 = gateById(
    GATES.buildGates('E', undefined, STATE_WITH_TARGET),
    'E1_PRODUCTION_CONFIG_READ_ONLY',
  )
  assert.equal(checkEvidence(e1, CANARY_READY), true)
})

test('ORCH-19: E1 kaynak cozulemezse GECMEZ', () => {
  const e1 = gateById(
    GATES.buildGates('E', undefined, STATE_WITH_TARGET),
    'E1_PRODUCTION_CONFIG_READ_ONLY',
  )
  const unresolved = CANARY_READY
    .replace('AUTHORITATIVE_SOURCE_RESOLVED: YES', 'AUTHORITATIVE_SOURCE_RESOLVED: NO')
    .replace('CANARY PRECHECK: READY (config tarafı)', 'CANARY PRECHECK: BLOCKED → x')
  assert.equal(checkEvidence(e1, unresolved), false)
})

test('ORCH-20: E2 gercek kuru kosu ciktisiyla GECER', () => {
  const e2 = gateById(
    GATES.buildGates('E', undefined, STATE_WITH_TARGET), 'E2_REAL_ORDER_DRY_RUN',
  )
  assert.equal(checkEvidence(e2, DRY_RUN_OK), true)
})

test('ORCH-21: E2 kimlik cozulmediyse GECMEZ', () => {
  const e2 = gateById(
    GATES.buildGates('E', undefined, STATE_WITH_TARGET), 'E2_REAL_ORDER_DRY_RUN',
  )
  assert.equal(
    checkEvidence(e2, DRY_RUN_OK.replace(
      'CREDENTIAL_RESOLVED           YES', 'CREDENTIAL_RESOLVED           NO',
    )),
    false,
  )
})

test('ORCH-22: E2 fatura tarafi yanlissa GECMEZ', () => {
  const e2 = gateById(
    GATES.buildGates('E', undefined, STATE_WITH_TARGET), 'E2_REAL_ORDER_DRY_RUN',
  )
  // Kimlik sinifi fatura tarafi yerine gecemez.
  assert.equal(
    checkEvidence(e2, DRY_RUN_OK.replace('TRENDYOL_PAYS', 'PRIMARY')), false,
  )
  assert.equal(
    checkEvidence(e2, DRY_RUN_OK.replace(
      'EXPECTED_BILLING_PARTY_WIRED_TO_REAL_CREATE  YES',
      'EXPECTED_BILLING_PARTY_WIRED_TO_REAL_CREATE  NO',
    )),
    false,
  )
})

test('ORCH-23: E2 ag/create/yazma sayaci 0 DEGILSE GECMEZ', () => {
  const e2 = gateById(
    GATES.buildGates('E', undefined, STATE_WITH_TARGET), 'E2_REAL_ORDER_DRY_RUN',
  )
  assert.equal(
    checkEvidence(e2, DRY_RUN_OK.replace(
      'NETWORK_CALLS 0 · DB_WRITES 0 · CREATE_CALLS 0 · PRINT_CALLS 0',
      'NETWORK_CALLS 1 · DB_WRITES 0 · CREATE_CALLS 1 · PRINT_CALLS 0',
    )),
    false,
  )
})

test('ORCH-24: cikis kodu 0 TEK BASINA PASS URETMEZ', async () => {
  const result = await RUNNER.runGate({
    id: 'EVIDENCE', required: true, safe: true, status: 'PENDING',
    command: ['node', '-e', 'process.exit(0)'],
    requireOutput: ['BEKLENEN_KANIT'],
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.status, 'FAIL', 'kanit yoksa PASS OLMAMALI')
  assert.deepEqual(result.missingEvidence, ['BEKLENEN_KANIT'])
})
