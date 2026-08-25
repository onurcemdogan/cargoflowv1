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
  /** Taşıyıcı GERÇEKTEN iş yanıtı verdi mi? İstisna yanıt DEĞİLDİR. */
  carrierBusinessResponseReceived: boolean
  applicationException: boolean
  stages: string[]
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
    // TRACE V2 OTORİTEDİR.
    //
    // ÖLÇÜLEN KUSUR — CF-4103661055: bu alan YALNIZ `CARRIER_CALL` aşamasının
    // varlığına bakıyordu. O denemede aşamalar CARRIER_CALL_STARTED →
    // (istisna) şeklindeydi; `CARRIER_CALL` hiç yazılmadı. Sonuç: Trace V2
    // `carrierCalled=true` derken arayüz "Taşıyıcı çağrıldı: hayır" gösterdi
    // — yani operatöre "tekrar deneyebilirsin" diyen YANLIŞ bir özet.
    //
    // Ağ sınırının geçildiği KANITI `CARRIER_CALL_STARTED`tır ya da herhangi
    // bir aşamanın açıkça `carrierCalled=true` demesidir.
    carrierCalled: trace.stages.some((entry) => (
      entry.stage === 'CARRIER_CALL' || entry.stage === 'CARRIER_CALL_STARTED'
      || (entry.data as Record<string, unknown> | undefined)
        ?.carrierCalled === true
    )),
    // Ağa çıkmak ile taşıyıcının CEVAP VERMESİ ayrı şeylerdir.
    carrierBusinessResponseReceived: trace.stages.some((entry) => (
      entry.stage === 'CARRIER_RESPONSE'
      && (entry.data as Record<string, unknown> | undefined)
        ?.carrierBusinessResponseReceived !== false
    )),
    applicationException: trace.stages.some(
      (entry) => entry.stage === 'APPLICATION_EXCEPTION',
    ),
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
