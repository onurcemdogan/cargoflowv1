// CargoFlow yol haritası durumu — REPODA kalıcı.
// Sohbet bağlamı kaybolduğunda "nerede kaldık" sorusunun tek yanıtı budur.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..')
export const STATE_PATH = join(
  REPO_ROOT, 'docs', 'cargoflow-roadmap', 'STATE.json',
)

/** Sıra KİLİTLİDİR; atlama komutu bilinçli olarak YOKTUR. */
export const PHASE_ORDER = [
  'S1_SURAT_HARDENING',
  'P1_B2_PERFORMANCE',
  'P2_B3_INCREMENTAL_SYNC',
  'P3_B4_BARCODE_WORKER',
  'P4_HEPSIBURADA_N11',
  'P5_ARAS',
  'P6_SURAT_NON_MARKETPLACE',
]

export const PHASE_STATUSES = [
  'locked', 'in_progress', 'passed',
  'blocked_external_contract', 'blocked_external_environment',
]

/** Dış sözleşme engeli YALNIZ bu fazlarda ilerlemeye izin verir. */
export const CONTRACT_BLOCK_MAY_UNLOCK = new Set([
  'P4_HEPSIBURADA_N11', 'P5_ARAS', 'P6_SURAT_NON_MARKETPLACE',
])

export const loadState = (path = STATE_PATH) =>
  JSON.parse(readFileSync(path, 'utf8'))

export function saveState(state, path = STATE_PATH) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return state
}

/**
 * Önceki faz `passed` DEĞİLSE kilitlidir. Tek istisna: P4/P5/P6 dış sözleşme
 * eksikliğiyle bloklanmışsa sonraki faz açılabilir — o engel bizim
 * çözebileceğimiz bir şey değildir ve tüm yol haritasını durdurmamalıdır.
 */
export function isPhaseRunnable(state, phase) {
  const index = PHASE_ORDER.indexOf(phase)
  if (index < 0) return false
  return PHASE_ORDER.slice(0, index).every((earlier) => {
    const status = state.phases[earlier]?.status
    if (status === 'passed') return true
    return status === 'blocked_external_contract'
      && CONTRACT_BLOCK_MAY_UNLOCK.has(earlier)
  })
}

/** Fazı kapatır ve SIRADAKİNİ açar. Durumu ilerletir; kod YAZMAZ. */
export function advancePhase(state, phase, options = {}) {
  const entry = state.phases[phase]
  if (!entry) return state
  entry.status = options.status ?? 'passed'
  entry.completedAt = options.at ?? null
  entry.commit = options.commit ?? null
  entry.branch = options.branch ?? entry.branch ?? null
  if (options.blockerDetail) entry.blockerDetail = options.blockerDetail
  const next = PHASE_ORDER[PHASE_ORDER.indexOf(phase) + 1]
  if (next && isPhaseRunnable(state, next)) {
    state.phases[next].status = 'in_progress'
    state.currentPhase = next
  } else if (!next) {
    state.currentPhase = 'COMPLETE'
  }
  // Canlı taşıyıcı create'i HER durumda insan kararıdır.
  state.liveCreateAllowed = false
  return state
}

/** Gate sonucunu kalıcı denetim kaydına ekler (SIR YAZILMAZ). */
export function recordGateResult(state, entry) {
  state.history = [
    ...(state.history ?? []).slice(-199),
    {
      phase: entry.phase, gate: entry.gate, status: entry.status,
      timestamp: entry.timestamp ?? null, commit: entry.commit ?? null,
      branch: entry.branch ?? null, evidence: entry.evidence ?? null,
    },
  ]
  return state
}
