// TRACE V2 — DENETÇİ İZDÜŞÜMÜ (saf; ağ/DB YOK).
//
// ═══ NEDEN AYRI MODÜL ════════════════════════════════════════════════════
//
// ÖLÇÜLEN ÜRETİM ÇELİŞKİSİ (CF-4088628726): iz `ACTUAL_WIRE_READY` aşamasını
// TAŞIYORDU, ama denetçi tüm tel alanlarını `ABSENT` gösteriyordu. Sebep
// kalıcılaştırma DEĞİL, OKUMAYDI: denetçi `REQUEST_READY` aşamasına bakıyor
// ve `Gonderi`/`OdemeTipi` gibi HAM anahtarlar arıyordu; oysa yakalama
// `ACTUAL_WIRE_READY` aşamasına `gonderiFieldTypes`/`safeValues` şeklinde
// yazıyordu.
//
// İzdüşüm buraya alındı ki TEST, denetçinin KULLANDIĞI kodun ta kendisini
// çalıştırsın. Ayrı bir kopya olsaydı test yeşil, denetçi yine kör kalırdı.
//
// ═══ İKİ DURUM ASLA BİRLEŞTİRİLMEZ ═══════════════════════════════════════
//   STAGE_MISSING → deneme ağa hiç çıkmadı / aşama yok
//   ABSENT        → aşama VAR ama o alan telde YOKTU
// Bunları tek göstermek, gönderilmemiş isteği "alansız gönderildi" gibi
// okutur.

export const WIRE_STAGE_MISSING = 'STAGE_MISSING' as const
export const WIRE_FIELD_ABSENT = 'ABSENT' as const

export interface TraceStageEntry {
  stage?: unknown
  section?: unknown
  at?: unknown
  data?: unknown
}

const asStages = (value: unknown): TraceStageEntry[] =>
  Array.isArray(value) ? (value as TraceStageEntry[]) : []

/** Aynı aşama birden çok kez varsa SONUNCUSU geçerlidir (append-only). */
export function stageData(
  stages: unknown, stage: string,
): Record<string, unknown> | null {
  const list = asStages(stages)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.stage === stage) {
      const data = list[i]?.data
      return data && typeof data === 'object'
        ? (data as Record<string, unknown>)
        : {}
    }
  }
  return null
}

export interface WireFieldView {
  /** `ABSENT` ya da gerçek değer. */
  value: unknown
  runtimeType: string
}

export interface ActualWireProjection {
  /** Aşama hiç yoksa `STAGE_MISSING`. */
  status: 'PRESENT' | typeof WIRE_STAGE_MISSING
  rootRuntimeType: string
  gonderiRuntimeType: string
  fieldRuntimeTypes: Record<string, string>
  fields: Record<string, WireFieldView>
  credential: {
    kullaniciAdiPresent: unknown
    sifrePresent: unknown
    resolverAccountFingerprint: unknown
    snapshotAccountFingerprint: unknown
    requestBuilderAccountFingerprint: unknown
    networkBoundaryAccountFingerprint: unknown
    credentialFingerprintMatch: unknown
    divergentBoundaries: unknown
  }
  serializedLength: unknown
}

/** Denetçinin gösterdiği tel alanları. */
export const PROJECTED_WIRE_FIELDS = [
  'OdemeTipi', 'Pazaryerimi', 'EntegrasyonFirmasi',
  'ReferansNo', 'OzelKargoTakipNo', 'KapidanOdemeTahsilatTipi',
  'KapidanOdemeTutari', 'WhoPays', 'KimOder', 'FirmaId',
] as const

/**
 * GERÇEK TEL izdüşümü — YALNIZ `ACTUAL_WIRE_READY` aşamasından.
 *
 * `REQUEST_READY` KARAR anıdır, tel DEĞİLDİR; oradan okumak üretimde her
 * alanı `ABSENT` gösterdi.
 */
