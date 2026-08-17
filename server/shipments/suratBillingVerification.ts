// FATURALAMA DOĞRULAMA DURUM MAKİNESİ — SAF, AĞSIZ, YAN ETKİSİZ.
//
// EN KRİTİK KURAL: UNVERIFIED != VERIFIED.
// Barkod/T.No gelmiş olması faturalamanın doğru tarafa yazıldığını KANITLAMAZ.
// Bu modül taşıyıcı başarısını faturalama doğruluğundan AYIRIR.
//
// İKİ AYRI SAĞLAYICI NAMESPACE'İ — BİRLEŞTİRİLMEZ:
//   BEKLENEN  Trendyol sipariş yükü  → `classifyTrendyolWhoPays`
//             (absent → TRENDYOL, 1 → SELLER)
//   GERÇEK    Sürat getCargo yanıtı  → `normalizeSuratWhoPays`
//             (1 → SELLER, 3 → TRENDYOL)
// Aynı sayı iki sözleşmede FARKLI anlama gelir.
//
// NOT (bilinçli tasarım kararı): Sürat tarafındaki eşleme hâlâ
// `suratBillingParty.ts` içinde durur. Ayrı dosyaya taşımak, Trendyol
// sözleşme modülünü geri import etmeye zorlardı ve o modülün testle kilitli
// SIFIR BAĞIMLILIK özelliğini bozardı. Namespace ayrımı bu yüzden dosya
// sınırıyla değil, ayrı isimler + çakışma testiyle korunur.
import {
  compareBillingParty,
  normalizeSuratWhoPays,
  type BillingEvidenceLevel,
  type BillingParty,
  type BillingPartySource,
} from './suratBillingParty.ts'

/**
 * `UNKNOWN` ARAÇ KUSURUNU SEMANTİK SONUÇTAN AYIRIR.
 *
 * ÜRETİMDE ÇÖKTÜ: gönderi eşleşmesi kurulamadığında tarayıcı her kaydı
 * "create başlamadı" sayıyordu ve sonuç `NOT_APPLICABLE=500` olarak
 * görünüyordu. Bu, bir join başarısızlığını semantik bir cevap gibi
 * gösterir. Eşleşme kurulamadıysa doğru cevap "bilmiyorum"dur.
 */
export const CARRIER_CREATE_STATUSES = [
  'NOT_STARTED',
  'SUCCESS',
  'FAILED',
  'UNKNOWN',
] as const
export type CarrierCreateStatus = (typeof CARRIER_CREATE_STATUSES)[number]

export const BILLING_EXPECTATION_STATUSES = ['UNKNOWN', 'KNOWN'] as const
export type BillingExpectationStatus =
  (typeof BILLING_EXPECTATION_STATUSES)[number]

/**
 * NOT_APPLICABLE  taşıyıcı kaydı yok/başarısız → faturalama sorusu doğmadı
 * PENDING         gerçek taraf okuması planlandı, henüz sonuçlanmadı
 * UNVERIFIED      karşılaştırma YAPILAMADI (bugünkü üretim durumu)
 * VERIFIED        beklenen ve gerçek UYUŞUYOR
 * MISMATCH        beklenen ve gerçek ÇELİŞİYOR
 * ERROR           gerçek tarafı okuma girişimi HATA verdi
 */
export const BILLING_VERIFICATION_STATES = [
  'NOT_APPLICABLE',
  'PENDING',
  'UNVERIFIED',
  'VERIFIED',
  'MISMATCH',
  'ERROR',
] as const
export type BillingVerificationState =
  (typeof BILLING_VERIFICATION_STATES)[number]

/* ═══ BEKLENEN TARAF — DEĞİŞMEZ ANLIK GÖRÜNTÜ ══════════════════════════ */

/**
 * Create anında (veya hemen öncesinde) alınan BEKLENTİ.
 *
 * Neden anlık görüntü: gerçek taraf aylar sonra okunabilir. O anda siparişi
 * yeniden yorumlayıp beklentiyi güncellersek "o gün ne bekliyorduk"
 * sorusunu sonsuza dek kaybederiz ve uyuşmazlık sessizce kaybolur.
 * `capturedAt` ÇAĞIRAN tarafından verilir — bu modül saat OKUMAZ.
 */
export interface BillingExpectationSnapshot {
  expectedParty: BillingParty
  expectedSource: BillingPartySource
  expectedEvidence: BillingEvidenceLevel
  capturedAt: string
}

