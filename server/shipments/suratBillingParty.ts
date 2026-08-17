// FATURALAMA TARAFI — GÖZLEM MODELİ (Faz 2).
//
// BU MODÜL DAVRANIŞ DEĞİŞTİRMEZ. Kanonik create gövdesine hiçbir alan eklemez,
// kredensiyal seçimini etkilemez, idempotency kimliğini değiştirmez, baskı
// durumunu etkilemez. Yalnız "kim ödüyor" bilgisini GÖRÜNÜR kılar.
//
// KANITLANMIŞ OPERASYONEL GERÇEK (Sürat getCargo):
//   whoPays = 1 → SUPPLIER/SELLER ÖDER
//   whoPays = 3 → TRENDYOL ÖDER
// Bu eşleme forensic audit'te doğrulandı ve burada tartışılmaz.
//
// EN ÖNEMLİ KURAL — SESSİZ VARSAYIM YOK: kaynak alan yoksa sonuç `UNKNOWN`
// olur. "Alan yoksa Trendyol öder" gibi bir varsayım KANITLANMADIĞI için
// yapılmaz; yanlış varsayım yanlış cariye fatura demektir.

export const BILLING_PARTIES = ['SELLER', 'TRENDYOL', 'UNKNOWN'] as const
export type BillingParty = (typeof BILLING_PARTIES)[number]

// İKİ AYRI SAĞLAYICI SÖZLEŞMESİ — AYNI ENUM SANILMAMALI:
//
//   TRENDYOL (sipariş/paket yükü):
//     `whoPays` OWN PROPERTY ve değeri 1  → satıcı öder
//     `whoPays` property HİÇ YOK          → Trendyol öder
//     diğer her şey (null/""/0/2/3/…)     → UNKNOWN
//
//   SÜRAT (getCargo yanıtı):
//     whoPays = 1 → SUPPLIER/SELLER öder
//     whoPays = 3 → TRENDYOL öder
//
// Trendyol tarafındaki `3` ile Sürat tarafındaki `3` AYNI ŞEY DEĞİLDİR.
export const BILLING_PARTY_SOURCES = [
  'TRENDYOL_WHO_PAYS_EXPLICIT_1',
  'TRENDYOL_WHO_PAYS_ABSENT',
  'TRENDYOL_WHO_PAYS_UNSUPPORTED',
  'SURAT_GET_CARGO',
  'UNKNOWN',
] as const
export type BillingPartySource = (typeof BILLING_PARTY_SOURCES)[number]

/**
 * KANIT SEVİYESİ — sınıflandırmanın kendisi kadar önemlidir.
 *
 * Saklanmış ham yükün, sağlayıcıdan gelen yükle ALAN VARLIĞI bakımından birebir
 * aynı olduğu geçmiş kayıtlar için KANITLANAMAZ. Bu yüzden geçmiş veriden
 * türeyen sonuç `UNVERIFIED_HISTORICAL_RAW`'dır; sözleşme kanıtı DEĞİLDİR.
 */
export const BILLING_EVIDENCE_LEVELS = [
  'CONFIRMED_PROVIDER_CONTRACT',
  'UNVERIFIED_HISTORICAL_RAW',
  'UNKNOWN',
] as const
export type BillingEvidenceLevel = (typeof BILLING_EVIDENCE_LEVELS)[number]

/** Sınıflandırmaya girdi olan yükün GERÇEKTEN ne olduğu. */
export const RAW_DATA_PROVENANCES = [
  'PROVIDER_RAW',
  'NORMALIZED_COPY',
  'RECONSTRUCTED',
  'UNKNOWN',
] as const
export type RawDataProvenance = (typeof RAW_DATA_PROVENANCES)[number]

/** Ham yükün okunabilirliği — "alan yok" ile "yük yok" AYNI DEĞİL. */
export const RAW_PAYLOAD_AVAILABILITIES = [
  'AVAILABLE',
  'MISSING',
  'UNREADABLE',
] as const
export type RawPayloadAvailability = (typeof RAW_PAYLOAD_AVAILABILITIES)[number]

