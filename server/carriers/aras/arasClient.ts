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

interface ArasXmlElement {
  name: string
  start: number
  end: number
}

interface ArasXmlStructure {
  cleaned: string
  elements: ArasXmlElement[]
  tagNames: string[]
}

function unwrapCdataText(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

export function extractKnownXmlFields(
  structure: ArasXmlStructure,
  fieldNames: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fieldNames) {
    // `structure.elements` was built from the CDATA-aware tag scan below, so
    // it only ever contains GENUINE elements (real open/close tag pairs
    // outside any CDATA span). A field is matched by that structural
    // identity, not by re-scanning text for tag-shaped substrings — so CDATA
    // payload text that merely *looks* like `<Field>...</Field>` (smuggled
    // inside some unrelated element's character data) can never be picked up
    // as if it were a real `Field` element.
    const candidates = structure.elements
      .filter((el) => el.name === field || el.name.endsWith(`:${field}`))
      .sort((a, b) => a.start - b.start)
    if (candidates.length === 0) continue
    const raw = structure.cleaned.slice(candidates[0].start, candidates[0].end)
    result[field] = decodeXmlEntities(unwrapCdataText(raw))
  }
  return result
}

function containsSoapFault(structure: ArasXmlStructure): boolean {
  // Same reasoning as extractKnownXmlFields: fault detection runs over the
  // structurally-real tag names only, so CDATA text that merely contains the
  // literal characters "<soap:Fault>" cannot flip a genuine success response
  // into a false fault (or vice versa).
  return structure.tagNames.some((name) => /Fault/i.test(name))
}

function findCdataSpans(xml: string): Array<{ start: number; end: number }> {
  return [...xml.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }))
}

// XML forbids a literal '&' in character data unless it starts one of the
// five predefined entities (lt/gt/amp/apos/quot) or a numeric character
// reference (&#NNN; / &#xHHHH;) — any other name is an undeclared general
// entity reference, which is a well-formedness violation without a DTD
// declaring it (WFC: Entity Declared). The tag-balancing scan below only
// checked tag structure, so a body like
// `<Envelope><Other>&undefined;</Other><ResultCode>0</ResultCode></Envelope>`
// still passed as well-formed (tags balance, one root) even though
// `&undefined;` is not valid XML, letting `extractKnownXmlFields` read
// ResultCode='0' out of an otherwise malformed body. CDATA content is exempt
// — entity syntax is never processed inside a CDATA section — so this check
// must run only on the parts of the text outside any CDATA span.
const VALID_ENTITY_REFERENCE = /&(?:lt|gt|amp|apos|quot|#[0-9]+|#x[0-9a-fA-F]+);/g

// A numeric character reference is only well-formed XML if the code point it
// names is itself a legal XML character. XML 1.0 restricts Char to:
// #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF] —
// notably excluding the C0 control range (e.g. NUL, #x0) and surrogates. The
// prior regex accepted any `&#[0-9]+;` / `&#x[0-9a-fA-F]+;` purely by syntax,
// so `&#0;` (NUL) matched as "valid" without checking what it resolves to,
// letting `<Envelope><Other>&#0;</Other><ResultCode>0</ResultCode></Envelope>`
// pass as well-formed and `extractKnownXmlFields` read ResultCode='0' out of
// an otherwise malformed body.
function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  )
}

function hasInvalidEntityReference(textOutsideCdata: string): boolean {
  for (const match of textOutsideCdata.matchAll(VALID_ENTITY_REFERENCE)) {
    const body = match[0].slice(1, -1)
    if (body[0] !== '#') continue
    const isHex = body[1] === 'x' || body[1] === 'X'
    const codePoint = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
    if (!isValidXmlCodePoint(codePoint)) return true
  }
  return textOutsideCdata.replace(VALID_ENTITY_REFERENCE, '').includes('&')
}

// CDATA govdesi harfi harfine metindir — icindeki `<!--...-->` gibi diziler
// GERCEK bir yorum DEGILDIR. Onceki surum yorum/PI/DOCTYPE'i CDATA
// sinirlarindan HABERSIZ tek bir regex gecisiyle siliyordu; bu yuzden
// `<ResultCode><![CDATA[0<!--99-->]]></ResultCode>` govdesinde CDATA
// icindeki `<!--99-->` gercek bir yorum sanilip silinir, CDATA govdesi
// "0<!--99-->" yerine "0" olarak cikarilirdi (reddedilen bir create'in
// sahte basariya donmesine yol acabilirdi). Simdi CDATA sinirlari STRIP
// ISLEMINDEN ONCE, ham govde uzerinde bulunur; yalnizca bu sinirlarin
// DISINDA baslayan yorum/PI/DOCTYPE eslesmeleri silinir — CDATA govdesi
// (sinirlayicilariyla birlikte) bu gecisten tamamen etkilenmeden cikar.
function stripNonElementXmlConstructs(xml: string): string {
  const cdataSpans = findCdataSpans(xml)
  const insideCdata = (index: number) =>
    cdataSpans.some((span) => index >= span.start && index < span.end)

  const stripPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>/gi
  let result = ''
  let cursor = 0
  for (const match of xml.matchAll(stripPattern)) {
    if (insideCdata(match.index)) continue
    result += xml.slice(cursor, match.index)
    cursor = match.index + match[0].length
  }
  result += xml.slice(cursor)
  return result
}

