// TICIMAX SIPARISSERVIS İSTEMCİSİ — YALNIZ OKUMA İSKELETİ; SOAP YOK.
//
// SelectSiparis tel sözleşmesi doğrulanmadan HİÇBİR SOAP gönderilmez.
// UyeKodu loglanmaz ve URL sorgu dizesine KONMAZ.
import {
  assertSelectSiparisWireReady,
  TicimaxWireContractError,
} from './ticimaxWireGate.ts'
import { assertTicimaxWriteDenied } from './ticimaxWriteGuard.ts'
import { TICIMAX_PROVIDER_KEY } from './ticimaxEndpoint.ts'

export { TICIMAX_PROVIDER_KEY }

export const TICIMAX_ERROR_CLASSES = [
  'OK',
  'WIRE_CONTRACT_UNVERIFIED',
  'AUTH',
  'SOAP_FAULT',
  'PROVIDER',
  'NETWORK',
  'MALFORMED_RESPONSE',
  'STORE_URL_REJECTED',
  'WRITE_DENIED',
] as const
export type TicimaxErrorClass = (typeof TICIMAX_ERROR_CLASSES)[number]

const SAFE_MESSAGES: Record<TicimaxErrorClass, string> = {
  OK: 'Bağlantı doğrulandı.',
  WIRE_CONTRACT_UNVERIFIED:
    'SelectSiparis tel sözleşmesi doğrulanmadı; SOAP gönderilmedi.',
  AUTH: 'UyeKodu kabul edilmedi.',
  SOAP_FAULT: 'Ticimax SOAP Fault döndü; sipariş okuma başarısız.',
  PROVIDER: 'Ticimax sunucusu hata döndürdü.',
  NETWORK: 'Ticimax mağazasına ulaşılamadı.',
  MALFORMED_RESPONSE: 'Ticimax yanıtı beklenen biçimde değil.',
  STORE_URL_REJECTED: 'Mağaza adresi güvenlik politikasına uymuyor.',
  WRITE_DENIED: 'Ticimax yazma metodu engellendi.',
}

export function ticimaxSafeMessage(errorClass: TicimaxErrorClass): string {
  return SAFE_MESSAGES[errorClass]
}

export interface TicimaxCredentials {
  storeUrl: string
  /** SIR — loglanmaz, URL'ye konmaz. */
  uyeKodu: string
}

export interface TicimaxClientResult {
  ok: boolean
  errorClass: TicimaxErrorClass
  message: string
  /** Ham siparişler — yalnız başarıda; bu iskelette SOAP yok → daima boş. */
  rawOrders: unknown[]
}

/**
 * SOAP Fault sınıflandırma — Fault ASLA başarılı sipariş okuması sayılmaz.
 *
 * Tel XML üretilmez; verilen gövde metni Fault içeriyorsa başarısız döner.
 * Canlı taşıma bağlandığında aynı sınıflandırıcı kullanılır.
 */
export function classifyTicimaxSoapBody(bodyText: unknown): {
  ok: boolean
  errorClass: TicimaxErrorClass
} {
  const text = String(bodyText ?? '')
  if (/Fault\b/i.test(text) || /<soap:Fault\b/i.test(text) || /<s:Fault\b/i.test(text)) {
    return { ok: false, errorClass: 'SOAP_FAULT' }
  }
  if (text.trim() === '') {
    return { ok: false, errorClass: 'MALFORMED_RESPONSE' }
  }
  return { ok: true, errorClass: 'OK' }
}

/**
 * UyeKodu'nun URL / log yüzüne sızmasını engelleyen savunma yardımcıları.
 * İstemci bilerek sırı sorguya EKLEMEZ; testler bunu kilitler.
 */
export function buildTicimaxRequestUrl(soapEndpointUrl: string): string {
  // Sır ASLA query'ye eklenmez — yalnız sabit HTTPS uç.
  const url = new URL(soapEndpointUrl)
  if (url.protocol !== 'https:') {
    throw new Error('Ticimax SOAP ucu HTTPS olmalıdır.')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('Ticimax SOAP ucunda sorgu/fragment yasaktır.')
  }
  return url.toString()
}

export function redactUyeKoduFromText(text: unknown, uyeKodu: unknown): string {
  const raw = String(text ?? '')
  const secret = String(uyeKodu ?? '')
  if (secret === '') return raw
  return raw.split(secret).join('[REDACTED_UYE_KODU]')
}

function wireBlockedResult(): TicimaxClientResult {
  return {
    ok: false,
    errorClass: 'WIRE_CONTRACT_UNVERIFIED',
    message: SAFE_MESSAGES.WIRE_CONTRACT_UNVERIFIED,
    rawOrders: [],
  }
}

/**
 * SelectSiparis — tel doğrulanmadan SOAP GÖNDERİLMEZ.
 *
 * Kapı önce çalışır; başarısızlıkta ağ yok, gövde yok, sır sızıntısı yok.
 * Optional filter/pagination args are intentionally omitted until the wire
 * contract is verified — callers today pass credentials only.
 */
export async function selectSiparis(
  // Credentials reserved for the post-verification SOAP adapter; unused while
  // the wire gate fail-closes before any network I/O.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _credentials: TicimaxCredentials,
): Promise<TicimaxClientResult> {
  try {
    assertSelectSiparisWireReady()
  } catch (error) {
    if (error instanceof TicimaxWireContractError) return wireBlockedResult()
    throw error
  }
  // Bu noktaya yalnız selectSiparisVerified=true ile gelinir. Canlı SOAP
  // adaptörü AYRI doğrulama sonrası eklenir — burada uydurma XML YOK.
  return {
    ok: false,
    errorClass: 'WIRE_CONTRACT_UNVERIFIED',
    message: SAFE_MESSAGES.WIRE_CONTRACT_UNVERIFIED,
    rawOrders: [],
  }
}

/** Bağlantı testi — SelectSiparis kapısından geçer; SOAP yok. */
export async function testTicimaxConnection(
  credentials: TicimaxCredentials,
): Promise<TicimaxClientResult> {
  return selectSiparis(credentials)
}

/** Yazma metodu çağrısı — denylist önce; yazmaysa da SOAP yok. */
export function invokeTicimaxMethod(methodName: string): never {
  assertTicimaxWriteDenied(methodName)
  throw new Error(`Ticimax metodu desteklenmiyor (SOAP adaptörü yok): ${methodName}`)
}