export const BILLING_VERIFICATION_STATUSES = [
  'VERIFIED',
  'MISMATCH',
  'UNVERIFIED',
] as const
export type BillingVerificationStatus =
  (typeof BILLING_VERIFICATION_STATUSES)[number]

/** Sürat getCargo `whoPays` ham değerleri (string/number karışık gelir). */
export const SURAT_WHO_PAYS_SELLER = '1'
export const SURAT_WHO_PAYS_TRENDYOL = '3'

const text = (value: unknown): string => String(value ?? '').trim()

/**
 * SÜRAT whoPays → faturalama tarafı.
 *
 * `1`/`"1"` ve `3`/`"3"` dışındaki her şey `UNKNOWN`'dır; bilinmeyen bir kodu
 * tahminle bir tarafa yazmak sessiz yanlış faturalama üretirdi.
 */
export function normalizeSuratWhoPays(value: unknown): BillingParty {
  const token = text(value)
  if (token === SURAT_WHO_PAYS_SELLER) return 'SELLER'
  if (token === SURAT_WHO_PAYS_TRENDYOL) return 'TRENDYOL'
  return 'UNKNOWN'
}

/**
 * SÖZLEŞME ALANI — TEK. `whoPays` dışındaki hiçbir alan taraf BELİRLEMEZ.
 *
 * Önceki tur `payer`/`sellerPays` adlarını da taraf kararına sokuyordu; bunlar
 * KANITLANMAMIŞ tahminlerdi. Sözleşme artık `whoPays` VARLIĞINA dayandığı için
 * ikisi bir arada TUTARSIZ olurdu: `whoPays` yokken `payer=SELLER` görmek hem
 * "Trendyol öder" (varlık kuralı) hem "satıcı öder" (alan kuralı) derdi.
 * Bu yüzden aşağıdaki alanlar YALNIZ gözlem olarak raporlanır.
 */
export const TRENDYOL_WHO_PAYS_FIELD = 'whoPays'
export const TRENDYOL_WHO_PAYS_SELLER_VALUE = '1'
export const TRENDYOL_AUXILIARY_PAYER_FIELDS = ['payer', 'sellerPays'] as const

/** `hasOwnProperty` — prototip kirliliği KANIT SAYILMAZ. */
export function hasOwnField(source: unknown, field: string): boolean {
  if (source === null || typeof source !== 'object') return false
  return Object.prototype.hasOwnProperty.call(source, field)
}

export function readOwnField(
  source: unknown,
  field: string,
): { present: boolean; value: unknown } {
  if (!hasOwnField(source, field)) return { present: false, value: undefined }
  return { present: true, value: (source as Record<string, unknown>)[field] }
}

export interface TrendyolWhoPaysClassification {
  /** Sözleşme alanı GERÇEKTEN kendi property'si olarak var mı. */
  rawFieldPresent: boolean
  /** Ham değer — payer kodu; PII DEĞİL. Alan yoksa `null`. */
  rawValue: string | null
  billingParty: BillingParty
  source: BillingPartySource
  interpretation: string
}

/**
 * TRENDYOL SAĞLAYICI SÖZLEŞMESİ — SAF, YAN ETKİSİZ.
 *
 * Girdi DOĞRUDAN sağlayıcı paket yüküdür (`rawOrder`), sarmalayıcı değil.
 *
 * `raw.whoPays ?? …`, `if (!raw.whoPays)`, `raw.whoPays || …` gibi gevşek
 * kalıplar YASAK: hepsi `absent` ile `null`/`0`/`""` ayrımını yok eder ve
 * yanlış cariye fatura demektir. Varlık AÇIKÇA sorulur.
 */
