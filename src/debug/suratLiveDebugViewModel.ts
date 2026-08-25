// FAZ D — Canlı Debug görünüm modeli.
//
// SAF projeksiyon: TEK bir Trace V2 denemesini beş sekmeye böler. Mevcut
// config'e HİÇ bakmaz — geçmiş bir deneme, o an neyin ayarlı olduğuna göre
// yeniden yorumlanamaz.
import type { StoredTrace } from '../services/suratTraceDebugStore'

export const LIVE_DEBUG_TABS = [
  'Son Deneme', 'Karar / Mapping', 'Request', 'Response', 'Geçmiş',
] as const

const SECRET_HINTS = [
  'password', 'sifre', 'secret', 'token', 'apikey', 'apisecret',
  'authorization', 'webpassword',
]
const SAFE_SUFFIXES = ['role', 'source', 'policy', 'reason', 'resolved']

/** İkinci savunma hattı: iz zaten maskeli yazılır, arayüz yine de maskeler. */
export function redactForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDisplay)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      const lowered = key.toLowerCase()
      const secret = SECRET_HINTS.some((hint) => lowered.includes(hint))
      const safe = lowered.includes('masked')
        || SAFE_SUFFIXES.some((suffix) => lowered.endsWith(suffix))
      out[key] = secret && !safe ? '«gizli»' : redactForDisplay(inner)
    }
    return out
  }
  return value
}

/**
 * Aynı aşama birden çok kez varsa SONUNCUSU geçerlidir (append-only) —
 * sunucu izdüşümündeki `stageData` ile AYNI kural.
 *
 * İLK eşleşmeyi okumak, yeniden denenen ya da yeniden eklenen bir aşamada
 * operatöre BAYAT veriyi gösterirdi; aynı izi okuyan CLI denetçisi ise
 * güncelini gösterirdi. "Aynı iz, iki okuyucu, iki cevap" kusuru budur
 * (CF-4088628726 ailesi).
 */
const stageData = (
  trace: StoredTrace, stage: string,
): Record<string, unknown> => {
  for (let i = trace.stages.length - 1; i >= 0; i -= 1) {
    if (trace.stages[i]?.stage === stage) {
      return (trace.stages[i]?.data as Record<string, unknown>) ?? {}
    }
  }
  return {}
}

export interface LiveDebugViewModel {
  traceId: string
  createdAt: string
  /** Beklenen/semantik alan — taşıyıcı sözleşmesinden BAĞIMSIZ. */
  expected: Record<string, unknown>
  /** Telde GERÇEKTEN giden — uydurulmuş alan YOK. */
  wire: Record<string, unknown>
  /** Üç bağımsız alan ayrı ayrı gösterilir. */
  decision: {
    billing: Record<string, unknown>
    payment: Record<string, unknown>
    cod: Record<string, unknown>
    credential: Record<string, unknown>
  }
  preflight: { passed: boolean; failures: unknown[] }
  request: Record<string, unknown>
  response: Record<string, unknown>
  verification: Record<string, unknown>
  finalResult: Record<string, unknown>
  carrierCalled: boolean
  stages: string[]
  /** Her taşıma bacağı AYRI: REST kaydı ile SOAP barkodu karışmaz. */
  legs: Array<{
    step: string
    wire: Record<string, unknown> | null
    callStarted: Record<string, unknown> | null
    response: Record<string, unknown> | null
  }>
}

/**
 * İz iki taşıma bacağı taşıyabilir: REST kaydı ve SOAP barkodu. Tek bir
 * `CARRIER_RESPONSE` göstermek birini gizler — üretimde REST başarısı
 * SOAP hatasını maskeliyordu. Aşamalar `step` ayırt edicisine göre
 * gruplanır; ayırt edici yoksa tek bacak olarak sunulur.
 */
