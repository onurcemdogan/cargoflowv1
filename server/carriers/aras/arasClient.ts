// ARAS — SOAP TAŞIMA İSTEMCİSİ (yalnız TEST uç noktası; internal_test).
//
// Bu modül `arasContract.ts`/`arasSetOrder.ts`'in ürettiği KARARLARI ağa
// taşır; kendi başına yeni bir iş kuralı ÜRETMEZ. Zarf `buildArasSetOrder-
// Envelope`dan AYNEN alınır — burada yeniden kurulmaz.
//
// ═══ GetOrderWithIntegrationCode — İSTEK ZARFI KANITSIZ ═══════════════════
//
// `ARAS_VERIFICATION_OPERATION` sabiti operasyon ADINI kanıtlar
// (`arasVerification.ts`). Ama bu operasyonun SOAP istek zarfı — parametre
// adı, sarmalayıcı eleman, büyük/küçük harf — repoda HİÇBİR yerde (bu
// dosyalar, `docs/cargoflow-roadmap/P5_AUDIT.md`, `STATE.json`) dokümante
// DEĞİLDİR ve `carrier-aras-contract-flow.test.mjs` de yalnız operasyon adını
// sınar, bir istek zarfı KURMAZ/SINAMAZ. Bu oturumda resmî WSDL'i yeniden
// getirme aracı (WebFetch) izni verilmediği için tazelenip kanıtlanamadı.
//
// Bu yüzden zarf burada UYDURULMAZ: `callArasVerification` hiçbir ağ
// çağrısı yapmadan `ARAS_VERIFICATION_CONTRACT_UNPROVEN` ile fail-closed
// döner. Bkz. `docs/cargoflow-roadmap/P5_AUDIT.md` "ARAS-EXPANSION" bölümü.
//
// ═══ GetBarcode — İSTEK ZARFI da KANITSIZ ═════════════════════════════════
//
// `arasLabelArtifact.ts` başlığı GİRDİ alan ADLARINI anlatım/yorum
// düzeyinde belirtir (Username/Password/integrationCode) ama SetOrder'daki
// gibi test-kilitli bir `buildArasGetBarcodeEnvelope` YOKTUR; tam alan
// büyük/küçük harfi ve sarmalayıcı yapısı doğrulanmadı. Aynı nedenle
// `callArasGetBarcode` da ağa ÇIKMADAN fail-closed döner
// (`ARAS_LABEL_CONTRACT_UNPROVEN`). Ayrıca ön koşul (`VERIFIED_REGISTERED`
// mı `CREATE_SUBMITTED` mı) da kanıtsızdır (ticket madde 1); kanıt gelene
// kadar EN KISITLAYICI seçenek uygulanır: yalnız `registered === true`
// iken bu kapıdan geçilir — bu bir sözleşme iddiası DEĞİL, muhafazakâr bir
// karardır.

import {
  resolveArasEndpoint,
  ARAS_SET_ORDER_RESULT_FIELDS,
  type ArasEnvironment,
} from './arasContract.ts'

export const ARAS_TRANSPORT_TIMEOUT_MS = 30_000

export type ArasTransportErrorCode =
  | 'ARAS_ENDPOINT_UNRESOLVED'
  | 'ARAS_TRANSPORT_TIMEOUT'
  | 'ARAS_TRANSPORT_HTTP_ERROR'
  | 'ARAS_TRANSPORT_UNKNOWN'
  | 'ARAS_MALFORMED_RESPONSE'
  | 'ARAS_VERIFICATION_CONTRACT_UNPROVEN'
  | 'ARAS_LABEL_CONTRACT_UNPROVEN'
  | 'ARAS_LABEL_PRECONDITION_NOT_MET'

export class ArasTransportError extends Error {
  readonly code: ArasTransportErrorCode
  constructor(code: ArasTransportErrorCode, message: string) {
    super(message)
    this.name = 'ArasTransportError'
    this.code = code
  }
}

export type ArasFetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

export interface ArasTransportOutcome {
  ok: boolean
  httpStatus: number | null
  /** Yalnız KANITLI alan adları — beyaz liste dışı hiçbir şey sızmaz. */
  raw: Record<string, unknown> | null
  errorCode: ArasTransportErrorCode | null
  /** Ağ sınırı GERÇEKTEN geçildi mi (fetch fiilen çağrıldı mı)? */
  networkCalled: boolean
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * Bilinen alanları isim bazlı, sarmalayıcı/derinlik VARSAYIMI OLMADAN
 * çıkarır. Kanıtlı olmayan bir zarf yerleşimini iddia etmemek için yalnız
 * `fieldNames` listesindeki etiketler aranır; başka her şey YOK SAYILIR.
 */
export function extractKnownXmlFields(
  xml: string,
  fieldNames: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fieldNames) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(
      `<(?:[A-Za-z0-9_]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${escaped}>`,
      'g',
    )
    const matches = [...xml.matchAll(re)]
    if (matches.length === 0) continue
    result[field] = decodeXmlEntities(matches[0][1])
  }
  return result
}

/** SOAP Fault, iyi biçimli SOAP zarfı içinde açıkça KANITLI olan tek durumdur. */
function containsSoapFault(xml: string): boolean {
  return /<[^>]*Fault[\s>]/i.test(xml) || /<faultcode[\s>]/i.test(xml)
}

function looksLikeXml(xml: string): boolean {
  return /<[a-zA-Z]/.test(xml) && /<\/[a-zA-Z:]+>\s*$/.test(xml.trim())
}

interface PerformArasSoapCallParams {
  url: string
  soapAction: string
  envelope: string
  fetchImpl?: ArasFetchLike
  timeoutMs?: number
  knownResponseFields: readonly string[]
}

