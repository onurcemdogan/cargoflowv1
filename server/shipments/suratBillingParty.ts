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

export const BILLING_PARTY_SOURCES = [
  'TRENDYOL_WHO_PAYS',
  'SURAT_GET_CARGO',
  'UNKNOWN',
] as const
export type BillingPartySource = (typeof BILLING_PARTY_SOURCES)[number]

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

/** Trendyol tarafındaki aday payer alan adları (SIRA ÖNEMLİ). */
export const TRENDYOL_BILLING_SOURCE_FIELDS = [
  'whoPays',
  'payer',
  'sellerPays',
] as const

export interface TrendyolBillingSourceInspection {
  /** Ham kayıtta GERÇEKTEN bulunan alan adı; yoksa `null`. */
  sourceField: string | null
  /** Ham değer — payer kodu; PII DEĞİL. */
  rawValue: string | null
  billingParty: BillingParty
  source: BillingPartySource
  /** Neden bu sonuca varıldığı (operatöre gösterilir). */
  interpretation: string
}

/**
 * TEK sipariş üzerinde payer kaynağı teşhisi — SALT OKUNUR.
 *
 * Alan adı UYDURULMAZ: yalnız ham kayıtta gerçekten bulunan bir alan raporlanır.
 * Hiçbiri yoksa `UNKNOWN` döner ve bu bir HATA DEĞİLDİR — bugünkü CargoFlow
 * zaten Trendyol payer bilgisini okumuyor (forensic audit bulgusu).
 */
export function inspectTrendyolBillingSource(
  order: Record<string, unknown> = {},
): TrendyolBillingSourceInspection {
  const raw = (order.rawOrder ?? order.rawPayload ?? {}) as Record<string, unknown>
  const candidates: Record<string, unknown>[] = [order, raw]

  for (const field of TRENDYOL_BILLING_SOURCE_FIELDS) {
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue
      // Alan GERÇEKTEN var mı — `undefined` bir kanıt değildir.
      const present = Object.prototype.hasOwnProperty.call(candidate, field)
      if (!present) continue
      const value = candidate[field]
      if (value === null || value === undefined || text(value) === '') continue

      // `sellerPays` boolean semantiği: yalnız TRUE bir kanıttır.
      if (field === 'sellerPays') {
        if (value === true || text(value).toLowerCase() === 'true') {
          return {
            sourceField: field,
            rawValue: 'true',
            billingParty: 'SELLER',
            source: 'TRENDYOL_WHO_PAYS',
            interpretation: 'sellerPays=true → satıcı öder',
          }
        }
        continue
      }
      if (field === 'payer') {
        const token = text(value).toUpperCase()
        if (token === 'SELLER' || token === 'SUPPLIER') {
          return {
            sourceField: field,
            rawValue: token,
            billingParty: 'SELLER',
            source: 'TRENDYOL_WHO_PAYS',
            interpretation: `payer=${token} → satıcı öder`,
          }
        }
        if (token === 'TRENDYOL' || token === 'MARKETPLACE') {
          return {
            sourceField: field,
            rawValue: token,
            billingParty: 'TRENDYOL',
            source: 'TRENDYOL_WHO_PAYS',
            interpretation: `payer=${token} → pazaryeri öder`,
          }
        }
        return {
          sourceField: field,
          rawValue: token,
          billingParty: 'UNKNOWN',
          source: 'UNKNOWN',
          interpretation: `payer=${token} tanınmıyor → UNKNOWN`,
        }
      }
      // `whoPays`: Sürat kodlamasıyla AYNI olduğu VARSAYILMAZ. Yalnız
      // `1` kanıtlı satıcı sinyalidir; diğer değerler UNKNOWN kalır.
      const token = text(value)
      if (token === '1') {
        return {
          sourceField: field,
          rawValue: token,
          billingParty: 'SELLER',
          source: 'TRENDYOL_WHO_PAYS',
          interpretation: 'whoPays=1 → satıcı öder',
        }
      }
      return {
        sourceField: field,
        rawValue: token,
        billingParty: 'UNKNOWN',
        source: 'UNKNOWN',
        interpretation: `whoPays=${token} için kanıtlanmış eşleme YOK → UNKNOWN`,
      }
    }
  }

  return {
    sourceField: null,
    rawValue: null,
    billingParty: 'UNKNOWN',
    source: 'UNKNOWN',
    // KRİTİK: "alan yok → Trendyol öder" VARSAYIMI YAPILMAZ.
    interpretation:
      'Ham siparişte payer alanı bulunamadı → UNKNOWN (varsayım yapılmadı)',
  }
}

/** Siparişten BEKLENEN faturalama tarafı — yalnız gözlem içindir. */
export function deriveExpectedBillingParty(
  order: Record<string, unknown> = {},
): { billingParty: BillingParty; source: BillingPartySource } {
  const inspection = inspectTrendyolBillingSource(order)
  return { billingParty: inspection.billingParty, source: inspection.source }
}

/**
 * BEKLENEN ile GERÇEK karşılaştırması.
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
}): BillingObservation {
  const expected = deriveExpectedBillingParty(params.order ?? {})
  const hasActual = text(params.suratWhoPays) !== ''
  const actualBillingParty = hasActual
    ? normalizeSuratWhoPays(params.suratWhoPays)
    : 'UNKNOWN'
  return {
    expectedBillingParty: expected.billingParty,
    expectedBillingPartySource: expected.source,
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
  rawWhoPays1Count: number
  rawMissingCount: number
  rawOtherCount: number
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
  const grouped = new Map<
    string,
    { candidate: BillingCandidate; whoPays: Set<string>; count: number }
  >()
  let rawWhoPays1Count = 0
  let rawMissingCount = 0
  let rawOtherCount = 0

  for (const candidate of candidates) {
    const cls = text(candidate.credentialClass) || 'UNKNOWN'
    credentialClasses[cls] = (credentialClasses[cls] ?? 0) + 1

    if (candidate.rawSourceField === null) rawMissingCount += 1
    else if (candidate.rawValue === '1') rawWhoPays1Count += 1
    else rawOtherCount += 1

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
    credentialClasses,
    groups,
    sameAccountBothWhoPays,
    // Kanıt yoksa "doğrulandı" DEMEZ; yalnız çürütme kesin sonuçtur.
    credentialOnlyCausation: sameAccountBothWhoPays ? 'REFUTED' : 'UNRESOLVED',
  }
}
