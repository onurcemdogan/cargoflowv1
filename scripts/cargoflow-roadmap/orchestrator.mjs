// CargoFlow yol haritası orkestratörü.
//
// Komutlar: status · continue · report
// `continue` YALNIZ gate çalıştırır: kod yazmaz, faz atlamaz, canlı taşıyıcı
// çağrısı yapmaz. force/skip/reset komutu bilinçli olarak YOKTUR.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PHASE_ORDER, REPO_ROOT, advancePhase, isPhaseRunnable, loadState,
  recordGateResult, saveState,
} from './state.mjs'
import { buildGates } from './gates.mjs'
import { runGates } from './runner.mjs'
import { REPORT_DIR, buildReport, writeReport } from './report.mjs'

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch { return '' }
}

const readLatest = () => {
  try {
    return JSON.parse(readFileSync(join(REPORT_DIR, 'latest-report.json'), 'utf8'))
  } catch { return null }
}

function printStatus(state) {
  const phase = state.currentPhase
  const report = readLatest()
  console.log('CARGOFLOW_ROADMAP')
  console.log(`CURRENT_PHASE=${phase}`)
  console.log(`PHASE_STATUS=${state.phases[phase]?.status ?? phase}`)
  console.log(`BRANCH=${state.phases[phase]?.branch ?? git(['branch', '--show-current'])}`)
  console.log(`FAILED_GATE=${report?.failedGate ?? 'none'}`)
  console.log('')
  for (const name of PHASE_ORDER) {
    const entry = state.phases[name]
    console.log(`  ${name.padEnd(26)} ${entry.status.padEnd(28)} ${entry.branch ?? '-'}`)
  }
  console.log('')
  console.log(`LIVE_CREATE_ALLOWED=${state.liveCreateAllowed === true}`)
  console.log('NEXT_COMMAND=node scripts/cargoflow-roadmap/orchestrator.mjs continue')
}

async function commandContinue(state) {
  const phase = state.currentPhase
  if (phase === 'COMPLETE') { printStatus(state); return 0 }
  if (!isPhaseRunnable(state, phase)) {
    console.error(`PHASE_LOCKED=${phase}`)
    return 1
  }
  const gates = buildGates(phase)
  const started = Date.now()
  const results = await runGates(gates, { now: () => Date.now() })
  const branch = git(['branch', '--show-current'])
  const commit = git(['rev-parse', '--short', 'HEAD'])
  const timestamp = new Date(started).toISOString()
  for (const gate of results) {
    recordGateResult(state, {
      phase, gate: gate.id, status: gate.status, timestamp, commit, branch,
      evidence: gate.evidence ?? null,
    })
  }
  const allPassed = results.every((g) => !g.required || g.status === 'PASS')
  if (allPassed) advancePhase(state, phase, { at: timestamp, commit, branch })
  else state.phases[phase].branch = branch
  const report = buildReport({
    state, gates: results, gitHead: commit,
    worktreeDirty: git(['status', '--short']).length > 0, timestamp,
  })
  writeReport(report)
  saveState(state)
  printStatus(state)
  return report.failedGate ? 1 : 0
}

const command = process.argv[2] ?? 'status'
const state = loadState()
let code = 0
if (command === 'status') printStatus(state)
else if (command === 'continue') code = await commandContinue(state)
else if (command === 'report') {
  const report = readLatest()
  if (!report) { console.error('RAPOR_YOK'); code = 1 }
  else console.log(JSON.stringify(report, null, 2))
} else { console.error(`BILINMEYEN_KOMUT=${command}`); code = 1 }
process.exitCode = code