// Bir onceki uygulama yalnizca ilk karakterin '<' ve govdenin bir
// kapanis etiketiyle bitip bitmedigini kontrol ediyordu; bu, etiketleri
// eslesmeyen (ornegin <foo><ResultCode>0</ResultCode></bar>) bir govdeyi
// gecerli XML sayip extractKnownXmlFields'in ResultCode=0'i cikarmasina
// ve olusturma siniflandirmasinin sahte basariya donmesine izin
// veriyordu. Yerine yigin tabanli acilis/kapanis eslestirmesi konur.
//
// Dogrulama yorum/PI/DOCTYPE'i STRIP EDILMIS govde uzerinde calisir; alan
// cikarimi da AYNI govde uzerinde calismalidir. Aksi halde
// `<Envelope><!--<ResultCode>0</ResultCode>--></Envelope>` gecerli XML
// sayilir (govde strip edildiginde bos bir Envelope kalir) ama
// extractKnownXmlFields orijinal (strip edilmemis) govde uzerinde
// calisirsa yorum icindeki ResultCode=0'i yine de cikarip sahte basariya
// yol acar. Bu yuzden strip edilmis govde tek gecerlilik/cikarim kaynagi
// olarak dondurulur.
//
// CDATA yorum/PI/DOCTYPE gibi ATILACAK bir yapi DEGILDIR — gercek eleman
// verisidir. XML'de `<ResultCode>0<![CDATA[99]]></ResultCode>` govde metni
// "099" anlamina gelir. Bu yuzden etiket taramasi CDATA govdesini hep OPAK
// kabul eder (icindeki `<`/`>` karakterleri sahte etiket sayilmaz) — tek
// gercek kaynagi bu taramanin urettigi `elements` (gercek acilis/kapanis
// cifti) listesidir. Onceki surum dogrulamadan SONRA CDATA sinirlayicilarini
// kaldirip TEK bir duz metin dondururdu ve extractKnownXmlFields o duz metni
// yeniden regex ile tarardi; bu da bir alanin CDATA govdesine gizlenmis
// `<ResultCode>0</ResultCode>` gibi sahte-etiket metnini gercek bir eleman
// sanip cikarmasina (ve sahte create-basarisina) izin veriyordu. Simdi
// cikarim yalniz bu taramanin belirledigi GERCEK eleman sinirlarindan metin
// dilimler; CDATA sinirlayicilari yalniz o dilim icinde, cikarimdan SONRA
// kaldirilir — asla yeniden etiket olarak taranmaz.
function parseWellFormedXmlStructure(xml: string): ArasXmlStructure | null {
  const trimmed = xml.trim()
  if (!trimmed.startsWith('<')) return null

  const cleaned = stripNonElementXmlConstructs(trimmed)
  const cdataSpans = findCdataSpans(cleaned)
  const insideCdata = (index: number) =>
    cdataSpans.some((span) => index >= span.start && index < span.end)

  const tagMatches = [...cleaned.matchAll(/<[^>]+>/g)].filter((m) => !insideCdata(m.index))
  if (tagMatches.length === 0) return null

  const stack: Array<{ name: string; contentStart: number }> = []
  const elements: ArasXmlElement[] = []
  const tagNames: string[] = []
  let rootCount = 0
  let cursor = 0
  for (const match of tagMatches) {
    const tag = match[0]
    const gap = cleaned.slice(cursor, match.index)
    // Entity references must be validated everywhere text can appear —
    // including inside an open element (e.g. `<Other>&undefined;</Other>`),
    // not just in the outside-the-root gaps checked below — but never inside
    // CDATA, where '&' is ordinary literal text, not entity syntax.
    const gapOutsideCdata = gap.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    if (hasInvalidEntityReference(gapOutsideCdata)) return null
    // Text seen while `stack` is empty is outside the root element (before
    // it opens, between top-level siblings, or after it closes). That is
    // only valid XML if it is pure whitespace — e.g.
    // `<Envelope>...</Envelope>garbage` must not be treated as well-formed
    // just because its tags happen to balance.
    if (stack.length === 0) {
      if (gap.trim().length > 0) return null
    }
    cursor = match.index + tag.length

    if (tag.startsWith('</')) {
      // A closing tag permits only whitespace between the element name and
      // `>` — unlike an opening tag, it cannot carry attributes. Matching
      // only the name PREFIX (as opening/self-closing tags legitimately do)
      // would let `</ResultCode junk>` be accepted as a valid close for
      // `<ResultCode>`, silently discarding the trailing garbage and letting
      // `extractKnownXmlFields` read ResultCode='0' out of an otherwise
      // malformed body.
      //
      // XML also forbids whitespace between `</` and the element name
      // (ETag ::= '</' Name S? '>') — a raw `<` is only ever the start of a
      // NEW tag, so `</ ResultCode>` is not a close tag with leading
      // whitespace, it is not a tag at all. The prior regex's `\s*` right
      // after `<\/` accepted it anyway, matching the stack top and letting
      // `extractKnownXmlFields` read ResultCode='0' out of an otherwise
      // malformed body.
      const nameMatch = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(tag)
      if (!nameMatch) return null
      const top = stack.pop()
      if (!top || top.name !== nameMatch[1]) return null
      elements.push({ name: top.name, start: top.contentStart, end: match.index })
    } else {
      // An opening/self-closing tag permits the name to be followed only by
      // whitespace-separated `name="value"` (or `'value'`) attributes, then
      // an optional `/` and `>`. Matching only the name PREFIX (as before)
      // would let `<ResultCode !>` be accepted as a valid open for
      // `<ResultCode>` with the bogus ` !` silently discarded as if it were
      // attribute syntax, letting `extractKnownXmlFields` read ResultCode='0'
      // out of an otherwise malformed body.
      //
      // XML forbids a literal, unescaped `<` inside an attribute value (it
      // must be written as `&lt;`) — a raw `<` there is always the start of
      // a new tag, never data. The value classes below previously accepted
      // any non-quote character (`[^"]*` / `[^']*`), so a tag like
      // `<ResultCode a="<">` still matched: the embedded `<` was treated as
      // ordinary attribute text instead of the well-formedness violation it
      // is, letting `extractKnownXmlFields` read ResultCode='0' out of an
      // otherwise malformed body. Excluding `<` from both value classes
      // forces such tags to fail `nameMatch` and be rejected.
      //
      // XML also forbids whitespace between `<` and the element name
      // (STag ::= '<' Name (...)* S? '>') — the prior regex's `\s*` right
      // after `<` accepted `< ResultCode>` as a valid open for `ResultCode`
      // anyway, letting `extractKnownXmlFields` read ResultCode='0' out of
      // an otherwise malformed body.
      const nameMatch =
        /^<([A-Za-z_][\w.:-]*)(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/)?>$/.exec(
          tag,
        )
      if (!nameMatch) return null
      // The `(?:...)* ` repetition above only checks that each attribute
      // individually looks like `name="value"` — it never tracks whether a
      // name has already appeared, so it still accepts a tag with the SAME
      // attribute twice (e.g. `<ResultCode a="1" a="2">`), which XML forbids
      // (duplicate attribute names are a well-formedness violation). Extract
      // every attribute name in the tag and reject if any repeats.
      //
      // Attribute VALUES are character data too, so the same entity-reference
      // well-formedness rule checked for text between tags (see
      // `hasInvalidEntityReference` above) applies here — a raw `&` in an
      // attribute value is only valid XML if it starts one of the five
      // predefined entities or a numeric character reference. The value
      // classes above (`[^"<]*` / `[^'<]*`) accept any other `&name;` as
      // ordinary text, so `<Other a="&undefined;"/>` still matched even
      // though `&undefined;` is an undeclared entity reference. Attributes
      // cannot contain CDATA, so the check runs directly on each captured
      // value with no CDATA carve-out.
      const attrMatches = [
        ...tag.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g),
      ]
      const attrNames = attrMatches.map((m) => m[1])
      if (new Set(attrNames).size !== attrNames.length) return null
      if (attrMatches.some((m) => hasInvalidEntityReference(m[2] ?? m[3] ?? ''))) return null
      tagNames.push(nameMatch[1])
      if (stack.length === 0) {
        rootCount += 1
        if (rootCount > 1) return null
      }
      if (!nameMatch[2]) {
        stack.push({ name: nameMatch[1], contentStart: cursor })
      }
    }
  }
  // Trailing text after the last tag is also outside the root once it has
  // closed (e.g. `</Envelope>garbage`) and must be whitespace-only.
  if (cleaned.slice(cursor).trim().length > 0) return null
  // XML requires exactly one root element; a self-closed root followed by a
  // sibling (e.g. `<Envelope/><ResultCode>0</ResultCode>`) leaves the stack
  // empty at the end even though there are two top-level elements, so the
  // stack-balance check alone does not catch it.
  if (stack.length !== 0) return null
  if (rootCount !== 1) return null
  return { cleaned, elements, tagNames }
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
  const structure = parseWellFormedXmlStructure(bodyText)
  if (structure === null) {
    return {
      ok: false,
      httpStatus: response.status,
      raw: null,
      networkCalled: true,
      errorCode: 'ARAS_MALFORMED_RESPONSE',
    }
  }
  if (containsSoapFault(structure)) {
    return {
      ok: false,
      httpStatus: response.status,
      raw: null,
      networkCalled: true,
      errorCode: 'ARAS_TRANSPORT_UNKNOWN',
    }
  }

  const raw = extractKnownXmlFields(structure, knownResponseFields)
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
