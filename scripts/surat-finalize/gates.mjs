// Gate tanımları. Komut adları TAHMİN EDİLMEZ — package.json'dan doğrulanır.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './state.mjs'

export const GATE_STATUSES = [
  'PENDING', 'PASS', 'FAIL', 'BLOCKED', 'NOT_RUN',
]

/** package.json'daki gerçek script adları. */
export function readScripts(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return pkg.scripts ?? {}
}

/** Script yoksa gate uydurulmaz; BLOCKED olarak işaretlenir. */
function npmGate(scripts, id, phase, script, description) {
  const exists = Object.prototype.hasOwnProperty.call(scripts, script)
  return {
    id,
    phase,
    description,
    command: exists ? ['npm', 'run', script] : null,
    required: true,
    safe: true,
    status: exists ? 'PENDING' : 'BLOCKED',
    evidence: exists ? null : `SCRIPT_NOT_FOUND: ${script}`,
  }
}

function nodeTestGate(id, phase, file, description) {
  return {
    id,
    phase,
    description,
    command: ['node', '--test', file],
    required: true,
    safe: true,
    status: 'PENDING',
    evidence: null,
  }
}

/**
 * FAZ A — finansal kapı. Değişmezler ayrı bir gate paketiyle doğrulanır;
 * "önceden kanıtlandı" bilgisi cache'lenmiş PASS olarak KULLANILMAZ.
 */
export function buildPhaseAGates(scripts = readScripts()) {
  const flow = 'server/surat-flow.test.mjs'
  return [
    nodeTestGate('A1_SURAT_FLOW_RUN_1', 'A', flow, 'surat-flow 1. temiz kosu'),
    nodeTestGate('A2_SURAT_FLOW_RUN_2', 'A', flow, 'surat-flow 2. temiz kosu'),
    nodeTestGate('A3_SURAT_FLOW_RUN_3', 'A', flow, 'surat-flow 3. temiz kosu'),
    nodeTestGate(
      'A4_FINANCIAL_ZERO_BYPASS', 'A',
      'server/surat-zero-bypass-gate-flow.test.mjs',
      'sifir bypass finansal kapi',
    ),
    // A5–A8 değişmezleri, kapının mimarisini kilitleyen testin İÇİNDE
    // doğrulanır (GATE-ARCH / GATE-MODES / GATE-FP). Ayrı bir "audit"
    // betiği uydurmak yerine mevcut deterministik testler kullanılır.
    nodeTestGate(
      'A5_FINANCIAL_GUARD', 'A',
      'server/surat-financial-guard-flow.test.mjs',
      'bozuk baglamda tasiyici cagrisi 0',
    ),
    nodeTestGate(
      'A6_ROUTING_MODEL', 'A',
      'server/surat-routing-model-flow.test.mjs',
      'yetkili kimlik yonlendirme modeli',
    ),
    npmGate(scripts, 'A9_FULL_SURAT', 'A', 'test:surat', 'Surat tam paketi'),
    npmGate(scripts, 'A9B_FULL_UI', 'A', 'test:ui', 'UI paketi'),
    npmGate(scripts, 'A10_BUILD', 'A', 'build', 'production build'),
    npmGate(scripts, 'A11_LINT', 'A', 'lint', 'lint'),
  ]
}

/**
 * B–E fazlarının gate'leri, o faz açıldığında ilgili testler var olduğunda
 * tanımlanır. Şu an yalnız kapsam bildirimi taşırlar — sahte PASS üretmezler.
 */
export function buildPlaceholderGates(phase, description) {
  return [{
    id: `${phase}0_NOT_IMPLEMENTED`,
    phase,
    description,
    command: null,
    required: true,
    safe: true,
    status: 'BLOCKED',
    evidence: 'PHASE_NOT_IMPLEMENTED_YET',
  }]
}

