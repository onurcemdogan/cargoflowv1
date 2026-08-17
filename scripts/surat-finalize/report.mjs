// Rapor üretimi — .var/ altına yazar, sır taşımaz.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './state.mjs'
import { redactValue } from './redact.mjs'

export const REPORT_DIR = join(REPO_ROOT, '.var', 'surat-finalization')

/** Orkestratörün ASLA yapmadığı işler — raporda sabit olarak taşınır. */
export const SAFETY_INVARIANTS = {
  realCarrierNetwork: 0,
  liveCreate: 0,
  dbWrites: 0,
  print: 0,
  historicalMutation: 0,
}

export function buildReport({ state, gates, gitHead, worktreeDirty, timestamp }) {
  const failed = gates.find((gate) => gate.required && gate.status === 'FAIL')
    ?? gates.find((gate) => gate.required && gate.status === 'BLOCKED')
  return redactValue({
    timestamp,
    gitHead,
    worktreeDirty,
    currentPhase: state.currentPhase,
    liveCreateAllowed: false,
    gates: gates.map((gate) => ({
      id: gate.id,
      status: gate.status,
      durationMs: gate.durationMs ?? 0,
      exitCode: gate.exitCode ?? null,
      safeCommand: gate.safeCommand ?? (gate.command ? gate.command.join(' ') : null),
      boundedOutput: gate.boundedOutput ?? '',
    })),
    failedGate: failed?.id ?? null,
    nextAction: failed
      ? `Yalniz ${failed.id} gate'inin kok nedenini duzelt, sonra: `
        + 'node scripts/surat-finalize/orchestrator.mjs continue'
      : 'Tum zorunlu gate PASS — bir sonraki faz acildi.',
    safety: SAFETY_INVARIANTS,
  })
}

export function renderMarkdown(report) {
  const rows = report.gates.map(
    (gate) => `| ${gate.id} | ${gate.status} | ${gate.durationMs} | `
      + `${gate.exitCode ?? '-'} |`,
  )
  return [
    '# Sürat finalization raporu',
    '',
    `- Zaman: ${report.timestamp}`,
    `- HEAD: ${report.gitHead}`,
    `- Worktree kirli: ${report.worktreeDirty}`,
    `- Faz: ${report.currentPhase}`,
    `- Canlı create izni: ${report.liveCreateAllowed}`,
    '',
    '| Gate | Durum | ms | çıkış |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `**Düşen gate:** ${report.failedGate ?? 'yok'}`,
    '',
    `**Sonraki adım:** ${report.nextAction}`,
    '',
  ].join('\n')
}

export function writeReport(report, dir = REPORT_DIR) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'latest-report.json'),
    `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'latest-report.md'), renderMarkdown(report), 'utf8')
  return dir
}