function buildLegs(trace: StoredTrace): LiveDebugViewModel['legs'] {
  const order: string[] = []
  const byStep = new Map<string, LiveDebugViewModel['legs'][number]>()
  const stepOf = (entry: { data: unknown }): string => {
    const data = (entry.data ?? {}) as Record<string, unknown>
    return String(data.step ?? 'CARRIER')
  }
  for (const entry of trace.stages) {
    if (!['ACTUAL_WIRE_READY', 'CARRIER_CALL_STARTED', 'CARRIER_RESPONSE']
      .includes(entry.stage)) continue
    const step = stepOf(entry)
    if (!byStep.has(step)) {
      byStep.set(step, { step, wire: null, callStarted: null, response: null })
      order.push(step)
    }
    const leg = byStep.get(step)!
    const data = redactForDisplay(entry.data) as Record<string, unknown>
    if (entry.stage === 'ACTUAL_WIRE_READY') leg.wire = data
    if (entry.stage === 'CARRIER_CALL_STARTED') leg.callStarted = data
    // Aynı bacakta birden çok yanıt olursa SONUNCUSU geçerlidir.
    if (entry.stage === 'CARRIER_RESPONSE') leg.response = data
  }
  return order.map((step) => byStep.get(step)!)
}

export function buildLiveDebugViewModel(
  trace: StoredTrace | null,
): LiveDebugViewModel | null {
  if (!trace) return null
  const pre = stageData(trace, 'PRE_FLIGHT')
  const routing = stageData(trace, 'ROUTING')
  const request = stageData(trace, 'REQUEST_READY')
  const response = stageData(trace, 'CARRIER_RESPONSE')
  const verification = stageData(trace, 'VERIFICATION')
  const final = stageData(trace, 'FINAL')

  return {
    traceId: trace.traceId,
    createdAt: trace.createdAt,
    expected: {
      billingParty: pre.billingParty ?? null,
      expectedSuratWhoPays: pre.expectedSuratWhoPays ?? null,
      odemeTipi: pre.odemeTipi ?? null,
      codEnabled: pre.codEnabled ?? null,
    },
    wire: redactForDisplay(request) as Record<string, unknown>,
    decision: {
      // Bu üç alan BİRBİRİNDEN TÜREMEZ; arayüz de öyle göstermelidir.
      billing: {
        billingParty: pre.billingParty ?? null,
        expectedSuratWhoPays: pre.expectedSuratWhoPays ?? null,
      },
      payment: { odemeTipi: pre.odemeTipi ?? null },
      cod: { codEnabled: pre.codEnabled ?? null },
      credential: redactForDisplay(routing) as Record<string, unknown>,
    },
    preflight: {
      passed: pre.preflightValid === true,
      failures: Array.isArray(pre.preflightFailures)
        ? pre.preflightFailures : [],
    },
    request: redactForDisplay(request) as Record<string, unknown>,
    response: redactForDisplay(response) as Record<string, unknown>,
    verification: redactForDisplay(verification) as Record<string, unknown>,
    finalResult: redactForDisplay(final) as Record<string, unknown>,
    // Taşıyıcıya gidilmediyse bu AŞAMA HİÇ YOKTUR; kanıt budur.
    carrierCalled: trace.stages.some((entry) => entry.stage === 'CARRIER_CALL'),
    legs: buildLegs(trace),
    stages: trace.stages.map((entry) => entry.stage),
  }
}

/**
 * Telde WhoPays gitmemesi HATA DEĞİLDİR: kanonik sözleşmede böyle bir alan
 * yoktur. Arayüz bunu nötr bilgi olarak göstermelidir.
 */
export function describeWireWhoPaysForDisplay(model: LiveDebugViewModel): {
  label: string; reason: string | null; isError: boolean
} {
  if (model.wire.wireWhoPaysPresent === true) {
    return {
      label: String(model.wire.wireWhoPaysValue ?? ''),
      reason: null, isError: false,
    }
  }
  return {
    label: 'GÖNDERİLMEDİ',
    reason: (model.wire.wireWhoPaysReason as string) ?? null,
    isError: false,
  }
}

/** İzlenebilir, sırsız kullanıcı hatası. */
export function buildTraceableUserError(
  model: LiveDebugViewModel,
): string | null {
  if (model.finalResult.carrierCreateStatus === 'SUCCESS') return null
  const code = model.response.businessCode
    ?? model.finalResult.outcome
    ?? (model.preflight.passed ? null : model.preflight.failures[0])
  const codePart = code ? ` Kod: ${String(code)}.` : ''
  return `Sürat barkod oluşturma başarısız.${codePart} Trace: ${model.traceId}`
}