/** FAZ B — taşıyıcı yanıt sınıflandırması. */
export function buildPhaseBGates(scripts = readScripts()) {
  return [
    nodeTestGate(
      'B1_RESPONSE_CLASSIFICATION', 'B',
      'server/surat-response-classification-flow.test.mjs',
      'HTTP 200 != basari · 016/039 ayrimi · is mesaji korunur',
    ),
    nodeTestGate(
      'B2_SURAT_FLOW', 'B', 'server/surat-flow.test.mjs',
      'mevcut create davranisi bozulmadi',
    ),
    npmGate(scripts, 'B3_FULL_SURAT', 'B', 'test:surat', 'Surat tam paketi'),
    npmGate(scripts, 'B4_UI', 'B', 'test:ui', 'UI paketi'),
    npmGate(scripts, 'B5_BUILD', 'B', 'build', 'production build'),
    npmGate(scripts, 'B6_LINT', 'B', 'lint', 'lint'),
  ]
}

/** FAZ C — trace v2: tek kimlik, tam döngü, değişmezlik, yalıtım. */
export function buildPhaseCGates(scripts = readScripts()) {
  return [
    nodeTestGate(
      'C1_TRACE_V2', 'C', 'server/surat-trace-v2-flow.test.mjs',
      'sema v2 · dongu · degismezlik · yalitim · maskeleme · saklama',
    ),
    // ZORUNLU: modulun VAR olmasi yetmez. Bu gate, gercek create yolunun
    // Trace V2'yi CAGIRDIGINI kanitlar. Ilk Faz C gecisi tam da bu gate
    // eksik oldugu icin YANLIS POZITIFTI.
    nodeTestGate(
      'C1B_REAL_RUNTIME_WIRING', 'C',
      'server/surat-trace-runtime-flow.test.mjs',
      'gercek create yolunda tam yasam dongusu · tek traceId · yalitim',
    ),
    nodeTestGate(
      'C2_ROUTING_MODEL', 'C', 'server/surat-routing-model-flow.test.mjs',
      'beklenen vs tel ayrimi bozulmadi',
    ),
    nodeTestGate(
      'C3_SURAT_FLOW', 'C', 'server/surat-flow.test.mjs',
      'create davranisi bozulmadi',
    ),
    npmGate(scripts, 'C4_FULL_SURAT', 'C', 'test:surat', 'Surat tam paketi'),
    npmGate(scripts, 'C5_UI', 'C', 'test:ui', 'UI paketi'),
    npmGate(scripts, 'C6_BUILD', 'C', 'build', 'production build'),
    npmGate(scripts, 'C7_LINT', 'C', 'lint', 'lint'),
  ]
}

/** FAZ D — COD kimlik/politika + Canlı Debug arayüzü. */
export function buildPhaseDGates(scripts = readScripts()) {
  return [
    nodeTestGate(
      'D1_COD_POLICY', 'D', 'server/surat-cod-policy-flow.test.mjs',
      'COD/BillingParty bagimsiz · sessiz fallback YOK · politika enum',
    ),
    npmGate(scripts, 'D2_UI', 'D', 'test:ui', 'UI paketi (COD politika alani)'),
    npmGate(scripts, 'D3_BUILD', 'D', 'build', 'production build'),
    npmGate(scripts, 'D4_LINT', 'D', 'lint', 'lint'),
    npmGate(scripts, 'D5_FULL_SURAT', 'D', 'test:surat', 'Surat tam paketi'),
  ]
}


/**
 * FAZ E — ÜRETİM HAZIRLIĞI. Gate'ler GERÇEK read-only komutları çalıştırır;
 * çıkış kodu yetmez, çıktıdaki kanıt da doğrulanır. Hedef tenant/paket
 * STATE.json'daki `productionTarget`tan gelir — uygulama koduna GÖMÜLMEZ.
 */