export function projectActualWire(stages: unknown): ActualWireProjection {
  const wire = stageData(stages, 'ACTUAL_WIRE_READY')
  const empty: ActualWireProjection = {
    status: WIRE_STAGE_MISSING,
    rootRuntimeType: WIRE_STAGE_MISSING,
    gonderiRuntimeType: WIRE_STAGE_MISSING,
    fieldRuntimeTypes: {},
    fields: {},
    credential: {
      kullaniciAdiPresent: WIRE_STAGE_MISSING,
      sifrePresent: WIRE_STAGE_MISSING,
      resolverAccountFingerprint: WIRE_STAGE_MISSING,
      snapshotAccountFingerprint: WIRE_STAGE_MISSING,
      requestBuilderAccountFingerprint: WIRE_STAGE_MISSING,
      networkBoundaryAccountFingerprint: WIRE_STAGE_MISSING,
      credentialFingerprintMatch: WIRE_STAGE_MISSING,
      divergentBoundaries: WIRE_STAGE_MISSING,
    },
    serializedLength: WIRE_STAGE_MISSING,
  }
  if (!wire) return empty

  const fieldRuntimeTypes = (wire.gonderiFieldTypes ?? {}) as Record<string, string>
  const safeValues = (wire.safeValues ?? {}) as Record<string, unknown>
  const presence = (wire.presence ?? {}) as Record<string, {
    present?: unknown; runtimeType?: unknown
  }>
  const optional = (wire.optionalContractFields ?? {}) as Record<string, {
    present?: unknown; runtimeType?: unknown; value?: unknown
  }>

  const fields: Record<string, WireFieldView> = {}
  for (const field of PROJECTED_WIRE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(safeValues, field)) {
      const value = safeValues[field]
      fields[field] = {
        value: value === null || value === undefined ? WIRE_FIELD_ABSENT : value,
        runtimeType: fieldRuntimeTypes[field] ?? 'absent',
      }
      continue
    }
    if (presence[field]) {
      fields[field] = {
        // Değer BİLEREK taşınmaz (hesap kimliği / tutar).
        value: presence[field].present ? 'PRESENT' : WIRE_FIELD_ABSENT,
        runtimeType: String(presence[field].runtimeType ?? 'absent'),
      }
      continue
    }
    if (optional[field]) {
      fields[field] = {
        value: optional[field].present
          ? (optional[field].value ?? 'PRESENT')
          : WIRE_FIELD_ABSENT,
        runtimeType: String(optional[field].runtimeType ?? 'absent'),
      }
      continue
    }
    fields[field] = { value: WIRE_FIELD_ABSENT, runtimeType: 'absent' }
  }

  const credential = (wire.credential ?? {}) as Record<string, unknown>
  return {
    status: 'PRESENT',
    rootRuntimeType: String(wire.rootRuntimeType ?? 'absent'),
    gonderiRuntimeType: String(wire.gonderiRuntimeType ?? 'absent'),
    fieldRuntimeTypes,
    fields,
    credential: {
      kullaniciAdiPresent: credential.kullaniciAdiPresent ?? false,
      sifrePresent: credential.sifrePresent ?? false,
      resolverAccountFingerprint: wire.resolverAccountFingerprint ?? WIRE_FIELD_ABSENT,
      snapshotAccountFingerprint: wire.snapshotAccountFingerprint ?? WIRE_FIELD_ABSENT,
      requestBuilderAccountFingerprint:
        wire.requestBuilderAccountFingerprint ?? WIRE_FIELD_ABSENT,
      networkBoundaryAccountFingerprint:
        wire.networkBoundaryAccountFingerprint
        ?? credential.networkBoundaryAccountFingerprint
        ?? WIRE_FIELD_ABSENT,
      credentialFingerprintMatch: wire.credentialFingerprintMatch ?? WIRE_FIELD_ABSENT,
      divergentBoundaries: wire.divergentBoundaries ?? WIRE_FIELD_ABSENT,
    },
    serializedLength: wire.serializedLength ?? WIRE_FIELD_ABSENT,
  }
}

/**
 * TAŞIYICI GERÇEĞİ — iz aşamalarından, denetçinin kendi yan etkilerinden
 * DEĞİL.
 *
 * ÖLÇÜLEN KUSUR: denetçi geçmiş bir deneme için `NETWORK_CALLS 0` basıyordu
 * ve aynı iz `carrierCalled=true` diyordu. Sayaçlar denetçinin KENDİ yan
 * etkileriydi; okuyan kişi bunları DENEMENİN özelliği sanıyordu.
 */
export function projectCarrierTruth(stages: unknown): Record<string, unknown> {
  const started = stageData(stages, 'CARRIER_CALL_STARTED')
  const call = stageData(stages, 'CARRIER_CALL')
  const response = stageData(stages, 'CARRIER_RESPONSE')
  // Uygulama istisnası AYRI okunur: taşıyıcı yanıtı yerine geçmez.
  const appException = stageData(stages, 'APPLICATION_EXCEPTION')
  const final = stageData(stages, 'FINAL')
  const pick = (key: string): unknown =>
    response?.[key] ?? appException?.[key] ?? final?.[key] ?? call?.[key]
      ?? WIRE_FIELD_ABSENT
  return {
    carrierCallStarted: started !== null,
    carrierCalled: response?.carrierCalled ?? appException?.carrierCalled
      ?? final?.carrierCalled ?? false,
    // TAŞIYICI KONUŞTU MU? Uygulama istisnası "hayır"dır. `carrierCalled`
    // (ağ sınırı geçildi) ile KARIŞTIRILAMAZ.
    carrierBusinessResponseReceived: response !== null
      && response?.carrierBusinessResponseReceived !== false,
    applicationException: appException !== null,
    carrierCreateAttempts:
      response?.createCallCount ?? call?.attempts ?? WIRE_FIELD_ABSENT,
    carrierCreateStatus: pick('carrierCreateStatus'),
    businessResult: pick('businessResult'),
    carrierCode: pick('carrierCode'),
    carrierMessage: pick('carrierMessage'),
    trackingPresent: pick('trackingPresent'),
    barcodePresent: pick('barcodePresent'),
    zplPresent: pick('zplPresent'),
    zplLength: pick('zplLength'),
    verificationStage: pick('verificationStage'),
    carrierExceptionSummary: pick('carrierExceptionSummary'),
    finalState: final?.outcome ?? WIRE_FIELD_ABSENT,
  }
}