export function classifyTrendyolWhoPays(
  rawOrder: unknown,
): TrendyolWhoPaysClassification {
  const field = readOwnField(rawOrder, TRENDYOL_WHO_PAYS_FIELD)

  if (!field.present) {
    // SÖZLEŞME: alan hiç gönderilmemişse anlaşma Trendyol tarafındadır.
    return {
      rawFieldPresent: false,
      rawValue: null,
      billingParty: 'TRENDYOL',
      source: 'TRENDYOL_WHO_PAYS_ABSENT',
      interpretation:
        'whoPays property YOK (absent) → sağlayıcı sözleşmesine göre Trendyol öder',
    }
  }

  // Değer normalizasyonu: repo genelindeki politika sayı/sayısal metni EŞ
  // sayar. Dizi/boolean/nesne gibi türler `String()` ile "1"e dönüşebildiği
  // için TÜR kontrolü yapılır — `[1]` sözleşme kanıtı DEĞİLDİR.
  const value = field.value
  const scalar =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : null

  if (scalar === TRENDYOL_WHO_PAYS_SELLER_VALUE) {
    return {
      rawFieldPresent: true,
      rawValue: scalar,
      billingParty: 'SELLER',
      source: 'TRENDYOL_WHO_PAYS_EXPLICIT_1',
      interpretation: 'whoPays=1 → satıcı anlaşması, satıcı öder',
    }
  }

  // Alan VAR ama değeri sözleşmede tanımlı değil (null/""/0/2/3/…).
  // ÖZELLİKLE 3: Sürat kodlamasındaki "Trendyol öder" ile AYNI SAYILMAZ.
  return {
    rawFieldPresent: true,
    rawValue: scalar === null ? describeUnsupported(value) : scalar,
    billingParty: 'UNKNOWN',
    source: 'TRENDYOL_WHO_PAYS_UNSUPPORTED',
    interpretation:
      'whoPays alanı VAR fakat değeri sözleşmede tanımlı değil → UNKNOWN',
  }
}