/**
 * Tek taşıma yürütücüsü: proven zarfı POST eder, HTTP/ XML seviyesinde
 * sınıflandırır. İş anlamına (ResultCode vb.) HİÇ karışmaz — onu çağıran
 * (`classifyArasSetOrderResult` gibi) zaten test-kilitli fonksiyonlar yapar.
 */
async function performArasSoapCall(
  params: PerformArasSoapCallParams,
): Promise<ArasTransportOutcome> {
  const doFetch = params.fetchImpl ?? (globalThis.fetch as unknown as ArasFetchLike)
  const controller = new AbortController()
  const timeoutMs = params.timeoutMs ?? ARAS_TRANSPORT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Awaited<ReturnType<ArasFetchLike>>
  try {
    response = await doFetch(params.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: params.soapAction,
      },
      body: params.envelope,
      signal: controller.signal,
    })
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError'
    return {
      ok: false,
      httpStatus: null,
      raw: null,
      networkCalled: true,
      errorCode: aborted ? 'ARAS_TRANSPORT_TIMEOUT' : 'ARAS_TRANSPORT_UNKNOWN',
    }
  } finally {
    clearTimeout(timer)
  }

  let bodyText: string
  try {
    bodyText = await response.text()
  } catch {
    return {
      ok: false,
      httpStatus: response.status,
      raw: null,
      networkCalled: true,
      errorCode: 'ARAS_MALFORMED_RESPONSE',
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      raw: null,
      networkCalled: true,
      errorCode: 'ARAS_TRANSPORT_HTTP_ERROR',
    }
  }
  if (!looksLikeXml(bodyText)) {
    return {
      ok: false,
      httpStatus: response.status,
      raw: null,
      networkCalled: true,
      errorCode: 'ARAS_MALFORMED_RESPONSE',
    }
  }
  // SOAP Fault: HTTP 200 olsa bile başarı DEĞİLDİR — asla sentezlenmez.
  if (containsSoapFault(bodyText)) {
    return {
      ok: false,
      httpStatus: response.status,
      raw: null,
      networkCalled: true,
      errorCode: 'ARAS_TRANSPORT_UNKNOWN',
    }
  }

  const raw = extractKnownXmlFields(bodyText, params.knownResponseFields)
  return { ok: true, httpStatus: response.status, raw, networkCalled: true, errorCode: null }
}

export interface ArasSetOrderCallParams {
  /** `buildArasSetOrderEnvelope`in ÜRETTİĞİ zarf — burada DEĞİŞTİRİLMEZ. */
  envelope: string
  environment?: ArasEnvironment
  productionUrl?: string | null
  fetchImpl?: ArasFetchLike
  timeoutMs?: number
}

/**
 * SetOrder çağrısı — sözleşmenin TAM olarak proven olduğu tek operasyon.
 *
 * SOAPAction, zarfın kendi `xmlns="http://tempuri.org/"` + `SetOrder`
 * eleman adından DOĞRUDAN türer — bu ASMX/.NET'in evrensel taşıma
 * kuralıdır (iş alanı UYDURMASI değildir), tıpkı `Content-Type` başlığı
 * gibi.
 */
export async function callArasSetOrder(
  params: ArasSetOrderCallParams,
): Promise<ArasTransportOutcome> {
  const resolution = resolveArasEndpoint({
    environment: params.environment,
    productionUrl: params.productionUrl,
  })
  if (!resolution.ok || !resolution.url) {
    return {
      ok: false, httpStatus: null, raw: null, networkCalled: false,
      errorCode: 'ARAS_ENDPOINT_UNRESOLVED',
    }
  }
  return performArasSoapCall({
    url: resolution.url,
    soapAction: 'http://tempuri.org/SetOrder',
    envelope: params.envelope,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
    knownResponseFields: ARAS_SET_ORDER_RESULT_FIELDS,
  })
}

// ═══ GetOrderWithIntegrationCode — FAIL-CLOSED (zarf kanıtsız) ═══════════

export interface ArasVerificationCallParams {
  integrationCode?: string | null
  environment?: ArasEnvironment
  productionUrl?: string | null
  fetchImpl?: ArasFetchLike
  timeoutMs?: number
}

/**
 * Hiçbir ağ çağrısı YAPMADAN fail-closed döner: istek zarfı kanıtlanana
 * kadar telde ne gideceği UYDURULMAZ. `networkCalled` her zaman `false`.
 */
export async function callArasVerification(
  params: ArasVerificationCallParams, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<ArasTransportOutcome> {
  return {
    ok: false,
    httpStatus: null,
    raw: null,
    networkCalled: false,
    errorCode: 'ARAS_VERIFICATION_CONTRACT_UNPROVEN',
  }
}

// ═══ GetBarcode — FAIL-CLOSED (zarf kanıtsız + ön koşul kanıtsız) ═══════

export interface ArasGetBarcodeCallParams {
  integrationCode?: string | null
  /** Çağıranın ÖLÇTÜĞÜ doğrulama durumu — yalnız `true` iken kapı açılır. */
  registered: boolean
  environment?: ArasEnvironment
  productionUrl?: string | null
  fetchImpl?: ArasFetchLike
  timeoutMs?: number
}

export async function callArasGetBarcode(
  params: ArasGetBarcodeCallParams,
): Promise<ArasTransportOutcome> {
  if (params.registered !== true) {
    return {
      ok: false,
      httpStatus: null,
      raw: null,
      networkCalled: false,
      errorCode: 'ARAS_LABEL_PRECONDITION_NOT_MET',
    }
  }
  return {
    ok: false,
    httpStatus: null,
    raw: null,
    networkCalled: false,
    errorCode: 'ARAS_LABEL_CONTRACT_UNPROVEN',
  }
}
