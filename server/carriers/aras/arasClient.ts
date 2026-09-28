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

// A single combined regex/replace pass so each entity reference in the
// ORIGINAL text is decoded exactly once. Chaining separate `.replace()` calls
// (the prior implementation) re-scans text a later call's own replacement
// text produced by an earlier call — e.g. numeric-decoding `&#38;lt;` to
// `&lt;` first, then letting a later `&lt;` pass see that manufactured `&lt;`
// and turn it into `<`, silently double-decoding a value that should stay
// `&lt;`. `String.replace` with a global regex only ever matches the
// original string, so a single pass has no such re-entrancy.
const XML_ENTITY_REFERENCE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);/g

function decodeXmlEntities(value: string): string {
  return value.replace(XML_ENTITY_REFERENCE, (full, entity: string) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10)
      return String.fromCodePoint(codePoint)
    }
    switch (entity) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'amp':
        return '&'
      default:
        return full
    }
  })
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

// CDATA content is literal element character data — XML never processes
// entity syntax inside a CDATA section, so a literal `&amp;` inside
// `<![CDATA[...]]>` means the six characters `&amp;`, not the character `&`.
// Unwrapping CDATA delimiters before decoding entities (the prior
// implementation) decodes text that must stay literal. This decodes entities
// only in the text OUTSIDE each CDATA span, then splices each CDATA span's
// payload back in unchanged (only its delimiters are removed), matching
// ARC-3k/ARC-3l's existing "CDATA is opaque, undecoded text" contract.
function decodeElementText(raw: string): string {
  let result = ''
  let cursor = 0
  for (const match of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    result += decodeXmlEntities(raw.slice(cursor, match.index)) + match[1]
    cursor = match.index + match[0].length
  }
  result += decodeXmlEntities(raw.slice(cursor))
  return result.trim()
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
    result[field] = decodeElementText(raw)
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

// XML forbids the literal string "]]>" from occurring in character data
// outside a CDATA section: CharData ::= [^<&]* - ([^<&]* ']]>' [^<&]*). This
// exists so a bare CDATA-close delimiter in ordinary text can never be
// confused with the end of a real CDATA section. Nothing above checked for
// this reserved sequence — character legality and entity-reference checks
// both treat ']', ']', '>' as three individually harmless characters — so a
// body like `<Envelope><Other>]]></Other><ResultCode>0</ResultCode></Envelope>`
// still passed as well-formed (tags balance, one root, legal characters, no
// invalid entities) even though the bare "]]>" is invalid XML outside CDATA,
// letting extractKnownXmlFields read ResultCode='0' out of an otherwise
// malformed body. CDATA content is exempt — its own "]]>" is a delimiter, not
// character data — so this runs on the same CDATA-stripped text
// `hasInvalidEntityReference` already receives.
function hasForbiddenCdataCloseDelimiter(textOutsideCdata: string): boolean {
  return textOutsideCdata.includes(']]>')
}

// Character legality (the Char production) is a document-wide XML
// constraint, not a property of entity-reference syntax — it applies to
// EVERY literal character, including inside CDATA (CDATA only suppresses
// markup/entity recognition, not the underlying character-legality rule).
// `hasInvalidEntityReference` only inspects `&`-prefixed syntax, so it never
// caught an actual illegal byte typed directly into the response: a body
// like `<Envelope><Other>\x00</Other><ResultCode>0</ResultCode></Envelope>`
// (a literal NUL, not the entity `&#0;` already rejected above) still passed
// as well-formed, letting `extractKnownXmlFields` read ResultCode='0' out of
// an otherwise malformed body. This checks raw characters against the same
// `isValidXmlCodePoint` rule used for numeric character references.
function hasInvalidLiteralChar(text: string): boolean {
  for (const ch of text) {
    if (!isValidXmlCodePoint(ch.codePointAt(0)!)) return true
  }
  return false
}

// XML forbids a literal '<' from occurring inside a start/end tag's own
// markup (Name and Attribute characters never include '<'; a raw '<' can
// only legally begin a NEW construct at a tag boundary or in character
// data). The previous strip pass matched comments/PI/DOCTYPE anywhere in the
// raw body with no awareness of whether that match's opening '<!--'/'<?'
// sat INSIDE an already-started, not-yet-closed tag — so a body like
// `<Envelope><Result<!--x-->Code>0</ResultCode></Envelope>` had its embedded
// `<!--x-->` silently stripped, splicing the two tag-name fragments
// "Result" and "Code" together into a fake, well-formed-looking
// `<ResultCode>` that never actually existed in the response, letting
// `extractKnownXmlFields` read ResultCode='0' out of an otherwise malformed
// body. This scans the RAW, unstripped body and rejects it outright (rather
// than stripping) whenever any '<' — including one that starts a
// comment/PI/DOCTYPE/CDATA construct — appears while a plain tag's markup is
// still open (after its own leading '<', before its terminating unquoted
// '>').
function hasConstructSplicedIntoTagMarkup(xml: string): boolean {
  let i = 0
  while (i < xml.length) {
    if (xml[i] !== '<') {
      i++
      continue
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      if (end === -1) return true
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      if (end === -1) return true
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2)
      if (end === -1) return true
      i = end + 2
      continue
    }
    if (/^<!DOCTYPE/i.test(xml.slice(i, i + 9))) {
      const end = xml.indexOf('>', i + 9)
      if (end === -1) return true
      i = end + 1
      continue
    }
    // A plain opening/closing tag: scan to its terminating unquoted '>',
    // respecting quoted attribute values (where '<' is a separate,
    // already-enforced well-formedness violation, not a construct boundary).
    let j = i + 1
    let quote: string | null = null
    let terminated = false
    for (; j < xml.length; j++) {
      const ch = xml[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '<') {
        return true
      } else if (ch === '>') {
        terminated = true
        break
      }
    }
    if (!terminated) return true
    i = j + 1
  }
  return false
}