/** Desteklenmeyen değeri PII üretmeden etiketler. */
function describeUnsupported(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * SAKLANAN YÜKÜN KİMLİĞİ — "sağlayıcı ham yükü mü, bizim kopyamız mı".
 *
 * Bu ayrım kritiktir: `whoPays` YOKLUĞU ancak yük GERÇEKTEN sağlayıcı paketi
 * ise "Trendyol öder" anlamına gelir. Normalize edilmiş kopyada zaten hiçbir
 * zaman `whoPays` olmaz; oradan "Trendyol öder" çıkarmak uydurma olurdu.
 */
const NORMALIZED_COPY_MARKERS = [
  'operationStatus',
  'marketplace',
  'customerName',
  'marketplaceStatus',
] as const
const PROVIDER_RAW_MARKERS = [
  'packageId',
  'shipmentPackageId',
  'orderNumber',
  'lines',
  'cargoTrackingNumber',
] as const

export function detectRawPayloadProvenance(rawOrder: unknown): RawDataProvenance {
  if (rawOrder === null || typeof rawOrder !== 'object') return 'UNKNOWN'
  if (NORMALIZED_COPY_MARKERS.some((marker) => hasOwnField(rawOrder, marker))) {
    return 'NORMALIZED_COPY'
  }
  if (PROVIDER_RAW_MARKERS.some((marker) => hasOwnField(rawOrder, marker))) {
    return 'PROVIDER_RAW'
  }
  return 'UNKNOWN'
}

export interface TrendyolBillingSourceInspection {
  /** Sözleşme alanı bulunduysa adı; bulunmadıysa `null`. */
  sourceField: string | null
  rawFieldPresent: boolean
  /** Ham değer — payer kodu; PII DEĞİL. */
  rawValue: string | null
  billingParty: BillingParty
  source: BillingPartySource
  provenance: RawDataProvenance
  rawPayloadAvailability: RawPayloadAvailability
  evidence: BillingEvidenceLevel
  /** Taraf BELİRLEMEYEN yardımcı sinyaller — yalnız gözlem. */
  auxiliarySignals: { field: string; rawValue: string }[]
  /** Neden bu sonuca varıldığı (operatöre gösterilir). */
  interpretation: string
}

/** Sarmalayıcıdan ham yükü ve OKUNABİLİRLİĞİNİ çözer. */
export function resolveRawPayload(order: Record<string, unknown> = {}): {
  raw: unknown
  availability: RawPayloadAvailability
} {
  const declared =
    hasOwnField(order, 'rawOrder') || hasOwnField(order, 'rawPayload')
  if (!declared) return { raw: null, availability: 'MISSING' }
  const raw = hasOwnField(order, 'rawOrder') ? order.rawOrder : order.rawPayload
  if (raw === null || raw === undefined) return { raw: null, availability: 'MISSING' }
  if (typeof raw !== 'object') return { raw, availability: 'UNREADABLE' }
  return { raw, availability: 'AVAILABLE' }
}

/**
 * TEK sipariş üzerinde payer teşhisi — SALT OKUNUR, FAIL-CLOSED.
 *
 * İki farklı "bilmiyorum" ASLA karıştırılmaz:
 *   • yük OKUNAMADI/YOK   → UNKNOWN (alan yokluğu ÇIKARIMI YAPILAMAZ)
 *   • yük VAR, alan YOK   → sözleşme gereği TRENDYOL
 *
 * Ve ÇIKARIM ile DOĞRUDAN KANIT ayrılır:
 *   • alan VARSA          → değer sözleşmesi uygulanır (köken önemsiz;
 *                            `whoPays` yalnız sağlayıcıdan gelebilir)
 *   • alan YOKSA          → "Trendyol öder" ancak yük GERÇEKTEN sağlayıcı
 *                            ham paketi ise geçerlidir; normalize kopyada
 *                            zaten hiç `whoPays` olmaz, oradan çıkarım yapmak
 *                            uydurma olur → UNKNOWN.
 */
export function inspectTrendyolBillingSource(
  order: Record<string, unknown> = {},
  options: {
    rawPayloadAvailability?: RawPayloadAvailability
    /** Yük doğrudan sağlayıcı yanıtından mı geliyor (ingestion sınırı)? */
    origin?: 'LIVE_PROVIDER_RESPONSE' | 'PERSISTED'
  } = {},
): TrendyolBillingSourceInspection {
  const resolved = resolveRawPayload(order)
  const availability = options.rawPayloadAvailability ?? resolved.availability
  const raw = availability === 'AVAILABLE' ? resolved.raw : null
  const provenance =
    availability === 'AVAILABLE' ? detectRawPayloadProvenance(raw) : 'UNKNOWN'
  const auxiliarySignals = collectAuxiliaryPayerSignals(raw)

  if (availability !== 'AVAILABLE') {
    return {
      sourceField: null,
      rawFieldPresent: false,
      rawValue: null,
      billingParty: 'UNKNOWN',
      source: 'UNKNOWN',
      provenance,
      rawPayloadAvailability: availability,
      evidence: 'UNKNOWN',
      auxiliarySignals,
      interpretation:
        availability === 'MISSING'
          ? 'Ham sağlayıcı yükü kayıtta YOK → alan yokluğu ÇIKARIMI YAPILAMAZ'
          : 'Ham sağlayıcı yükü OKUNAMADI → alan yokluğu ÇIKARIMI YAPILAMAZ',
    }
  }

  const contract = classifyTrendyolWhoPays(raw)
  const evidence: BillingEvidenceLevel =
    options.origin === 'LIVE_PROVIDER_RESPONSE'
      ? 'CONFIRMED_PROVIDER_CONTRACT'
      : provenance === 'PROVIDER_RAW'
        ? 'UNVERIFIED_HISTORICAL_RAW'
        : 'UNKNOWN'

  // Alan YOK + yük sağlayıcı ham paketi DEĞİL → çıkarım geçersiz.
  if (!contract.rawFieldPresent && provenance !== 'PROVIDER_RAW') {
    return {
      sourceField: null,
      rawFieldPresent: false,
      rawValue: null,
      billingParty: 'UNKNOWN',
      source: 'UNKNOWN',
      provenance,
      rawPayloadAvailability: availability,
      evidence: 'UNKNOWN',
      auxiliarySignals,
      interpretation:
        `Saklanan yük sağlayıcı ham paketi olarak DOĞRULANAMADI (${provenance}) → ` +
        'alan yokluğundan Trendyol çıkarımı YAPILMADI',
    }
  }

  return {
    sourceField: contract.rawFieldPresent ? TRENDYOL_WHO_PAYS_FIELD : null,
    rawFieldPresent: contract.rawFieldPresent,
    rawValue: contract.rawValue,
    billingParty: contract.billingParty,
    source: contract.source,
    provenance,
    rawPayloadAvailability: availability,
    evidence,
    auxiliarySignals,
    interpretation: contract.interpretation,
  }
}

/**
 * Yardımcı payer sinyalleri — RAPORLANIR, TARAF BELİRLEMEZ.
 *
 * Sözleşme yalnız `whoPays` üzerindedir; bunlar ileride bir kanıt çıkarsa
 * görülebilsin diye gözlemde tutulur.
 */
function collectAuxiliaryPayerSignals(
  raw: unknown,
): { field: string; rawValue: string }[] {
  const signals: { field: string; rawValue: string }[] = []
  for (const field of TRENDYOL_AUXILIARY_PAYER_FIELDS) {
    const found = readOwnField(raw, field)
    if (!found.present) continue
    signals.push({
      field,
      rawValue: found.value === null ? 'null' : text(found.value) || 'empty',
    })
  }
  return signals
}

/** Siparişten BEKLENEN faturalama tarafı — yalnız gözlem içindir. */
export function deriveExpectedBillingParty(
  order: Record<string, unknown> = {},
  options: {
    rawPayloadAvailability?: RawPayloadAvailability
    origin?: 'LIVE_PROVIDER_RESPONSE' | 'PERSISTED'
  } = {},
): {
  billingParty: BillingParty
  source: BillingPartySource
  evidence: BillingEvidenceLevel
  provenance: RawDataProvenance
} {
  const inspection = inspectTrendyolBillingSource(order, options)
  return {
    billingParty: inspection.billingParty,
    source: inspection.source,
    evidence: inspection.evidence,
    provenance: inspection.provenance,
  }
}

/**
 * BEKLENEN ile GERÇEK karşılaştırması — İKİ AYRI KAYNAĞIN ROLÜ.
 *
 *   BEKLENEN (expected) → TRENDYOL sipariş yükü, create ÖNCESİ bilinir.
 *   GERÇEK   (actual)   → SÜRAT getCargo, create SONRASI doğrulanır.
 *
 * Eşleşme tablosu:
 *   expected TRENDYOL + actual 3 → VERIFIED
 *   expected SELLER   + actual 1 → VERIFIED
 *   expected TRENDYOL + actual 1 → MISMATCH
 *   expected SELLER   + actual 3 → MISMATCH
 *
 * getCargo sözleşmesi henüz elde olmadığı için `actual` bugün UNKNOWN kalır;
 * bu bir eksiklik olarak GÖRÜNÜR tutulur, gizlenmez.
 *
 * Taraflardan biri `UNKNOWN` ise sonuç `UNVERIFIED`'dır — "bilmiyorum" asla
 * "doğru" sayılmaz.
 */
export function compareBillingParty(
  expected: BillingParty,
  actual: BillingParty,
): BillingVerificationStatus {
  if (expected === 'UNKNOWN' || actual === 'UNKNOWN') return 'UNVERIFIED'
  return expected === actual ? 'VERIFIED' : 'MISMATCH'
}

export interface BillingObservation {
  expectedBillingParty: BillingParty
  expectedBillingPartySource: BillingPartySource
  /** BEKLENEN tarafın kanıt gücü — sınıflandırmadan AYRI raporlanır. */
  expectedBillingEvidence: BillingEvidenceLevel
  expectedRawProvenance: RawDataProvenance
  actualSuratWhoPays: string | null
  actualBillingParty: BillingParty
  actualBillingPartySource: BillingPartySource
  senderCode: string | null
  billingVerificationStatus: BillingVerificationStatus
}

/**
 * Gözlem kaydı — SADECE operasyonel payer verisi.
 * Müşteri adı/adres/telefon/e-posta ve kimlik bilgisi GİRMEZ.
 */
export function buildBillingObservation(params: {
  order?: Record<string, unknown>
  suratWhoPays?: unknown
  senderCode?: unknown
  rawPayloadAvailability?: RawPayloadAvailability
  origin?: 'LIVE_PROVIDER_RESPONSE' | 'PERSISTED'
}): BillingObservation {
  const expected = deriveExpectedBillingParty(params.order ?? {}, {
    rawPayloadAvailability: params.rawPayloadAvailability,
    origin: params.origin,
  })
  const hasActual = text(params.suratWhoPays) !== ''
  const actualBillingParty = hasActual
    ? normalizeSuratWhoPays(params.suratWhoPays)
    : 'UNKNOWN'
  return {
    expectedBillingParty: expected.billingParty,
    expectedBillingPartySource: expected.source,
    expectedBillingEvidence: expected.evidence,
    expectedRawProvenance: expected.provenance,
    actualSuratWhoPays: hasActual ? text(params.suratWhoPays) : null,
    actualBillingParty,
    actualBillingPartySource: hasActual ? 'SURAT_GET_CARGO' : 'UNKNOWN',
    senderCode: text(params.senderCode) || null,
    billingVerificationStatus: compareBillingParty(
      expected.billingParty,
      actualBillingParty,
    ),
  }
}

/* ═══ ADAY TARAMA + ÇİFT BULMA (Faz 3) ═════════════════════════════════ */

export interface BillingCandidate {
  packageIdMasked: string
  rawSourceField: string | null
  rawValue: string | null
  expectedBillingParty: BillingParty
  /** Semantik katman — HAM gözlemden AYRI tutulur. */
  expectedBillingPartySource?: BillingPartySource
  expectedBillingEvidence?: BillingEvidenceLevel
  expectedRawProvenance?: RawDataProvenance
  credentialClass: string
  accountFingerprint: string
  serviceMode: string
  actualSuratWhoPays: string | null
  actualBillingParty: BillingParty
  senderCode: string | null
}

/** Nedensellik testi için karşılaştırma bağlamı — SIRA ÖNEMLİ. */
export function billingGroupKey(candidate: {
  credentialClass?: unknown
  accountFingerprint?: unknown
  serviceMode?: unknown
}): string {
  return [
    text(candidate.credentialClass) || 'UNKNOWN',
    text(candidate.accountFingerprint) || 'UNKNOWN',
    text(candidate.serviceMode) || 'UNKNOWN',
  ].join('::')
}

export interface BillingScanSummary {
  sampledOrders: number
  // ── HAM GÖZLEM (veri) — yorum İÇERMEZ, asla silinmez.
  rawWhoPays1Count: number
  rawMissingCount: number
  rawOtherCount: number
  // ── SEMANTİK SINIFLANDIRMA (yorum) — sağlayıcı sözleşmesinden TÜRETİLİR.
  expectedSellerPaysCount: number
  expectedTrendyolPaysCount: number
  expectedUnknownCount: number
  expectedSourceExplicit1Count: number
  expectedSourceAbsentCount: number
  expectedSourceUnsupportedCount: number
  /** Kanıt seviyesi dağılımı — "kaç tanesi gerçekten kanıtlı". */
  evidenceLevels: Record<string, number>
  /** Sınıflandırmaya giren yükün kökeni. */
  rawProvenances: Record<string, number>
  credentialClasses: Record<string, number>
  /** Aynı bağlamda gözlenen gerçek whoPays kümeleri. */
  groups: {
    groupKey: string
    credentialClass: string
    accountFingerprint: string
    serviceMode: string
    observedWhoPays: string[]
    orderCount: number
  }[]
  /**
   * AYNI kredensiyal bağlamında hem 1 hem 3 görüldü mü?
   *
   * Görüldüyse "ödeyen tarafı yalnız kredensiyal belirler" hipotezi ÇÜRÜR:
   * aynı hesap iki farklı sonuç üretmiş demektir.
   */
  sameAccountBothWhoPays: boolean
  credentialOnlyCausation: 'REFUTED' | 'UNRESOLVED'
}

/** Adaylardan nedensellik özeti üretir — SAF, ağ/DB YOK. */
export function summarizeBillingScan(
  candidates: readonly BillingCandidate[],
): BillingScanSummary {
  const credentialClasses: Record<string, number> = {}
  const evidenceLevels: Record<string, number> = {}
  const rawProvenances: Record<string, number> = {}
  const grouped = new Map<
    string,
    { candidate: BillingCandidate; whoPays: Set<string>; count: number }
  >()
  let rawWhoPays1Count = 0
  let rawMissingCount = 0
  let rawOtherCount = 0
  let expectedSellerPaysCount = 0
  let expectedTrendyolPaysCount = 0
  let expectedUnknownCount = 0
  let expectedSourceExplicit1Count = 0
  let expectedSourceAbsentCount = 0
  let expectedSourceUnsupportedCount = 0

  for (const candidate of candidates) {
    const cls = text(candidate.credentialClass) || 'UNKNOWN'
    credentialClasses[cls] = (credentialClasses[cls] ?? 0) + 1

    // HAM GÖZLEM — sözleşme yorumundan BAĞIMSIZ sayılır.
    if (candidate.rawSourceField === null) rawMissingCount += 1
    else if (candidate.rawValue === '1') rawWhoPays1Count += 1
    else rawOtherCount += 1

    // SEMANTİK SINIFLANDIRMA — ham sayaçları DEĞİŞTİRMEZ.
    if (candidate.expectedBillingParty === 'SELLER') expectedSellerPaysCount += 1
    else if (candidate.expectedBillingParty === 'TRENDYOL') {
      expectedTrendyolPaysCount += 1
    } else expectedUnknownCount += 1

    if (candidate.expectedBillingPartySource === 'TRENDYOL_WHO_PAYS_EXPLICIT_1') {
      expectedSourceExplicit1Count += 1
    } else if (candidate.expectedBillingPartySource === 'TRENDYOL_WHO_PAYS_ABSENT') {
      expectedSourceAbsentCount += 1
    } else if (
      candidate.expectedBillingPartySource === 'TRENDYOL_WHO_PAYS_UNSUPPORTED'
    ) {
      expectedSourceUnsupportedCount += 1
    }

    const evidence = candidate.expectedBillingEvidence ?? 'UNKNOWN'
    evidenceLevels[evidence] = (evidenceLevels[evidence] ?? 0) + 1
    const provenance = candidate.expectedRawProvenance ?? 'UNKNOWN'
    rawProvenances[provenance] = (rawProvenances[provenance] ?? 0) + 1

    const key = billingGroupKey(candidate)
    const entry = grouped.get(key) ?? {
      candidate,
      whoPays: new Set<string>(),
      count: 0,
    }
    entry.count += 1
    if (candidate.actualSuratWhoPays) entry.whoPays.add(candidate.actualSuratWhoPays)
    grouped.set(key, entry)
  }

  const groups = [...grouped.entries()].map(([groupKey, entry]) => ({
    groupKey,
    credentialClass: text(entry.candidate.credentialClass) || 'UNKNOWN',
    accountFingerprint: text(entry.candidate.accountFingerprint) || 'UNKNOWN',
    serviceMode: text(entry.candidate.serviceMode) || 'UNKNOWN',
    observedWhoPays: [...entry.whoPays].sort(),
    orderCount: entry.count,
  }))

  const sameAccountBothWhoPays = groups.some(
    (group) =>
      group.observedWhoPays.includes(SURAT_WHO_PAYS_SELLER) &&
      group.observedWhoPays.includes(SURAT_WHO_PAYS_TRENDYOL),
  )

  return {
    sampledOrders: candidates.length,
    rawWhoPays1Count,
    rawMissingCount,
    rawOtherCount,
    expectedSellerPaysCount,
    expectedTrendyolPaysCount,
    expectedUnknownCount,
    expectedSourceExplicit1Count,
    expectedSourceAbsentCount,
    expectedSourceUnsupportedCount,
    evidenceLevels,
    rawProvenances,
    credentialClasses,
    groups,
    sameAccountBothWhoPays,
    // Kanıt yoksa "doğrulandı" DEMEZ; yalnız çürütme kesin sonuçtur.
    credentialOnlyCausation: sameAccountBothWhoPays ? 'REFUTED' : 'UNRESOLVED',
  }
}
