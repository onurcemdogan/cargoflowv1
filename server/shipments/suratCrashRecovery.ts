// TAŞIYICI MUTASYONU BAŞLADI, SONUÇ BİLİNMİYOR — ÇÖKME SONRASI DAVRANIŞ.
//
// ═══ ÖLÇÜLEN ÜRETİM OLAYI — CF-4103661055 ════════════════════════════════
//
// İz kanıtı: `CARRIER_CALL_STARTED` yazıldı, `carrierCalled=true`, ama HİÇBİR
// taşıyıcı iş yanıtı yakalanmadı. Süreç şu UYGULAMA istisnasıyla düştü:
//
//   Cannot access 'verifyRegistrationReadOnly' before initialization
//
// Yani: taşıyıcıda mutasyon BAŞLAMIŞ olabilir, yerelde sonuç YOK.
//
// TEHLİKE: kullanıcının bir sonraki tıklaması "yerelde gönderi yok" diye
// İKİNCİ bir `GonderiyiKargoyaGonder` gönderirse MÜKERRER gönderi doğar.
// Geri alınamaz. Bu yüzden "başladı + bilinmiyor" ASLA "yeniden yaratılabilir"
// anlamına GELMEZ; SALT-OKUNUR MUTABAKAT gerektirir.

import {
  resolveRegistrationVerification,
  type RegistrationVerificationDecision,
} from './suratRegistrationVerification.ts'

/** Taşıma bacakları — üstteki `serviceMode` etiketi DEĞİL, gerçek adımlar. */
export const TRANSPORT_LEGS = [
  'REGISTRATION_REST',
  'REGISTRATION_VERIFY',
  'BARCODE_SOAP',
] as const

export type TransportLeg = (typeof TRANSPORT_LEGS)[number]

/** Her bacağın DEĞİŞMEZ nitelikleri. Çağıran bunları geçersiz kılamaz. */
export const TRANSPORT_LEG_CONTRACT: Record<TransportLeg, {
  operation: string
  readOnly: boolean
  carrierStateMutated: boolean
  identitySource: string
}> = {
  // TEK geri alınamaz adım.
  REGISTRATION_REST: {
    operation: 'GonderiyiKargoyaGonder',
    readOnly: false,
    carrierStateMutated: true,
    identitySource: 'packageId',
  },
  // Salt-okunur. Sorgu anahtarı SİPARİŞ NUMARASIDIR (paket kimliği DEĞİL).
  REGISTRATION_VERIFY: {
    operation: 'KargoTakipHareketDetayi',
    readOnly: true,
    carrierStateMutated: false,
    identitySource: 'orderNumber',
  },
  BARCODE_SOAP: {
    operation: 'OrtakBarkodOlustur',
    readOnly: false,
    carrierStateMutated: true,
    identitySource: 'cargoTrackingNumber',
  },
} as const

/** Bacakların ZORUNLU sırası. Atlanamaz, yer değiştiremez. */
export const REQUIRED_TRANSPORT_ORDER: readonly TransportLeg[] = [
  'REGISTRATION_REST', 'REGISTRATION_VERIFY', 'BARCODE_SOAP',
] as const

export const CREATE_RESUME_ACTIONS = [
  // Taşıyıcıya HİÇ çağrı başlamadı: normal create yolu açıktır.
  'SAFE_TO_CREATE',
  // Çağrı BAŞLADI ama sonuç bilinmiyor: önce salt-okunur mutabakat.
  'REQUIRES_READ_ONLY_RECONCILIATION',
] as const

export type CreateResumeAction = (typeof CREATE_RESUME_ACTIONS)[number]

/**
 * Çökme sonrası tek karar noktası.
 *
 * KURAL: `carrierCallStarted` true ve iş yanıtı YOKSA sonuç BİLİNMİYORDUR ve
 * bilinmeyen ASLA ikinci bir create'e dönüştürülmez.
 */
export function resolveCreateResumeAction(params: {
  carrierCallStarted: boolean
  /** Taşıyıcıdan GERÇEK bir iş yanıtı alındı mı? İstisna yanıt DEĞİLDİR. */
  carrierBusinessResponseReceived: boolean
}): { action: CreateResumeAction; reason: string } {
  if (!params.carrierCallStarted) {
    return {
      action: 'SAFE_TO_CREATE',
      reason: 'Taşıyıcıya çağrı başlamadı; taşıyıcı durumu değişmedi.',
    }
  }
  if (params.carrierBusinessResponseReceived) {
    return {
      action: 'SAFE_TO_CREATE',
      reason: 'Taşıyıcı iş yanıtı alındı; sonuç normal yoldan sınıflandırılır.',
    }
  }
  return {
    action: 'REQUIRES_READ_ONLY_RECONCILIATION',
    reason:
      'Taşıyıcı çağrısı başladı fakat iş yanıtı alınmadı. Kayıt oluşmuş '
      + 'OLABİLİR; ikinci create MÜKERRER gönderi yaratır.',
  }
}

export const RECONCILIATION_OUTCOMES = [
  // Kayıt salt-okunur teyit edildi: REST TEKRARLANMADAN barkoda devam.
  'RESUME_AT_BARCODE_SOAP',
  // Eşik dolmadı: kayıt yokluğu KANITLANMADI, tekrar create YOK.
  'PENDING_REGISTRATION_VERIFICATION',
  // Eşik doldu, kayıt görünmüyor: terminal, otomatik replay YOK.
  'LABEL_CREATED_NOT_REGISTERED',
  // Sorgu başarısız / kimlik uyuşmadı: FAIL-CLOSED.
  'FAIL_CLOSED',
] as const

export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number]