export function buildPhaseEGates(scripts = readScripts(), state = null) {
  const target = state?.productionTarget
  if (!target?.tenantName || !target?.packageId) {
    return [{
      id: 'E0_PRODUCTION_TARGET',
      phase: 'E',
      description: 'STATE.json productionTarget (tenantName + packageId)',
      command: null,
      required: true,
      safe: true,
      status: 'BLOCKED',
      evidence: 'PRODUCTION_TARGET_MISSING: STATE.json → productionTarget',
    }]
  }
  const canary = Object.prototype.hasOwnProperty.call(
    scripts, 'surat:canary:precheck',
  )
  const inspect = Object.prototype.hasOwnProperty.call(
    scripts, 'surat:billing:inspect',
  )
  return [
    {
      id: 'E1_PRODUCTION_CONFIG_READ_ONLY',
      phase: 'E',
      description: 'uretim config read-only dogrulamasi (canary precheck)',
      command: canary
        ? ['npm', 'run', 'surat:canary:precheck', '--',
           '--name', target.tenantName]
        : null,
      required: true,
      safe: true,
      status: canary ? 'PENDING' : 'BLOCKED',
      evidence: canary ? null : 'SCRIPT_NOT_FOUND: surat:canary:precheck',
      // Yalnız aracın GERÇEKTEN bastığı etiketler; uydurma yok.
      requireOutput: [
        'DATA_SOURCE[ ]*:[ ]*POSTGRES',
        'AUTHORITATIVE_SOURCE_RESOLVED[ ]*:[ ]*YES',
        'ORGANIZATION FOUND[ ]*:[ ]*YES',
        'ACTIVE SURAT INTEGRATION[ ]*:[ ]*YES',
        'CANONICAL MODE SELECTED[ ]*:[ ]*YES',
        'CANARY PRECHECK[ ]*:[ ]*READY',
      ],
      forbidOutput: ['CANARY PRECHECK[ ]*:[ ]*BLOCKED'],
    },
    {
      id: 'E2_REAL_ORDER_DRY_RUN',
      phase: 'E',
      description: 'gercek siparis NETWORK=0 kuru kosusu',
      command: inspect
        ? ['npm', 'run', 'surat:billing:inspect', '--',
           '--name', target.tenantName,
           '--package', target.packageId, '--create-context']
        : null,
      required: true,
      safe: true,
      status: inspect ? 'PENDING' : 'BLOCKED',
      evidence: inspect ? null : 'SCRIPT_NOT_FOUND: surat:billing:inspect',
      requireOutput: [
        'REAL_RUNTIME_BILLING_PARTY[ ]+TRENDYOL_PAYS',
        'EXPECTED_SURAT_WHO_PAYS[ ]+3',
        'CREDENTIAL_ROLE[ ]+PRIMARY_MARKETPLACE',
        'CREDENTIAL_RESOLVED[ ]+YES',
        'REAL_RUNTIME_CREDENTIAL_CONFIG_PRESENT[ ]+YES',
        'EXPECTED_BILLING_PARTY_WIRED_TO_REAL_CREATE[ ]+YES',
        'NETWORK_CALLS 0 . DB_WRITES 0 . CREATE_CALLS 0 . PRINT_CALLS 0',
      ],
      // Kimlik cozulemediyse veya taraf yanlissa PASS OLAMAZ.
      forbidOutput: [
        'CREDENTIAL_RESOLVED[ ]+NO',
        'EXPECTED_BILLING_PARTY_WIRED_TO_REAL_CREATE[ ]+NO',
      ],
    },
  ]
}

export function buildGates(phase, scripts = readScripts(), state = null) {
  if (phase === 'A') return buildPhaseAGates(scripts)
  if (phase === 'B') return buildPhaseBGates(scripts)
  if (phase === 'C') return buildPhaseCGates(scripts)
  if (phase === 'D') return buildPhaseDGates(scripts)
  if (phase === 'E') return buildPhaseEGates(scripts, state)
  return []
}