export function buildBillingExpectationSnapshot(params: {
  expectedParty: BillingParty
  expectedSource: BillingPartySource
  expectedEvidence: BillingEvidenceLevel
  capturedAt: string
}): BillingExpectationSnapshot {
  return {
    expectedParty: params.expectedParty,
    expectedSource: params.expectedSource,
    expectedEvidence: params.expectedEvidence,
    capturedAt: params.capturedAt,
  }
}

export function billingExpectationStatus(
  snapshot: BillingExpectationSnapshot | null,
): BillingExpectationStatus {
  return snapshot && snapshot.expectedParty !== 'UNKNOWN' ? 'KNOWN' : 'UNKNOWN'
}

/* ═══ GERÇEK TARAF — SAĞLAYICI OKUMASI ═════════════════════════════════ */

export const BILLING_ACTUAL_READ_STATUSES = [
  'OK',
  'PENDING',
  'NOT_CONFIGURED',
  'CONTRACT_UNAVAILABLE',
  'FAILED',
] as const
export type BillingActualReadStatus =
  (typeof BILLING_ACTUAL_READ_STATUSES)[number]

export interface BillingActualReading {
  status: BillingActualReadStatus
  /** Sürat ham kodu (`1`/`3`/…) — PII DEĞİL. */
  actualWhoPays: string | null
  actualParty: BillingParty
  senderCode: string | null
  evidence: 'SURAT_GET_CARGO' | 'UNKNOWN'
}

/**
 * SÜRAT getCargo yanıtından gerçek taraf okuması üretir.
 *
 * `1`/`3` dışındaki her kod `UNKNOWN`'dır; bilinmeyen bir kodu tahminle bir
 * tarafa yazmak sessiz yanlış faturalama üretirdi.
 */
export function readSuratActualBillingParty(params: {
  whoPays?: unknown
  senderCode?: unknown
}): BillingActualReading {
  const raw = String(params.whoPays ?? '').trim()
  if (!raw) {
    return {
      status: 'FAILED',
      actualWhoPays: null,
      actualParty: 'UNKNOWN',
      senderCode: String(params.senderCode ?? '').trim() || null,
      evidence: 'UNKNOWN',
    }
  }
  return {
    status: 'OK',
    actualWhoPays: raw,
    actualParty: normalizeSuratWhoPays(raw),
    senderCode: String(params.senderCode ?? '').trim() || null,
    evidence: 'SURAT_GET_CARGO',
  }
}

/* ═══ SAĞLAYICI SINIRI — SÖZLEŞME YOKKEN UYDURMA YOK ═══════════════════ */

export interface SuratBillingActualReaderParams {
  organizationId: string
  parcelUniqueId: string
}

export interface SuratBillingActualReader {
  readActualBillingParty(
    params: SuratBillingActualReaderParams,
  ): Promise<BillingActualReading>
}

/**
 * BUGÜNKÜ TEK GERÇEKÇİ UYGULAMA.
 *
 * Sürat getCargo sözleşmesi (taban URL, yol, metod, auth, parametre adı)
 * elde DEĞİLDİR. Tahmini bir adrese istek atmak yanlış sisteme kimlik
 * göndermek demektir; bu yüzden okuyucu AĞA ÇIKMADAN sözleşme yokluğunu
 * bildirir. Sözleşme geldiğinde YALNIZ bu sınıf değişir.
 */
export function createContractUnavailableActualReader(): SuratBillingActualReader {
  return {
    readActualBillingParty: async () => ({
      status: 'CONTRACT_UNAVAILABLE',
      actualWhoPays: null,
      actualParty: 'UNKNOWN',
      senderCode: null,
      evidence: 'UNKNOWN',
    }),
  }
}

/* ═══ DURUM MAKİNESİ ═══════════════════════════════════════════════════ */

export interface BillingVerification {
  expectedParty: BillingParty
  expectedSource: BillingPartySource
  expectedEvidence: BillingEvidenceLevel
  actualParty: BillingParty
  actualSource: 'SURAT_GET_CARGO' | 'UNKNOWN'
  status: BillingVerificationState
  reason: string
}

const UNKNOWN_EXPECTATION: BillingExpectationSnapshot = {
  expectedParty: 'UNKNOWN',
  expectedSource: 'UNKNOWN',
  expectedEvidence: 'UNKNOWN',
  capturedAt: '',
}

/**
 * BEKLENEN ↔ GERÇEK — FAIL-CLOSED.
 *
 * Hiçbir dal "bilmiyorum"u "doğru" saymaz. Karşılaştırma ancak İKİ taraf da
 * bilindiğinde yapılır; aksi hâlde sonuç UNVERIFIED'dır ve bu bir eksiklik
 * olarak GÖRÜNÜR kalır.
 *
 * MISMATCH taşıyıcı create'i BAŞARISIZ SAYMAZ: gönderi gerçekten oluşmuştur,
 * yanlış olan mali semantiğidir.
 */
