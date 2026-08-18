// Yol haritası gate tanımları. Komut adları package.json'dan DOĞRULANIR.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './state.mjs'

export const readScripts = (root = REPO_ROOT) =>
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}

/** Script yoksa komut UYDURULMAZ; gate BLOCKED olur. */
function npmGate(scripts, id, phase, script, description, extra = {}) {
  const exists = Object.prototype.hasOwnProperty.call(scripts, script)
  return {
    id, phase, description, required: true, safe: true,
    command: exists ? ['npm', 'run', script] : null,
    status: exists ? 'PENDING' : 'BLOCKED',
    evidence: exists ? null : `SCRIPT_NOT_FOUND: ${script}`,
    ...extra,
  }
}

const nodeTestGate = (id, phase, file, description, extra = {}) => ({
  id, phase, description, required: true, safe: true,
  command: ['node', '--test', file], status: 'PENDING', evidence: null, ...extra,
})

/** Henüz uygulanmamış iş SAHTE PASS üretmesin diye açıkça BLOCKED tutulur. */
const notImplemented = (id, phase, description, detail) => ({
  id, phase, description, command: null, required: true, safe: true,
  status: 'BLOCKED', evidence: `NOT_IMPLEMENTED: ${detail}`,
})

/** Ortak kalite kapıları — her faz bunlarla biter. */
const qualityGates = (scripts, phase, prefix) => [
  npmGate(scripts, `${prefix}_SURAT`, phase, 'test:surat', 'Surat paketi'),
  npmGate(scripts, `${prefix}_UI`, phase, 'test:ui', 'UI paketi'),
  npmGate(scripts, `${prefix}_BUILD`, phase, 'build', 'production build'),
  npmGate(scripts, `${prefix}_LINT`, phase, 'lint', 'lint'),
]

/** FAZ P1 — sipariş okuma yolları (0008 kapsam dışı; karar: 2026-08-18). */
export function buildPhaseP1Gates(scripts = readScripts()) {
  return [
    nodeTestGate(
      'P1_QUERY_SHAPE', 'P1_B2_PERFORMANCE',
      'server/orders-b2-query-shape-flow.test.mjs',
      'sorgu sayisi sayfa/satir sayisindan BAGIMSIZ · sayfalama sinirli',
    ),
    ...qualityGates(scripts, 'P1_B2_PERFORMANCE', 'P1'),
  ]
}

/** FAZ P2 — artimli senkron (denetim: docs/cargoflow-roadmap/P2_AUDIT.md). */
export function buildPhaseP2Gates(scripts = readScripts()) {
  return [
    nodeTestGate(
      'P2_WINDOW_POLICY', 'P2_B3_INCREMENTAL_SYNC',
      'server/orders-b3-sync-window-flow.test.mjs',
      'imlec + emniyet payi + periyodik genis tarama karari',
    ),
    nodeTestGate(
      'P2_CURSOR_WIRED', 'P2_B3_INCREMENTAL_SYNC',
      'server/orders-b3-sync-wiring-flow.test.mjs',
      'imlec cekim penceresini GERCEKTEN daraltir · watermark yazilir',
    ),
    nodeTestGate(
      'P2_BOUNDED_PULL', 'P2_B3_INCREMENTAL_SYNC',
      'server/orders-b3-bounded-pull-flow.test.mjs',
      'sinirli cekim · siniflandirilmis backoff · 429/Retry-After',
    ),
    nodeTestGate(
      'P2_SINGLE_FLIGHT', 'P2_B3_INCREMENTAL_SYNC',
      'server/sync-single-flight-flow.test.mjs',
      'hesap kapsamli tek-ucus kilidi',
    ),
    nodeTestGate(
      'P2_PARTIAL_SAFETY', 'P2_B3_INCREMENTAL_SYNC',
      'server/active-sync-reconciliation-flow.test.mjs',
      'complete=false HICBIR kaydi arsivlemez',
    ),
    ...qualityGates(scripts, 'P2_B3_INCREMENTAL_SYNC', 'P2'),
  ]
}

export function buildGates(phase, scripts = readScripts()) {
  if (phase === 'S1_SURAT_HARDENING') {
    return [
      nodeTestGate(
        'S1_CREDENTIAL_PARITY', phase,
        'server/surat-credential-wire-parity-flow.test.mjs',
        'ag oncesi kimlik parite kapisi',
      ),
      nodeTestGate(
        'S1_WIRE_CONTRACT', phase,
        'server/surat-canonical-wire-contract-flow.test.mjs',
        'kanonik istek sekli tel sinirinda kilitli',
      ),
      nodeTestGate(
        'S1_TRACE_RUNTIME', phase, 'server/surat-trace-runtime-flow.test.mjs',
        'Trace V2 gercek create yoluna bagli',
      ),
    {
      id: 'S1_LIVE_DEBUG_UI', phase,
      description: 'Trace V2 tabanli Canli Debug varsayilan; legacy satir 0',
      command: ['npx', 'vitest', 'run',
        'src/test/integrationDebugDefault.dom.test.tsx',
        'src/test/suratLiveDebugPanel.dom.test.tsx',
        'src/test/suratLiveDebug.test.ts'],
      required: true, safe: true, status: 'PENDING', evidence: null,
      // Cikis kodu yetmez: testlerin GERCEKTEN kostugu gorulmeli.
      requireOutput: ['Test Files[ ]+3 passed'],
      forbidOutput: ['FAIL[ ]'],
    },
    {
      id: 'S1_FAILED_ORDER_STATE', phase,
      description: 'CREATE_FAILED siparisi basarili kayit gibi GORUNMEZ',
      command: ['npx', 'vitest', 'run',
        'src/test/failedCreateOrderState.test.ts'],
      required: true, safe: true, status: 'PENDING', evidence: null,
      requireOutput: ['Test Files[ ]+1 passed'],
      forbidOutput: ['FAIL[ ]'],
    },
      ...qualityGates(scripts, phase, 'S1'),
    ]
  }
  if (phase === 'P1_B2_PERFORMANCE') return buildPhaseP1Gates(scripts)
  if (phase === 'P2_B3_INCREMENTAL_SYNC') return buildPhaseP2Gates(scripts)
  const pending = {
    // DENETIM YAPILDI (docs/cargoflow-roadmap/P1_AUDIT.md): sayfalama, N+1
    // kaldirma, sayim ve aralik sorgusu ZATEN VAR. Kalan: 0008 migration +
    // arac zinciri (preflight/prova/backfill/golge parite/geri alma) + benchmark.
    P3_B4_BARCODE_WORKER: 'uygun siparis secimi, kuyruk oncesi finansal on kontrol',
    P4_HEPSIBURADA_N11: 'saglayici-notr temel; dis sozlesme dogrulanmali',
    P5_ARAS: 'tasiyici-notr temel; dis sozlesme dogrulanmali',
    P6_SURAT_NON_MARKETPLACE: 'pazaryeri disi sozlesme kaniti gerekli',
  }
  if (pending[phase]) {
    return [
      notImplemented(`${phase}_AUDIT`, phase, 'mevcut durum denetimi', pending[phase]),
      ...qualityGates(scripts, phase, phase),
    ]
  }
  return []
}
