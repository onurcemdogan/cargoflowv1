// ARAS — CREATE SONRASI DOĞRULAMA (saf karar; ağ YOK).
//
// KAYNAK: resmî test servisi okuma uçları, doğrulama 2026-08-19:
//   GetCargoInfo · GetCargoTransaction · GetCargoSearch · GetCargoSearchByCode
//   · GetCargoTransactionByWaybillId · GetOrderWithIntegrationCode
//
// ═══ HEPSİ ÇAĞRILMAZ ═════════════════════════════════════════════════════
// "Ne olur ne olmaz" diye altı ucu birden çağırmak, taşıyıcıya gereksiz yük
// bindirir ve çelişen yanıtlar arasında hangisinin otorite olduğu sorusunu
// doğurur. Doğrulama TEK ve KARARLI bir korelasyon anahtarı üzerinden yürür:
// `IntegrationCode` — çünkü create'i biz o kodla açtık ve
// `GetOrderWithIntegrationCode` doğrudan onu kabul eder.
//
// ═══ SÜRAT'A BAĞLANMAZ ═══════════════════════════════════════════════════
// Sürat'ın durum makinesi (aday T.No/barkod, tesellüm, `FAILED_SAFE`) Sürat
// sözleşmesine özeldir. Buradaki makine ONA BENZER ama ondan TÜRETİLMEZ:
// paylaşılan tek şey ilkedir — "bilinmiyor" ≠ "oldu".

import { ARAS_VERIFICATION_REQUEST_FIELDS } from './arasContract.ts'
import { buildArasSoap11Envelope, escapeArasXml } from './arasSoapXml.ts'

export const ARAS_VERIFICATION_STATES = [
  'CREATE_SUBMITTED',
  'CREATE_REJECTED',
  'VERIFICATION_PENDING',
  'VERIFIED_REGISTERED',
  'VERIFICATION_UNKNOWN',
] as const

export type ArasVerificationState = (typeof ARAS_VERIFICATION_STATES)[number]

/** Doğrulama için KULLANILAN tek uç — diğerleri bilerek çağrılmaz. */
export const ARAS_VERIFICATION_OPERATION = 'GetOrderWithIntegrationCode'