// XML restricts doctypedecl to the prolog — it may appear at most once, and
// only BEFORE the document's root element starts (document ::= prolog
// element Misc*; prolog ::= XMLDecl? Misc* (doctypedecl Misc*)?). Comments
// and PIs remain legal Misc both before and after the root element, but a
// DOCTYPE is never legal once the root element has started — including one
// embedded, as apparent character data, inside the root's own content. The
// strip pass in `stripNonElementXmlConstructs` removes `<!DOCTYPE ...>`
// unconditionally wherever it is found, with no notion of prolog-vs-content
// position, so a body like
// `<Envelope><ResultCode>0<!DOCTYPE x></ResultCode></Envelope>` had its
// embedded DOCTYPE silently discarded as if it were ordinary, legal prolog
// markup, leaving a clean-looking
// `<Envelope><ResultCode>0</ResultCode></Envelope>` that passed
// well-formedness and let extractKnownXmlFields read ResultCode='0' out of
// an otherwise malformed response. This scans the RAW, unstripped body and
// rejects it the moment a DOCTYPE construct is found after the root
// element's opening tag has already started, so stripping never gets a
// chance to hide the violation.
function hasDoctypeOutsideProlog(xml: string): boolean {
  let i = 0
  let rootStarted = false
  while (i < xml.length) {
    if (xml[i] !== '<') {
      i++
      continue
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      if (end === -1) return false
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      if (end === -1) return false
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2)
      if (end === -1) return false
      i = end + 2
      continue
    }
    if (/^<!DOCTYPE/i.test(xml.slice(i, i + 9))) {
      if (rootStarted) return true
      const end = xml.indexOf('>', i + 9)
      if (end === -1) return false
      i = end + 1
      continue
    }
    // A plain opening/closing/self-closing tag: either the root element
    // starting (the first time this branch runs) or content inside it —
    // either way, any DOCTYPE found from here on is outside the prolog.
    rootStarted = true
    let j = i + 1
    let quote: string | null = null
    while (j < xml.length) {
      const ch = xml[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '<' || ch === '>') {
        break
      }
      j++
    }
    i = j < xml.length && xml[j] === '>' ? j + 1 : j
  }
  return false
}

