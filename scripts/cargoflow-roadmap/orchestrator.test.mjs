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
  // her zorunlu gate BLOCKED + NOT_IMPLEMENTED tasimali. Ornek faz, HENUZ
  // uygulanmamis olan siradaki fazdir (P2 baglandi: bkz. RM-6c).
  const pending = GATES.buildGates('P6_SURAT_NON_MARKETPLACE')
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

test('RM-6c: P2 artik GERCEK testlere baglidir', () => {
  // Artimli imlec BAGLANDI (docs/cargoflow-roadmap/P2_AUDIT.md): faz artik
  // NOT_IMPLEMENTED ile degil, olculen testlerle kapanir.
  const gates = GATES.buildGates('P2_B3_INCREMENTAL_SYNC')
  const notImplemented = gates.filter(
    (gate) => gate.command === null && /NOT_IMPLEMENTED/.test(gate.evidence ?? ''),
  )
  assert.equal(notImplemented.length, 0, 'P2 hala sahte BLOCKED tasiyor')
  // Imlecin GERCEKTEN baglandigini olcen gate zorunludur.
  const wired = gates.find((gate) => gate.id === 'P2_CURSOR_WIRED')
  assert.ok(wired?.command, 'imlec baglama gate komutu YOK')
  assert.equal(wired.required, true)
})

test('RM-7: gate komutlari package.json ile dogrulanir', () => {
  // Script yoksa komut UYDURULMAZ; hem baglanmis hem bekleyen fazda gecerli.
  for (const [phase, id] of [
    ['P2_B3_INCREMENTAL_SYNC', 'P2_BUILD'],
    ['P6_SURAT_NON_MARKETPLACE', 'P6_SURAT_NON_MARKETPLACE_BUILD'],
  ]) {
    const build = GATES.buildGates(phase, { 'test:surat': 'x' })
      .find((gate) => gate.id === id)
    assert.ok(build, `${id} bulunamadi`)
    assert.equal(build.status, 'BLOCKED', id)
    assert.match(build.evidence, /SCRIPT_NOT_FOUND/, id)
  }
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

test('RM-10: dusen testin hata metni RAPORDAN ATILMAZ', () => {
  // OLCULEN KUSUR (P3): 1.2 MB suite ciktisi bas+son kirpilinca ORTA atiliyor
  // ve dosya seviyesindeki hata metni tam olarak orada duruyordu.
  const noise = Array.from({ length: 4000 }, (_, i) => `✔ gecen test ${i}`)
  const needle = 'HATA: modul yuklenemedi — SEBEP BURADA'
  const text = [...noise.slice(0, 2000), needle, ...noise.slice(2000)].join('\n')
  assert.ok(text.length > RUNNER.OUTPUT_TAIL_BYTES, 'senaryo siniri asmali')

  const bounded = RUNNER.boundOutput(text)
  assert.ok(bounded.includes(needle), 'hata metni kirpilip ATILDI')
  assert.ok(bounded.length <= RUNNER.OUTPUT_TAIL_BYTES + 200, 'sinir asildi')
  assert.match(bounded, /gecen alt test satiri atlandi/)
})

test('RM-10b: sinir altindaki cikti AYNEN korunur', () => {
  const text = '✔ tek gecen test\nbitti'
  assert.equal(RUNNER.boundOutput(text), text)
})

test('RM-10c: gurultu atildiktan sonra hala uzunsa kirpma YAPILIR', () => {
  // Hepsi hata satiri: atilacak gurultu yok, son care kirpma devreye girer.
  const text = Array.from({ length: 20_000 }, (_, i) => `hata satiri ${i}`).join('\n')
  const bounded = RUNNER.boundOutput(text)
  assert.ok(bounded.length <= RUNNER.OUTPUT_TAIL_BYTES + 200)
  assert.match(bounded, /bayt atlandi/)
})

/* ═══ DIŞ SÖZLEŞME ENGELİ — DAR ve KORUMALI ═════════════════════════ */

test('RM-11: uygulanabilir faz "sozlesme yok" diyerek ATLANAMAZ', () => {
  // RM-4'un kilidi komut seviyesinde de gecerli olmali: S1/P1/P2/P3 dis
  // sozlesmeye bagli DEGILDIR ve bu kapidan gecemez.
  for (const phase of [
    'S1_SURAT_HARDENING', 'P1_B2_PERFORMANCE',
    'P2_B3_INCREMENTAL_SYNC', 'P3_B4_BARCODE_WORKER',
  ]) {
    const state = fresh()
    state.currentPhase = phase
    state.phases[phase].status = 'in_progress'
    const result = STATE.blockExternalContract(state, phase, 'gerekce')
    assert.equal(result.ok, false, phase)
    assert.equal(result.reason, 'PHASE_NOT_CONTRACT_BLOCKABLE', phase)
    assert.equal(state.phases[phase].status, 'in_progress', `${phase} DEGISTI`)
  }
})

test('RM-12: gerekcesiz engel kaydi REDDEDILIR', () => {
  const state = fresh()
  for (const phase of STATE.PHASE_ORDER.slice(0, 4)) {
    state.phases[phase].status = 'passed'
  }
  state.currentPhase = 'P4_HEPSIBURADA_N11'
  state.phases.P4_HEPSIBURADA_N11.status = 'in_progress'
  for (const detail of ['', '   ', null, undefined]) {
    const result = STATE.blockExternalContract(state, 'P4_HEPSIBURADA_N11', detail)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'BLOCKER_DETAIL_REQUIRED')
  }
  assert.equal(state.phases.P4_HEPSIBURADA_N11.status, 'in_progress')
})

test('RM-13: ILERI uzanma yok — yalniz SIRADAKI faz bloklanir', () => {
  const state = fresh()
  for (const phase of STATE.PHASE_ORDER.slice(0, 4)) {
    state.phases[phase].status = 'passed'
  }
  state.currentPhase = 'P4_HEPSIBURADA_N11'
  // P5 sirada DEGIL; simdiden bloklanamaz.
  const result = STATE.blockExternalContract(state, 'P5_ARAS', 'gerekce')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'PHASE_NOT_CURRENT')
  assert.equal(state.phases.P5_ARAS.status, 'locked')
})