export function evaluateBillingVerification(params: {
  carrierCreateStatus: CarrierCreateStatus
  expected?: BillingExpectationSnapshot | null
  actual?: BillingActualReading | null
}): BillingVerification {
  const expected = params.expected ?? UNKNOWN_EXPECTATION
  const base = {
    expectedParty: expected.expectedParty,
    expectedSource: expected.expectedSource,
    expectedEvidence: expected.expectedEvidence,
    actualParty: params.actual?.actualParty ?? 'UNKNOWN',
    actualSource: params.actual?.evidence ?? 'UNKNOWN',
  } as const

  // ARAÇ KUSURU SEMANTİK CEVAP GİBİ GÖSTERİLMEZ: taşıyıcı durumu
  // belirlenemediyse sonuç ERROR'dır, "uygulanamaz" DEĞİL.
  if (params.carrierCreateStatus === 'UNKNOWN') {
    return {
      ...base,
      status: 'ERROR',
      reason: 'CARRIER_CREATE_STATUS_UNKNOWN',
    }
  }
  if (params.carrierCreateStatus !== 'SUCCESS') {
    return {
      ...base,
      status: 'NOT_APPLICABLE',
      reason:
        params.carrierCreateStatus === 'NOT_STARTED'
          ? 'CARRIER_CREATE_NOT_STARTED'
          : 'CARRIER_CREATE_FAILED',
    }
  }

  if (params.actual?.status === 'PENDING') {
    return { ...base, status: 'PENDING', reason: 'ACTUAL_READ_PENDING' }
  }
  if (params.actual?.status === 'FAILED') {
    return { ...base, status: 'ERROR', reason: 'ACTUAL_READ_FAILED' }
  }

  // BEKLENEN bilinmiyorsa karşılaştırma ANLAMSIZDIR — gerçek taraf okunmuş
  // olsa bile. Tek taraflı bilgiyi doğrulama saymak fail-open olurdu.
  if (expected.expectedParty === 'UNKNOWN') {
    return { ...base, status: 'UNVERIFIED', reason: 'EXPECTED_PARTY_UNKNOWN' }
  }

  if (!params.actual) {
    return { ...base, status: 'UNVERIFIED', reason: 'ACTUAL_NOT_READ' }
  }
  if (params.actual.status === 'CONTRACT_UNAVAILABLE') {
    return {
      ...base,
      status: 'UNVERIFIED',
      reason: 'ACTUAL_PROVIDER_CONTRACT_UNAVAILABLE',
    }
  }
  if (params.actual.status === 'NOT_CONFIGURED') {
    return { ...base, status: 'UNVERIFIED', reason: 'ACTUAL_READER_NOT_CONFIGURED' }
  }
  if (params.actual.actualParty === 'UNKNOWN') {
    return {
      ...base,
      status: 'UNVERIFIED',
      reason: 'ACTUAL_WHO_PAYS_UNRECOGNIZED',
    }
  }

  const comparison = compareBillingParty(
    expected.expectedParty,
    params.actual.actualParty,
  )
  return comparison === 'VERIFIED'
    ? { ...base, status: 'VERIFIED', reason: 'EXPECTED_MATCHES_ACTUAL' }
    : { ...base, status: 'MISMATCH', reason: 'EXPECTED_DIFFERS_FROM_ACTUAL' }
}

/* ═══ UYUŞMAZLIK KANCASI — HENÜZ YAYIN YOK ═════════════════════════════ */

export interface BillingMismatchEvent {
  organizationId: string
  /** Maskeli/operasyonel kimlik — PII DEĞİL. */
  parcelUniqueId: string | null
  verification: BillingVerification
}

export type BillingMismatchHook = (event: BillingMismatchEvent) => void

/**
 * Varsayılan kanca HİÇBİR ŞEY YAPMAZ.
 *
 * Uyuşmazlık yayınlamak operasyonel bir karardır (alarm, kuyruk, ticket) ve
 * bu tur davranış değiştirmiyor. Arayüz şimdiden duruyor ki gerçek taraf
 * okunabilir hâle geldiğinde bağlanacak yer belirsiz olmasın.
 */
export const noopBillingMismatchHook: BillingMismatchHook = () => undefined

/** Yalnız MISMATCH'te kancayı çağırır; diğer durumlarda sessizdir. */
export function publishBillingMismatch(
  event: BillingMismatchEvent,
  hook: BillingMismatchHook = noopBillingMismatchHook,
): boolean {
  if (event.verification.status !== 'MISMATCH') return false
  hook(event)
  return true
}