// The XML declaration (XMLDecl ::= '<?xml' VersionInfo EncodingDecl? SDDecl?
// S? '?>') is not an ordinary processing instruction: XML reserves the PI
// target name "xml" (matched case-insensitively) exclusively for this
// declaration and requires it, if present at all, to be the very first
// construct of the document (document ::= prolog element Misc*; prolog ::=
// XMLDecl? Misc* (doctypedecl Misc*)?) — nothing, not even a comment or
// whitespace, may precede it. `stripNonElementXmlConstructs` strips ANY
// `<?...?>` unconditionally, including one whose target is "xml", with no
// notion of document position, so a body like
// `<Envelope><ResultCode>0<?xml version="1.0"?></ResultCode></Envelope>` had
// its embedded declaration silently discarded as if it were an ordinary,
// legal PI, leaving a clean-looking
// `<Envelope><ResultCode>0</ResultCode></Envelope>` that passed
// well-formedness and let extractKnownXmlFields read ResultCode='0' out of
// an otherwise malformed response. This scans the RAW, unstripped body and
// rejects it the moment a `<?xml ... ?>`-shaped construct is found anywhere
// other than at index 0, so stripping never gets a chance to hide the
// violation.
function hasMisplacedXmlDeclaration(xml: string): boolean {
  let i = 0
  while (i < xml.length) {
    if (xml[i] !== '<') {
      i++
      continue
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      if (end === -1) return false
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      if (end === -1) return false
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2)
      if (end === -1) return false
      const targetMatch = /^\s*([^\s?]*)/.exec(xml.slice(i + 2, end))
      const target = targetMatch ? targetMatch[1] : ''
      if (/^xml$/i.test(target) && i !== 0) return true
      i = end + 2
      continue
    }
    if (/^<!DOCTYPE/i.test(xml.slice(i, i + 9))) {
      const end = xml.indexOf('>', i + 9)
      if (end === -1) return false
      i = end + 1
      continue
    }
    // A plain opening/closing/self-closing tag: scan to its terminating
    // unquoted '>', respecting quoted attribute values.
    let j = i + 1
    let quote: string | null = null
    while (j < xml.length) {
      const ch = xml[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '<' || ch === '>') {
        break
      }
      j++
    }
    i = j < xml.length && xml[j] === '>' ? j + 1 : j
  }
  return false
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
function stripNonElementXmlConstructs(xml: string): string | null {
  const cdataSpans = findCdataSpans(xml)
  const insideCdata = (index: number) =>
    cdataSpans.some((span) => index >= span.start && index < span.end)

  // XML forbids the string "--" from occurring anywhere within a comment's
  // content (Comment ::= '<!--' ((Char - '-') | ('-' (Char - '-')))* '-->'),
  // precisely so the '-->' end delimiter can never be ambiguous. The strip
  // regex below matches a comment lazily up to the FIRST '-->', so a body
  // like `<!--a--b-->` is captured whole (interior "a--b") and discarded in
  // its entirety without ever checking that interior for the forbidden
  // "--" — silently stripping it as "just a comment" instead of rejecting
  // the body as the malformed XML it actually is.
  //
  // The grammar also forbids the content from ENDING in a hyphen: the last
  // repetition, if a hyphen, must be followed by a (Char - '-'), but here it
  // is immediately followed by the '-->' delimiter (which starts with '-').
  // A body like `<!--a---->` still resolves to a lazy first-'-->' interior
  // of just "a-" (no internal "--"), so the "--" check alone let it through
  // as if it were an ordinary legal comment.
  for (const match of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (insideCdata(match.index)) continue
    if (match[1].includes('--') || match[1].endsWith('-')) return null
  }

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

  // Character legality (the Char production) is a document-wide XML
  // constraint on every literal character in the RAW response — it does not
  // stop applying just because that character sits inside a construct whose
  // CONTENT is later discarded. `stripNonElementXmlConstructs` below deletes
  // comments/PI/DOCTYPE outright (their text has no extraction value), which
  // means an illegal literal character hidden inside one — e.g. the NUL in
  // `<Envelope><!--\u0000--><ResultCode>0</ResultCode></Envelope>` — is
  // erased along with the whole comment BEFORE the gap/attribute
  // `hasInvalidLiteralChar` checks further below ever see it, so the
  // stripped body wrongly validates as well-formed and `extractKnownXmlFields`
  // reads ResultCode='0' out of an otherwise malformed response. Scanning the
  // raw, unstripped body up front catches an illegal character regardless of
  // which construct (comment, PI, DOCTYPE, CDATA, or plain text) hides it.
  if (hasInvalidLiteralChar(trimmed)) return null

  // Must run on the RAW body, before any stripping — stripping a
  // comment/PI/DOCTYPE embedded inside a tag's markup would destroy the
  // evidence that the tag was never actually well-formed in the first
  // place (see hasConstructSplicedIntoTagMarkup above).
  if (hasConstructSplicedIntoTagMarkup(trimmed)) return null

  // Must also run on the RAW body, before any stripping — stripping a
  // DOCTYPE embedded inside the root's content would destroy the evidence
  // that it was never legal there in the first place (see
  // hasDoctypeOutsideProlog above).
  if (hasDoctypeOutsideProlog(trimmed)) return null

  // Must also run on the RAW body, before any stripping — stripping an XML
  // declaration embedded inside the root's content would destroy the
  // evidence that it was never legal there in the first place (see
  // hasMisplacedXmlDeclaration above).
  if (hasMisplacedXmlDeclaration(trimmed)) return null

  const cleaned = stripNonElementXmlConstructs(trimmed)
  if (cleaned === null) return null
  const cdataSpans = findCdataSpans(cleaned)
  const insideCdata = (index: number) =>
    cdataSpans.some((span) => index >= span.start && index < span.end)

  // XML permits a literal '>' inside a quoted attribute value (only '<' and
  // the matching quote are forbidden there — AttValue ::= '"' ([^<&"] |
  // Reference)* '"' | "'" ([^<&'] | Reference)* "'"). A naive `[^>]+` scan
  // ends the tag at that embedded '>' instead of the real one, so
  // `<Envelope note="a>b">` was split into a bogus `<Envelope note="a` tag
  // that fails the anchored nameMatch regex below and rejects an otherwise
  // valid response as ARAS_MALFORMED_RESPONSE. Treating a full quoted span as
  // one atomic unit lets the scan skip any '>' (or '<') inside it and stop
  // only at the real, unquoted tag-closing '>'.
  const tagMatches = [...cleaned.matchAll(/<(?:"[^"]*"|'[^']*'|[^"'>])*>/g)].filter(
    (m) => !insideCdata(m.index),
  )
  if (tagMatches.length === 0) return null

  const stack: Array<{ name: string; contentStart: number }> = []
  const elements: ArasXmlElement[] = []
  const tagNames: string[] = []
  let rootCount = 0
  let cursor = 0
  for (const match of tagMatches) {
    const tag = match[0]
    const gap = cleaned.slice(cursor, match.index)
    // Raw character legality applies to the FULL gap, CDATA included — a
    // literal illegal character (e.g. an actual NUL byte) is invalid XML
    // whether or not it sits inside a CDATA section.
    if (hasInvalidLiteralChar(gap)) return null
    // Entity references must be validated everywhere text can appear —
    // including inside an open element (e.g. `<Other>&undefined;</Other>`),
    // not just in the outside-the-root gaps checked below — but never inside
    // CDATA, where '&' is ordinary literal text, not entity syntax.
    const gapOutsideCdata = gap.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    if (hasInvalidEntityReference(gapOutsideCdata)) return null
    if (hasForbiddenCdataCloseDelimiter(gapOutsideCdata)) return null
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
      if (attrMatches.some((m) => hasInvalidLiteralChar(m[2] ?? m[3] ?? ''))) return null
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
