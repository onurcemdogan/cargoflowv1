// Faz durumu — repo'da kalıcı. Sohbet hafızası bittiğinde tek doğru kaynak.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..')
export const STATE_PATH = join(
  REPO_ROOT, 'docs', 'surat-finalization', 'STATE.json',
)

/** Faz sırası — atlama YOK; kilit bu diziye göre çözülür. */
export const PHASE_ORDER = ['A', 'B', 'C', 'D', 'E']

export const PHASE_TITLES = {
  A: 'PHASE_A_FINANCIAL_GATE',
  B: 'PHASE_B_RESPONSE_CLASSIFICATION',
  C: 'PHASE_C_TRACE_V2',
  D: 'PHASE_D_UI_DEBUG_COD',
  E: 'PHASE_E_PRODUCTION_READINESS',
}

export function loadState(path = STATE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function saveState(state, path = STATE_PATH) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return state
}

/**
 * Bir fazın çalıştırılabilir olup olmadığı. Önceki TÜM fazlar `passed`
 * değilse faz KİLİTLİDİR — force/skip yolu bilinçli olarak YOKTUR.
 */
export function isPhaseRunnable(state, phase) {
  const index = PHASE_ORDER.indexOf(phase)
  if (index < 0) return false
  return PHASE_ORDER.slice(0, index).every(
    (earlier) => state.phases[earlier]?.status === 'passed',
  )
}

/**
 * Fazın tüm zorunlu gate'leri PASS ise fazı kapatır ve SIRADAKİNİ AÇAR.
 * Yalnız durumu ilerletir — sonraki fazın kodunu ASLA yazmaz.
 */
export function advancePhase(state, phase, { commit = null, at = null } = {}) {
  const current = state.phases[phase]
  if (!current) return state
  current.status = 'passed'
  current.completedAt = at
  current.commit = commit
  const next = PHASE_ORDER[PHASE_ORDER.indexOf(phase) + 1]
  if (next) {
    state.phases[next].status = 'in_progress'
    state.currentPhase = next
  } else {
    state.currentPhase = 'COMPLETE'
  }
  // Tüm fazlar bitse bile canlı create İNSAN kararıdır.
  state.liveCreateAllowed = false
  return state
}