test('RM-14: gecmis faz GERI ALINAMAZ', () => {
  const state = fresh()
  for (const phase of STATE.PHASE_ORDER.slice(0, 5)) {
    state.phases[phase].status = 'passed'
  }
  state.currentPhase = 'P4_HEPSIBURADA_N11'
  const result = STATE.blockExternalContract(state, 'P4_HEPSIBURADA_N11', 'x')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'PHASE_ALREADY_PASSED')
  assert.equal(state.phases.P4_HEPSIBURADA_N11.status, 'passed')
})

test('RM-15: gecerli engel kaydi SIRADAKI fazi acar ve gerekceyi TUTAR', () => {
  const state = fresh()
  for (const phase of STATE.PHASE_ORDER.slice(0, 4)) {
    state.phases[phase].status = 'passed'
  }
  state.currentPhase = 'P4_HEPSIBURADA_N11'
  state.phases.P4_HEPSIBURADA_N11.status = 'in_progress'
  const result = STATE.blockExternalContract(
    state, 'P4_HEPSIBURADA_N11', 'Hepsiburada/N11 sozlesmesi repoda YOK',
  )
  assert.equal(result.ok, true)
  assert.equal(state.phases.P4_HEPSIBURADA_N11.status, 'blocked_external_contract')
  assert.match(state.phases.P4_HEPSIBURADA_N11.blockerDetail, /sozlesmesi repoda YOK/)
  // CONTRACT: dis sozlesme engeli SONRAKI fazi acar.
  assert.equal(state.currentPhase, 'P5_ARAS')
  assert.equal(state.phases.P5_ARAS.status, 'in_progress')
  // Canli create HER durumda kapali kalir.
  assert.equal(state.liveCreateAllowed, false)
})

/* ═══ KANITLA GERİ AÇMA — block-external kadar DAR ═══════════════════ */

const blockedAt = (phase) => {
  const state = fresh()
  for (const earlier of STATE.PHASE_ORDER.slice(
    0, STATE.PHASE_ORDER.indexOf(phase),
  )) state.phases[earlier].status = 'passed'
  state.currentPhase = phase
  state.phases[phase].status = 'blocked_external_contract'
  state.phases[phase].blockerDetail = 'sozlesme YOK'
  return state
}

test('RM-16: PASSED faz kanit gerekcesiyle GERI ACILAMAZ', () => {
  const state = fresh()
  state.phases.P2_B3_INCREMENTAL_SYNC.status = 'passed'
  const result = STATE.reopenExternalContract(
    state, 'P2_B3_INCREMENTAL_SYNC', 'resmi dokuman',
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'PHASE_NOT_CONTRACT_BLOCKED')
  assert.equal(state.phases.P2_B3_INCREMENTAL_SYNC.status, 'passed')
})

test('RM-17: LOCKED faz one CEKILEMEZ', () => {
  const state = fresh()
  const result = STATE.reopenExternalContract(state, 'P5_ARAS', 'resmi dokuman')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'PHASE_NOT_CONTRACT_BLOCKED')
  assert.equal(state.phases.P5_ARAS.status, 'locked')
})

test('RM-18: kanit kaynagi YAZILMADAN geri acilmaz', () => {
  const state = blockedAt('P4_HEPSIBURADA_N11')
  for (const evidence of ['', '   ', null, undefined]) {
    const result = STATE.reopenExternalContract(
      state, 'P4_HEPSIBURADA_N11', evidence,
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'CONTRACT_EVIDENCE_REQUIRED')
  }
  assert.equal(
    state.phases.P4_HEPSIBURADA_N11.status, 'blocked_external_contract',
  )
})

test('RM-19: gecerli kanit fazi acar ve ENGEL GECMISINI korur', () => {
  const state = blockedAt('P4_HEPSIBURADA_N11')
  const result = STATE.reopenExternalContract(
    state, 'P4_HEPSIBURADA_N11', 'Hepsiburada Developer Portal + n11 destek',
  )
  assert.equal(result.ok, true)
  const entry = state.phases.P4_HEPSIBURADA_N11
  assert.equal(entry.status, 'in_progress')
  assert.equal(state.currentPhase, 'P4_HEPSIBURADA_N11')
  // Neden bloklandigi SILINMEZ; neyle acildigi da yazilir.
  assert.equal(entry.previousBlockerDetail, 'sozlesme YOK')
  assert.match(entry.contractEvidence, /Developer Portal/)
  assert.equal(entry.blockerDetail, undefined)
  // Canli create HER durumda kapali kalir.
  assert.equal(state.liveCreateAllowed, false)
})
