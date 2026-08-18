// Gate yürütücü — sınırlı çıktı yakalar, sırları maskeler, ağ mutasyonu yapmaz.
import { spawn } from 'node:child_process'
import { REPO_ROOT } from './state.mjs'
import { redactText } from './redact.mjs'

/** Rapora giren çıktı üst sınırı (baş + son). */
export const OUTPUT_TAIL_BYTES = 12_000

export function boundOutput(text, limit = OUTPUT_TAIL_BYTES) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const half = Math.floor(limit / 2)
  return `${value.slice(0, half)}\n…[${value.length - limit} bayt atlandi]…\n${
    value.slice(-half)}`
}

/**
 * Tek gate çalıştırır. `command` yoksa gate ÇALIŞTIRILMAZ — mevcut
 * BLOCKED durumu korunur (uydurma komut üretmeyiz).
 */
export async function runGate(gate, { cwd = REPO_ROOT, now = () => 0 } = {}) {
  if (!gate.command) {
    return { ...gate, status: gate.status === 'PENDING' ? 'BLOCKED' : gate.status,
      durationMs: 0, exitCode: null, boundedOutput: gate.evidence ?? '' }
  }
  if (!gate.safe) {
    return { ...gate, status: 'BLOCKED', durationMs: 0, exitCode: null,
      boundedOutput: 'UNSAFE_GATE_REQUIRES_MANUAL_REVIEW' }
  }
  const startedAt = now()
  const [file, ...args] = gate.command
  const result = await new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd, shell: process.platform === 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('error', (error) => resolve({ code: null, out: String(error) }))
    child.on('close', (code) => resolve({ code, out }))
  })
  // ÇIKIŞ KODU TEK BAŞINA KANIT DEĞİLDİR. Bir gate kanıt deseni bildirmişse
  // çıktı da doğrulanır; aksi hâlde "exit 0" sahte PASS üretebilir.
  const text = String(result.out ?? '')
  const missing = (gate.requireOutput ?? []).filter(
    (pattern) => !new RegExp(pattern).test(text),
  )
  const forbidden = (gate.forbidOutput ?? []).filter(
    (pattern) => new RegExp(pattern).test(text),
  )
  const evidenceOk = missing.length === 0 && forbidden.length === 0
  return {
    ...gate,
    status: result.code === 0 && evidenceOk ? 'PASS' : 'FAIL',
    missingEvidence: missing,
    forbiddenEvidence: forbidden,
    durationMs: now() - startedAt,
    exitCode: result.code,
    safeCommand: gate.command.join(' '),
    boundedOutput: boundOutput(redactText(
      evidenceOk ? result.out
        : `KANIT EKSIK: ${missing.join(' | ') || '-'}
`
          + `YASAKLI KANIT: ${forbidden.join(' | ') || '-'}
${result.out}`,
    )),
  }
}

/** Gate'ler SIRAYLA koşar; zorunlu bir gate düşerse zincir orada durur. */
export async function runGates(gates, options = {}) {
  const results = []
  for (const gate of gates) {
    const result = await runGate(gate, options)
    results.push(result)
    if (result.required && result.status !== 'PASS') {
      for (const remaining of gates.slice(results.length)) {
        results.push({ ...remaining, status: 'NOT_RUN', durationMs: 0,
          exitCode: null, boundedOutput: '' })
      }
      break
    }
  }
  return results
}