export interface ReconciliationDecision {
  outcome: ReconciliationOutcome
  /** YALNIZ bu true iken `OrtakBarkodOlustur` çağrılabilir. */
  resumeToBarcode: boolean
  /** HER ZAMAN false. İkinci `GonderiyiKargoyaGonder` hiçbir dalda AÇILMAZ. */
  replayRegistration: false
  registrationExists: boolean
  identityMatch: boolean
  reason: string
  verification: RegistrationVerificationDecision
}

/**
 * Salt-okunur mutabakat sonucunu karara çevirir. AĞ ÇAĞIRMAZ.
 *
 * `Gonderiler=0` HİÇBİR durumda otomatik REST tekrarına yol açmaz: kaydın
 * taşıyıcıda görünmesi gecikebilir (docs/surat-service-map.md:148,232) ve
 * "görünmüyor" ile "yok" aynı şey DEĞİLDİR.
 */
export function resolveReconciliation(params: {
  query: { ok: boolean; gonderilerLength: number } | null
  identityMatch: boolean
  registeredAtMs?: number | null
  nowMs: number
  thresholdMs?: number
}): ReconciliationDecision {
  const verification = resolveRegistrationVerification({
    // Çağrı BAŞLADIĞI için kaydın kabul edilmiş OLABİLECEĞİ varsayılır;
    // karar YALNIZ salt-okunur sorgunun kanıtına dayanır.
    registrationAccepted: true,
    query: params.query,
    registeredAtMs: params.registeredAtMs ?? null,
    nowMs: params.nowMs,
    thresholdMs: params.thresholdMs,
  })

  const base = {
    replayRegistration: false as const,
    identityMatch: params.identityMatch,
    verification,
  }

  // Kimlik uyuşmuyorsa bulunan kayıt BAŞKA bir gönderi olabilir: FAIL-CLOSED.
  if (verification.state === 'VERIFIED_CONTINUE' && !params.identityMatch) {
    return {
      ...base,
      outcome: 'FAIL_CLOSED',
      resumeToBarcode: false,
      registrationExists: false,
      reason:
        'Kayıt bulundu fakat kimlik eşleşmedi; başka bir gönderi olabilir.',
    }
  }
  if (verification.state === 'VERIFIED_CONTINUE') {
    return {
      ...base,
      outcome: 'RESUME_AT_BARCODE_SOAP',
      resumeToBarcode: true,
      registrationExists: true,
      reason:
        'Kayıt salt-okunur teyit edildi; REST TEKRARLANMADAN barkoda devam.',
    }
  }
  if (verification.state === 'PENDING_REGISTRATION_VERIFICATION') {
    return {
      ...base,
      outcome: 'PENDING_REGISTRATION_VERIFICATION',
      resumeToBarcode: false,
      registrationExists: false,
      reason: verification.reason,
    }
  }
  if (verification.state === 'LABEL_CREATED_NOT_REGISTERED') {
    return {
      ...base,
      outcome: 'LABEL_CREATED_NOT_REGISTERED',
      resumeToBarcode: false,
      registrationExists: false,
      reason: verification.reason,
    }
  }
  return {
    ...base,
    outcome: 'FAIL_CLOSED',
    resumeToBarcode: false,
    registrationExists: false,
    reason: verification.reason,
  }
}

/** Tek bir iz satırından taşıyıcı-çağrısı gerçeği. */
export interface CarrierCallEvidence {
  known: boolean
  carrierCallStarted: boolean
  carrierBusinessResponseReceived: boolean
  traceId: string | null
}

const stageList = (row: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(row?.stages) ? row.stages as Record<string, unknown>[] : []

/**
 * Kalıcı izlerden "bu paket için taşıyıcı çağrısı başladı mı, iş yanıtı geldi
 * mi" sorusunu yanıtlar. AĞ ÇAĞIRMAZ, DB YAZMAZ.
 *
 * NOT — kapsam: bu kapı idempotency katmanının YERİNE GEÇMEZ, onu tamamlar.
 * İz tablosu okunamazsa (`traces === null`) create BLOKLANMAZ: hata ayıklama
 * tablosunun okunamaması yüzünden her create'i durdurmak kendi kendine
 * yaratılmış bir kesinti olurdu ve mükerrer create'i asıl engelleyen
 * idempotency katmanı yerinde durur. Bilinmezlik "çağrı yapılmadı" diye de
 * SUNULMAZ: `known=false` olarak işaretlenir ve yanıtta görünür.
 */
export function readCarrierCallEvidence(
  traces: Record<string, unknown>[] | null,
  packageId: string,
): CarrierCallEvidence {
  const empty = {
    carrierCallStarted: false,
    carrierBusinessResponseReceived: false,
    traceId: null,
  }
  if (traces === null) return { known: false, ...empty }
  const target = String(packageId ?? '').trim()
  if (!target) return { known: false, ...empty }

  for (const row of traces) {
    if (String(row?.packageId ?? '').trim() !== target) continue
    const stages = stageList(row)
    const started = stages.some((entry) => (
      entry?.stage === 'CARRIER_CALL_STARTED' || entry?.stage === 'CARRIER_CALL'
      || (entry?.data as Record<string, unknown> | undefined)
        ?.carrierCalled === true
    ))
    if (!started) continue
    const answered = stages.some((entry) => (
      entry?.stage === 'CARRIER_RESPONSE'
      && (entry?.data as Record<string, unknown> | undefined)
        ?.carrierBusinessResponseReceived !== false
    ))
    // İLK kanıtlı çağrı yeter: sonrası zaten mutabakat konusudur.
    return {
      known: true,
      carrierCallStarted: true,
      carrierBusinessResponseReceived: answered,
      traceId: String(row?.traceId ?? '') || null,
    }
  }
  return { known: true, ...empty }
}