export interface ArasVerificationResult {
  state: ArasVerificationState
  /** Taşıyıcıda kayıt KANITLANDI mı? Yalnız kanıtlıysa true. */
  registered: boolean
  integrationCode: string
  resultCode: string
  resultMessage: string
  reason: string
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/**
 * Create sonucunu doğrulama durumuna çevirir.
 *
 * Reddedilen create doğrulamaya GİRMEZ. Kabul edilen create ise HENÜZ
 * "kayıtlı" DEĞİLDİR: yalnız gönderildi. Kayıt iddiası ancak okuma ucu
 * kanıtladığında kurulur.
 */
export function startArasVerification(params: {
  integrationCode?: string | null
  setOrderOk?: boolean
  resultCode?: string | null
  resultMessage?: string | null
}): ArasVerificationResult {
  const integrationCode = str(params.integrationCode)
  const base = {
    integrationCode,
    resultCode: str(params.resultCode),
    resultMessage: str(params.resultMessage),
  }
  if (params.setOrderOk !== true) {
    return {
      ...base, state: 'CREATE_REJECTED', registered: false,
      reason: 'SetOrder kabul edilmedi; doğrulama yapılmaz.',
    }
  }
  if (!integrationCode) {
    return {
      ...base, state: 'VERIFICATION_UNKNOWN', registered: false,
      reason: 'Korelasyon anahtarı yok; kayıt DOĞRULANAMAZ.',
    }
  }
  return {
    ...base, state: 'CREATE_SUBMITTED', registered: false,
    reason: 'SetOrder kabul edildi; taşıyıcı kaydı henüz doğrulanmadı.',
  }
}

/**
 * Okuma ucu yanıtını uygular.
 *
 * FAIL-CLOSED: yanıt okunamıyor, boş geliyor ya da anlaşılmıyorsa sonuç
 * `VERIFICATION_UNKNOWN`dur — `VERIFIED_REGISTERED` DEĞİL. "Bilinmiyor"u
 * "kayıtlı" saymak, açılmamış bir gönderiyi açılmış göstermek olurdu.
 */
export function applyArasVerificationLookup(params: {
  current: ArasVerificationResult
  found?: boolean
  lookupOk?: boolean
  resultCode?: string | null
  resultMessage?: string | null
}): ArasVerificationResult {
  const current = params.current
  if (current.state === 'CREATE_REJECTED') return current

  const next = {
    ...current,
    resultCode: str(params.resultCode) || current.resultCode,
    resultMessage: str(params.resultMessage) || current.resultMessage,
  }
  if (params.lookupOk !== true) {
    return {
      ...next, state: 'VERIFICATION_UNKNOWN', registered: false,
      reason: 'Doğrulama sorgusu sonuçlanmadı; kayıt VARSAYILMAZ.',
    }
  }
  if (params.found === true) {
    return {
      ...next, state: 'VERIFIED_REGISTERED', registered: true,
      reason: 'Taşıyıcı kaydı IntegrationCode ile doğrulandı.',
    }
  }
  if (params.found === false) {
    return {
      ...next, state: 'VERIFICATION_PENDING', registered: false,
      reason: 'Kayıt henüz görünmüyor; tekrar sorgulanabilir.',
    }
  }
  return {
    ...next, state: 'VERIFICATION_UNKNOWN', registered: false,
    reason: 'Yanıt kayıt varlığını bildirmedi.',
  }
}

export interface ArasVerificationEnvelopeBuildResult {
  ok: boolean
  envelope: string
  errorCode: 'ARAS_CREDENTIALS_INCOMPLETE' | 'ARAS_INTEGRATION_CODE_REQUIRED' | null
  reason: string | null
}

/**
 * GetOrderWithIntegrationCode SOAP 1.1 zarfı — resmî TEST şeması (2026-09-27).
 * Alan sırası ve büyük/küçük harf DEĞİŞTİRİLMEZ.
 */
export function buildArasGetOrderWithIntegrationCodeEnvelope(params: {
  credentials?: { userName?: string | null; password?: string | null }
  integrationCode?: string | null
}): ArasVerificationEnvelopeBuildResult {
  const userName = str(params.credentials?.userName)
  const password = str(params.credentials?.password)
  const integrationCode = str(params.integrationCode)
  if (!userName || !password) {
    return {
      ok: false, envelope: '',
      errorCode: 'ARAS_CREDENTIALS_INCOMPLETE',
      reason: 'Aras kullanıcı adı/parolası eksik.',
    }
  }
  if (!integrationCode) {
    return {
      ok: false, envelope: '',
      errorCode: 'ARAS_INTEGRATION_CODE_REQUIRED',
      reason: 'IntegrationCode olmadan doğrulama yapılamaz.',
    }
  }
  const values: Record<string, string> = {
    userName,
    password,
    integrationCode,
  }
  const inner = ARAS_VERIFICATION_REQUEST_FIELDS.map(
    (field) => `      <${field}>${escapeArasXml(values[field])}</${field}>`,
  )
  return {
    ok: true,
    envelope: buildArasSoap11Envelope('GetOrderWithIntegrationCode', inner),
    errorCode: null,
    reason: null,
  }
}

/**
 * Taşıma katmanı yanıtından kayıt bulundu mu — yalnız kanıtlı IntegrationCode.
 */
export function resolveArasVerificationTransport(params: {
  transportOk: boolean
  requestedIntegrationCode: string
  raw: Record<string, unknown> | null
}): { lookupOk: boolean; found: boolean | null } {
  if (params.transportOk !== true) {
    return { lookupOk: false, found: null }
  }
  const requested = str(params.requestedIntegrationCode)
  const seen = str(params.raw?.IntegrationCode)
  if (!requested) return { lookupOk: true, found: false }
  if (!seen) return { lookupOk: true, found: false }
  return { lookupOk: true, found: seen === requested }
}
