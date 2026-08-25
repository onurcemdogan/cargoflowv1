// SÜRAT — KAYIT DOĞRULAMA KAPISI (REST kaydı → salt-okunur teyit → barkod).
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// `docs/surat-service-map.md` (17 Temmuz 2026 canlı ayrım testi): tek başına
// çağrılan `OrtakBarkodOlustur` `013` + aday T.No + aday BarkodNo + teknik ZPL
// döndürdü, ama AYNI `OzelKargoTakipNo` için dört salt-okunur sorgu da kayıt
// bulamadı (`Gonderiler=0`, satır yok, satır yok, 90 gün eşleşme yok) — aynı
// kimlikle bilinen kontrol kaydı ise dördünde de bulundu.
//
// Yani barkod operasyonu, taşıyıcıda GÖNDERİ KAYDI OLMADAN etiket üretebilir.
// Etiketi basıp kuryeye paket vermek, kayıtsız bir gönderi demektir.
//
// Bu yüzden barkod adımı YALNIZ kayıt salt-okunur teyit edildikten sonra
// çalışır. Eşik de aynı belgeden gelir (satır 148 ve 232): ilk 30 dakika
// "görünmedi" kayıt YOKLUĞUNU kanıtlamaz.

/** Kanıt: docs/surat-service-map.md — 30 dakika altı kayıt yokluğu KANIT DEĞİL. */
export const REGISTRATION_VISIBILITY_THRESHOLD_MS = 30 * 60 * 1000

export const REGISTRATION_VERIFICATION_STATES = [
  // Kayıt salt-okunur serviste GÖRÜLDÜ; barkod adımı açılır.
  'VERIFIED_CONTINUE',
  // Henüz görünmedi ama eşik dolmadı — kayıt olmadığı KANITLANMADI.
  'PENDING_REGISTRATION_VERIFICATION',
  // Eşik doldu ve hâlâ görünmüyor: güvenli terminal durum.
  'LABEL_CREATED_NOT_REGISTERED',
  // Sorgu başarısız / kimlik uyuşmadı: FAIL-CLOSED.
  'VERIFICATION_FAILED_CLOSED',
  // Kayıt kabul edilmedi: zaten barkod adımına gidilmez.
  'REGISTRATION_NOT_ACCEPTED',
] as const

export type RegistrationVerificationState =
  (typeof REGISTRATION_VERIFICATION_STATES)[number]

export interface RegistrationVerificationDecision {
  state: RegistrationVerificationState
  /** YALNIZ bu true iken `OrtakBarkodOlustur` çağrılabilir. */
  continueToBarcode: boolean
  shipmentRegistered: boolean
  reason: string
  gonderilerLength: number | null
  elapsedMs: number | null
  thresholdMs: number
}

const decision = (
  state: RegistrationVerificationState,
  reason: string,
  extra: Partial<RegistrationVerificationDecision> = {},
): RegistrationVerificationDecision => ({
  state,
  continueToBarcode: state === 'VERIFIED_CONTINUE',
  shipmentRegistered: state === 'VERIFIED_CONTINUE',
  reason,
  gonderilerLength: extra.gonderilerLength ?? null,
  elapsedMs: extra.elapsedMs ?? null,
  thresholdMs: REGISTRATION_VISIBILITY_THRESHOLD_MS,
})

/**
 * Kayıt sonrası tek karar noktası. Ağ ÇAĞIRMAZ: çağıran salt-okunur sorguyu
 * yapar ve sonucunu buraya verir.
 *
 * `query === null` → sorgu yapılamadı/başarısız: FAIL-CLOSED.
 */
export function resolveRegistrationVerification(params: {
  registrationAccepted: boolean
  query: { ok: boolean; gonderilerLength: number } | null
  registeredAtMs?: number | null
  nowMs: number
  thresholdMs?: number
}): RegistrationVerificationDecision {
  if (!params.registrationAccepted) {
    return decision('REGISTRATION_NOT_ACCEPTED', 'REST kaydı kabul edilmedi.')
  }
  // Sorgu hiç yapılamadıysa ya da hata döndüyse gönderi kaydı KANITLANMADI.
  if (!params.query || params.query.ok !== true) {
    return decision(
      'VERIFICATION_FAILED_CLOSED',
      'Salt-okunur kayıt sorgusu sonuç vermedi; barkod adımı açılmaz.',
    )
  }
  const gonderilerLength = Number(params.query.gonderilerLength)
  if (!Number.isFinite(gonderilerLength) || gonderilerLength < 0) {
    return decision(
      'VERIFICATION_FAILED_CLOSED',
      'Sorgu sonucu okunamadı; barkod adımı açılmaz.',
      { gonderilerLength: null },
    )
  }
  if (gonderilerLength >= 1) {
    return decision(
      'VERIFIED_CONTINUE',
      'Kayıt salt-okunur serviste görüldü.',
      { gonderilerLength },
    )
  }

  const thresholdMs = Number.isFinite(params.thresholdMs)
    ? Number(params.thresholdMs)
    : REGISTRATION_VISIBILITY_THRESHOLD_MS
  const registeredAtMs = Number(params.registeredAtMs)
  // Kayıt zamanı bilinmiyorsa eşiğin dolduğu VARSAYILMAZ; bekleme tarafında
  // kalmak güvenlidir (ikinci create ya da kayıtsız etiket üretmez).
  const elapsedMs = Number.isFinite(registeredAtMs)
    ? params.nowMs - registeredAtMs
    : 0
  if (elapsedMs >= thresholdMs) {
    return decision(
      'LABEL_CREATED_NOT_REGISTERED',
      'Eşik doldu ve kayıt hâlâ görünmüyor; barkod adımı KAPALI.',
      { gonderilerLength, elapsedMs },
    )
  }
  return decision(
    'PENDING_REGISTRATION_VERIFICATION',
    'Kayıt henüz görünmedi; eşik dolmadı. Yeniden create YAPILMAZ.',
    { gonderilerLength, elapsedMs },
  )
}

/**
 * Kimlik denetimi: teyit edilen kayıt BEKLENEN siparişe ait olmalı.
 * `WebSiparisKodu` sipariş numarasıdır; `packageId` DEĞİLDİR.
 */
export function registrationIdentityMatches(params: {
  expectedOrderNumber: unknown
  queriedWebSiparisKodu: unknown
}): boolean {
  const expected = String(params.expectedOrderNumber ?? '').trim()
  const queried = String(params.queriedWebSiparisKodu ?? '').trim()
  return expected.length > 0 && expected === queried
}
