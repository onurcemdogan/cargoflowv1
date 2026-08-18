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

test('ORCH-8: E fazi production erisimi yoksa FAIL degil BLOCKED_EXTERNAL', () => {
  const [gate] = GATES.buildGates('E')
  assert.equal(gate.status, 'BLOCKED')
  assert.match(gate.evidence, /BLOCKED_EXTERNAL/)
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
