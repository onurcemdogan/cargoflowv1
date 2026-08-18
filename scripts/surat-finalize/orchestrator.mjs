// Sürat finalization orkestratörü.
//
// Sohbet bağlamı bittiğinde yeni oturum "neredeyiz" sorusunu REPO'DAN yanıtlar.
// Komutlar: status · continue · report
//
// `continue` YALNIZ gate çalıştırır. Kod düzeltmez, faz atlamaz, canlı
// taşıyıcı çağrısı yapmaz. Force/skip/reset komutu bilinçli olarak YOKTUR.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PHASE_TITLES, REPO_ROOT, advancePhase, isPhaseRunnable, loadState, saveState,
} from './state.mjs'
import { buildGates } from './gates.mjs'
import { runGates } from './runner.mjs'
import { REPORT_DIR, buildReport, writeReport } from './report.mjs'

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function describeRepo() {
  return { gitHead: git(['rev-parse', '--short', 'HEAD']),
    worktreeDirty: git(['status', '--short']).length > 0 }
}

function readLatestReport() {
  try {
    return JSON.parse(readFileSync(join(REPORT_DIR, 'latest-report.json'), 'utf8'))
  } catch {
    return null
  }
}

function printStatus(state) {
  const phase = state.currentPhase
  const report = readLatestReport()
  const runnable = phase !== 'COMPLETE' && isPhaseRunnable(state, phase)
  const status = phase === 'COMPLETE'
    ? 'COMPLETE'
    : report?.failedGate ? 'BLOCKED' : (runnable ? 'IN_PROGRESS' : 'LOCKED')
  console.log('SURAT_FINALIZATION')
  console.log(`CURRENT_PHASE=${phase}`)
  console.log(`PHASE_TITLE=${PHASE_TITLES[phase] ?? phase}`)
  console.log(`PHASE_STATUS=${status}`)
  console.log(`FAILED_GATE=${report?.failedGate ?? 'none'}`)
  console.log('')
  console.log('NEXT_ACTION=')
  console.log(report?.nextAction
    ?? 'Gate\'leri calistir: node scripts/surat-finalize/orchestrator.mjs continue')
  console.log('')
  console.log(`LIVE_CREATE_ALLOWED=${state.liveCreateAllowed === true}`)
  if (phase === 'COMPLETE') {
    console.log('READY_FOR_SINGLE_LIVE_CREATE=YES')
    console.log('# Gercek canlı create yine de INSAN karariyla yapilir.')
  }
}

async function commandContinue(state) {
  const phase = state.currentPhase
  if (phase === 'COMPLETE') {
    printStatus(state)
    return 0
  }
  if (!isPhaseRunnable(state, phase)) {
    console.error(`PHASE_LOCKED=${phase} — onceki fazlar PASS degil.`)
    return 1
  }
  const gates = buildGates(phase, undefined, state)
  const started = Date.now()
  const results = await runGates(gates, { now: () => Date.now() })
  const repo = describeRepo()
  const allPassed = results.every(
    (gate) => !gate.required || gate.status === 'PASS',
  )
  if (allPassed) {
    advancePhase(state, phase, { at: new Date(started).toISOString() })
  }
  const report = buildReport({
    state, gates: results, ...repo, timestamp: new Date(started).toISOString(),
  })
  writeReport(report)
  saveState(state)
  printStatus(state)
  return report.failedGate ? 1 : 0
}

function commandReport() {
  const report = readLatestReport()
  if (!report) {
    console.error('RAPOR_YOK — once continue calistirin.')
    return 1
  }
  console.log(JSON.stringify(report, null, 2))
  return 0
}

const command = process.argv[2] ?? 'status'
const state = loadState()
let exitCode = 0
if (command === 'status') printStatus(state)
else if (command === 'continue') exitCode = await commandContinue(state)
else if (command === 'report') exitCode = commandReport()
else {
  console.error(`BILINMEYEN_KOMUT=${command} · gecerli: status|continue|report`)
  exitCode = 1
}
process.exitCode = exitCode
