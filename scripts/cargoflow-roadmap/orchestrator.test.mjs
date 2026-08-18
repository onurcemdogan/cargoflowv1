import assert from 'node:assert/strict'
import test from 'node:test'

const STATE = await import('./state.mjs')
const GATES = await import('./gates.mjs')
const RUNNER = await import('./runner.mjs')

const fresh = () => ({
  schemaVersion: 1, workflow: 'cargoflow-roadmap',
  currentPhase: 'S1_SURAT_HARDENING', liveCreateAllowed: false,
  phases: Object.fromEntries(STATE.PHASE_ORDER.map((phase, index) => [
    phase,
    { status: index === 0 ? 'in_progress' : 'locked', completedAt: null,
      commit: null, branch: null },
  ])),
  history: [],
})

test('RM-1: repodaki STATE yedi fazi TUTARLI tasir', () => {
  const state = STATE.loadState()
  assert.equal(STATE.PHASE_ORDER.length, 7)
  for (const phase of STATE.PHASE_ORDER) {
    assert.ok(state.phases[phase], phase)
    assert.ok(STATE.PHASE_STATUSES.includes(state.phases[phase].status))
  }
  assert.equal(state.liveCreateAllowed, false)
})

test('RM-2: onceki faz gecmeden sonraki faz KILITLI', () => {
  const state = fresh()
  assert.equal(STATE.isPhaseRunnable(state, 'S1_SURAT_HARDENING'), true)
  for (const phase of STATE.PHASE_ORDER.slice(1)) {
    assert.equal(STATE.isPhaseRunnable(state, phase), false, phase)
  }
})

test('RM-3: faz ATLANAMAZ', () => {
  const state = fresh()
  STATE.advancePhase(state, 'S1_SURAT_HARDENING')
  assert.equal(state.currentPhase, 'P1_B2_PERFORMANCE')
  assert.equal(STATE.isPhaseRunnable(state, 'P3_B4_BARCODE_WORKER'), false)
})

test('RM-4: dis sozlesme engeli YALNIZ P4/P5/P6 icin ilerletir', () => {
  const state = fresh()
  // Uygulanabilir bir fazi "dis sozlesme yok" diyerek atlamak YASAK.
  state.phases.S1_SURAT_HARDENING.status = 'blocked_external_contract'
  assert.equal(STATE.isPhaseRunnable(state, 'P1_B2_PERFORMANCE'), false)
  // P4 gercekten dis sozlesmeye bagimlidir; P5 acilabilir.
  for (const phase of STATE.PHASE_ORDER.slice(0, 4)) {
    state.phases[phase].status = 'passed'
  }
  state.phases.P4_HEPSIBURADA_N11.status = 'blocked_external_contract'
  assert.equal(STATE.isPhaseRunnable(state, 'P5_ARAS'), true)
})

test('RM-5: TUM fazlar bitse bile canli create KAPALI', () => {
  const state = fresh()
  for (const phase of STATE.PHASE_ORDER) STATE.advancePhase(state, phase)
  assert.equal(state.currentPhase, 'COMPLETE')
  assert.equal(state.liveCreateAllowed, false)
})

test('RM-6: uygulanmamis is SAHTE PASS uretmez', () => {
  // Belirli bir gate adina baglanmaz; DEGISMEZ test edilir: komutu olmayan
  // her zorunlu gate BLOCKED + NOT_IMPLEMENTED tasimali.
  const pending = GATES.buildGates('P1_B2_PERFORMANCE')
    .filter((gate) => gate.command === null)
  assert.ok(pending.length > 0, 'uygulanmamis is BLOCKED kalmali')
  for (const gate of pending) {
    assert.equal(gate.status, 'BLOCKED', gate.id)
    assert.match(gate.evidence, /NOT_IMPLEMENTED|SCRIPT_NOT_FOUND/, gate.id)
  }
})

test('RM-6b: uygulanan is GERCEK komut calistirir', () => {
  const ui = GATES.buildGates('S1_SURAT_HARDENING')
    .find((gate) => gate.id === 'S1_LIVE_DEBUG_UI')
  assert.ok(ui.command, 'Canli Debug artik gercek testle dogrulanir')
  assert.equal(ui.status, 'PENDING')
  // Cikis kodu tek basina yetmez.
  assert.ok(ui.requireOutput.length > 0)
})

test('RM-7: gate komutlari package.json ile dogrulanir', () => {
  const gates = GATES.buildGates('P1_B2_PERFORMANCE', { 'test:surat': 'x' })
  const build = gates.find((gate) => gate.id === 'P1_B2_PERFORMANCE_BUILD')
  assert.equal(build.status, 'BLOCKED')
  assert.match(build.evidence, /SCRIPT_NOT_FOUND/)
})

test('RM-8: gate sonuclari kalici denetim kaydina yazilir', () => {
  const state = fresh()
  STATE.recordGateResult(state, {
    phase: 'S1_SURAT_HARDENING', gate: 'S1_LINT', status: 'PASS',
    timestamp: '2026-08-18T00:00:00.000Z', commit: 'abc1234', branch: 'b',
  })
  assert.equal(state.history.length, 1)
  assert.equal(state.history[0].gate, 'S1_LINT')
  // Sir ALANI YOK.
  assert.deepEqual(
    Object.keys(state.history[0]).sort(),
    ['branch', 'commit', 'evidence', 'gate', 'phase', 'status', 'timestamp'],
  )
})

test('RM-9: cikis kodu 0 tek basina PASS URETMEZ', async () => {
  const result = await RUNNER.runGate({
    id: 'E', required: true, safe: true, status: 'PENDING',
    command: ['node', '-e', 'process.exit(0)'],
    requireOutput: ['BEKLENEN'],
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.status, 'FAIL')
})
