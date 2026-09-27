// ARAS — SOAP TAŞIMA İSTEMCİSİ (yalnız TEST uç noktası; internal_test).
//
// Zarf üretimi `buildArasSetOrderEnvelope`, `buildArasGetOrderWithIntegrationCodeEnvelope`
// ve `buildArasGetBarcodeEnvelope` ile test-kilitlidir; bu modül yalnız POST eder.

import {
  resolveArasEndpoint,
  ARAS_SET_ORDER_RESULT_FIELDS,
  ARAS_VERIFICATION_RESPONSE_FIELDS,
  ARAS_GET_BARCODE_RESPONSE_FIELDS,
  type ArasEnvironment,
} from './arasContract.ts'
import { buildArasGetOrderWithIntegrationCodeEnvelope } from './arasVerification.ts'
import { buildArasGetBarcodeEnvelope } from './arasLabelArtifact.ts'

export const ARAS_TRANSPORT_TIMEOUT_MS = 30_000

export type ArasTransportErrorCode =
  | 'ARAS_ENDPOINT_UNRESOLVED'
  | 'ARAS_TRANSPORT_TIMEOUT'
  | 'ARAS_TRANSPORT_HTTP_ERROR'
  | 'ARAS_TRANSPORT_UNKNOWN'
  | 'ARAS_MALFORMED_RESPONSE'
  | 'ARAS_VERIFICATION_ENVELOPE_INVALID'
  | 'ARAS_LABEL_ENVELOPE_INVALID'
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
  raw: Record<string, unknown> | null
  errorCode: ArasTransportErrorCode | null
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

function containsSoapFault(xml: string): boolean {
  return /<[^>]*Fault[\s>]/i.test(xml) || /<faultcode[\s>]/i.test(xml)
}

function stripNonElementXmlConstructs(xml: string): string {
  return xml
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
}

// Bir onceki uygulama yalnizca ilk karakterin '<' ve govdenin bir
// kapanis etiketiyle bitip bitmedigini kontrol ediyordu; bu, etiketleri
// eslesmeyen (ornegin <foo><ResultCode>0</ResultCode></bar>) bir govdeyi
// gecerli XML sayip extractKnownXmlFields'in ResultCode=0'i cikarmasina
// ve olusturma siniflandirmasinin sahte basariya donmesine izin
// veriyordu. Yerine yigin tabanli acilis/kapanis eslestirmesi konur.
function isWellFormedXml(xml: string): boolean {
  const trimmed = xml.trim()
  if (!trimmed.startsWith('<')) return false

  const cleaned = stripNonElementXmlConstructs(trimmed)
  const tags = cleaned.match(/<[^>]+>/g)
  if (!tags || tags.length === 0) return false

  const stack: string[] = []
  for (const tag of tags) {
    if (tag.startsWith('</')) {
      const nameMatch = /^<\/\s*([A-Za-z_][\w.:-]*)/.exec(tag)
      if (!nameMatch) return false
      if (stack.pop() !== nameMatch[1]) return false
    } else if (/\/\s*>$/.test(tag)) {
      continue
    } else {
      const nameMatch = /^<\s*([A-Za-z_][\w.:-]*)/.exec(tag)
      if (!nameMatch) return false
      stack.push(nameMatch[1])
    }
  }
  return stack.length === 0
}

function looksLikeXml(xml: string): boolean {
  return isWellFormedXml(xml)
}

interface PerformArasSoapCallParams {
  url: string
  soapAction: string
  envelope: string
  fetchImpl?: ArasFetchLike
  timeoutMs?: number
  knownResponseFields: readonly string[]
}

async function performArasSoapCall(
  params: PerformArasSoapCallParams,
): Promise<ArasTransportOutcome> {
  const doFetch = params.fetchImpl ?? (globalThis.fetch as unknown as ArasFetchLike)
  const controller = new AbortController()
  const timeoutMs = params.timeoutMs ?? ARAS_TRANSPORT_TIMEOUT_MS
  // ÖNEMLİ: zamanlayıcı yalnız `doFetch` çözümlenene KADAR değil, gövde
  // (`response.text()`) TAMAMEN okunana kadar aktif kalır. Aksi halde bir
  // sunucu başlıkları hemen dönüp gövdeyi sonsuza dek akıtabilir (veya hiç
  // kapatmayabilir) ve okuma SÜRESİZ askıda kalırdı — timeout yalnız ilk
  // aşamayı korumuş olurdu.
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
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
    }

    let bodyText: string
    try {
      bodyText = await response.text()
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError'
      return {
        ok: false,
        httpStatus: response.status,
        raw: null,
        networkCalled: true,
        errorCode: aborted ? 'ARAS_TRANSPORT_TIMEOUT' : 'ARAS_MALFORMED_RESPONSE',
      }
    }
    return finishArasSoapCall(response, bodyText, params.knownResponseFields)
  } finally {
    clearTimeout(timer)
  }
}

function finishArasSoapCall(
  response: { ok: boolean; status: number },
  bodyText: string,
  knownResponseFields: readonly string[],
): ArasTransportOutcome {
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
  if (containsSoapFault(bodyText)) {
    return {
      ok: false,
      httpStatus: response.status,
      raw: null,
      networkCalled: true,
      errorCode: 'ARAS_TRANSPORT_UNKNOWN',
    }
  }

  const raw = extractKnownXmlFields(bodyText, knownResponseFields)
  return { ok: true, httpStatus: response.status, raw, networkCalled: true, errorCode: null }
}

export interface ArasSetOrderCallParams {
  envelope: string
  environment?: ArasEnvironment
  productionUrl?: string | null
  fetchImpl?: ArasFetchLike
  timeoutMs?: number
}

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

export interface ArasVerificationCallParams {
  credentials: { userName?: string | null; password?: string | null }
  integrationCode?: string | null
  environment?: ArasEnvironment
  productionUrl?: string | null
  fetchImpl?: ArasFetchLike
  timeoutMs?: number
}

export async function callArasVerification(
  params: ArasVerificationCallParams,
): Promise<ArasTransportOutcome> {
  const built = buildArasGetOrderWithIntegrationCodeEnvelope({
    credentials: params.credentials,
    integrationCode: params.integrationCode,
  })
  if (!built.ok) {
    return {
      ok: false,
      httpStatus: null,
      raw: null,
      networkCalled: false,
      errorCode: 'ARAS_VERIFICATION_ENVELOPE_INVALID',
    }
  }
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
    soapAction: 'http://tempuri.org/GetOrderWithIntegrationCode',
    envelope: built.envelope,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
    knownResponseFields: ARAS_VERIFICATION_RESPONSE_FIELDS,
  })
}

export interface ArasGetBarcodeCallParams {
  credentials: { userName?: string | null; password?: string | null }
  integrationCode?: string | null
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
  const built = buildArasGetBarcodeEnvelope({
    credentials: params.credentials,
    integrationCode: params.integrationCode,
  })
  if (!built.ok) {
    return {
      ok: false,
      httpStatus: null,
      raw: null,
      networkCalled: false,
      errorCode: 'ARAS_LABEL_ENVELOPE_INVALID',
    }
  }
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
    soapAction: 'http://tempuri.org/GetBarcode',
    envelope: built.envelope,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
    knownResponseFields: ARAS_GET_BARCODE_RESPONSE_FIELDS,
  })
}
