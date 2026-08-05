// GERÇEK technicalZpl → YAPISAL OLARAK BİREBİR MASKELENMİŞ FIXTURE.
//
// AMAÇ: gerçek Sürat şablonunun KOMUT VE KOORDİNAT yapısını hiç bozmadan,
// içindeki müşteri verisini tamamen sentetik değerlerle değiştirmek.
//
// DEĞİŞMEZ (byte-for-byte): ^XA ^XZ ^PW ^LL ^LS ^FO ^FT ^FW ^A0 ^A@ font adı
// ^CI ^F8 ^FH ^FB ^GB ^BY ^BC ^BX ^BQ ^PQ, tüm koordinatlar, tüm font
// ölçüleri, orientation değerleri, komut SIRASI ve satır sonu biçimi.
// DEĞİŞEN: YALNIZ ^FD ... ^FS veri gövdeleri.
//
// GİZLİLİK: bu modül hiçbir yere log YAZMAZ ve gerçek değerlerin hash'ini
// ÜRETMEZ. Sentetik değerler alanın SIRA NUMARASINDAN türetilir; içerikten
// TÜRETİLMEZ, bu yüzden maskeli çıktıdan orijinale gidilemez.
import { createHash } from 'node:crypto'

/** ^FD gövdelerinin yerine konan sabit token (yapısal hash için). */
export const FIELD_DATA_TOKEN = '<FD>'

export interface ZplField {
  /** Alanın ^FD gövdesi (ham). */
  data: string
  /** Gövdenin ZPL içindeki başlangıç/bitiş indeksi. */
  start: number
  end: number
  /** Bu alandan ÖNCE gelen barkod komutu (varsa). */
  barcode: 'BC' | 'BX' | 'BQ' | null
  /** Etkin ^FH kaçış işareti (yoksa ''). */
  hexMarker: string
}

/** ^FD gövdelerini, hangi barkod komutunu izlediğiyle birlikte bulur. */
export function parseZplFields(zpl: string): ZplField[] {
  const fields: ZplField[] = []
  let barcode: ZplField['barcode'] = null
  let hexMarker = ''
  let index = 0
  while (index < zpl.length) {
    const caret = zpl.indexOf('^', index)
    if (caret === -1) break
    const command = zpl.slice(caret + 1, caret + 3).toUpperCase()
    if (command === 'BC') barcode = 'BC'
    else if (command === 'BX') barcode = 'BX'
    else if (command === 'BQ') barcode = 'BQ'
    else if (command === 'FH') {
      const marker = zpl.slice(caret + 3, caret + 4)
      hexMarker = marker && marker !== '^' ? marker : '_'
    } else if (command === 'FS') {
      barcode = null
      hexMarker = ''
    } else if (command === 'FD') {
      const start = caret + 3
      let end = zpl.indexOf('^', start)
      if (end === -1) end = zpl.length
      fields.push({ data: zpl.slice(start, end), start, end, barcode, hexMarker })
      index = end
      barcode = null
      continue
    }
    index = caret + 1
  }
  return fields
}

/**
 * YAPISAL HASH: tüm ^FD gövdeleri sabit token'la değiştirilip SHA-256 alınır.
 * Kaynak ve maskelenmiş dosyanın bu hash'i EŞİT olmalıdır. Hash gerçek veri
 * İÇERMEZ (gövdeler zaten silinmiştir).
 */
export function structuralHash(zpl: string): string {
  return createHash('sha256').update(structuralSkeleton(zpl)).digest('hex')
}

/** ^FD gövdeleri token'la değiştirilmiş iskelet (teşhis ve karşılaştırma). */
export function structuralSkeleton(zpl: string): string {
  const fields = parseZplFields(zpl)
  let out = ''
  let cursor = 0
  for (const field of fields) {
    out += zpl.slice(cursor, field.start) + FIELD_DATA_TOKEN
    cursor = field.end
  }
  return out + zpl.slice(cursor)
}

// ── Sentetik değer üretimi ────────────────────────────────────────────────
// Karakter SINIFI korunur: rakam→rakam, büyük harf→büyük harf, küçük→küçük,
// diğer her şey (boşluk, nokta, *, /, :, -, _) AYNEN kalır. Böylece telefon
// maskeleri, noktalama ve alan uzunluğu korunur; içerik tamamen kaybolur.
const UPPER = 'ORNEKSENTETIKVALUEXYZ'
const LOWER = 'ornekmaskelenmisdeger'
const HEX = '0123456789ABCDEF'

function syntheticChar(original: string, seed: number): string {
  if (original >= '0' && original <= '9') return String((seed * 7 + 3) % 10)
  if (original >= 'A' && original <= 'Z') return UPPER[seed % UPPER.length]
  if (original >= 'a' && original <= 'z') return LOWER[seed % LOWER.length]
  // Türkçe/çok baytlı harfler de dâhil, harf olmayan her şey korunur.
  if (/\p{Lu}/u.test(original)) return UPPER[seed % UPPER.length]
  if (/\p{Ll}/u.test(original)) return LOWER[seed % LOWER.length]
  return original
}

/**
 * Tek bir ^FD gövdesini maskeler. Bağlama duyarlıdır:
 *  - ^FH heksadesimal kaçışları (`_C3` gibi) GEÇERLİ hex olarak kalır
 *  - Code128 kontrol ön ekleri (`>:` `>9` …) AYNEN korunur
 *  - ^BQ verisindeki `<hata düzeltme><mod>,` ön eki AYNEN korunur
 *  - boş gövde ('' ) DEĞİŞTİRİLMEZ
 */
export function maskFieldData(field: ZplField, fieldIndex: number): string {
  const data = field.data
  if (data === '') return data

  let prefix = ''
  let body = data
  // ^BQ: "LA,payload" → "LA," korunur (seviye modül sayısını belirler).
  if (field.barcode === 'BQ') {
    const match = /^([A-Za-z]{1,2},)([\s\S]*)$/.exec(data)
    if (match) {
      prefix = match[1]
      body = match[2]
    }
  }

  const marker = field.hexMarker
  let out = ''
  let index = 0
  let seed = fieldIndex * 31 + 7
  while (index < body.length) {
    const char = body[index]
    // ^FH kaçışı: marker + iki hex hane → GEÇERLİ hex üret (yapı bozulmaz).
    if (marker && char === marker && /^[0-9a-fA-F]{2}$/.test(body.slice(index + 1, index + 3))) {
      out += marker + HEX[seed % 16] + HEX[(seed + 5) % 16]
      index += 3
      seed += 1
      continue
    }
    // Code128 kontrol ön eki: ">X" ikilisi AYNEN korunur.
    if (field.barcode === 'BC' && char === '>' && index + 1 < body.length) {
      out += body.slice(index, index + 2)
      index += 2
      continue
    }
    out += syntheticChar(char, seed)
    index += 1
    seed += 1
  }
  return prefix + out
}

export interface MaskResult {
  masked: string
  fieldCount: number
  maskedFieldCount: number
  emptyFieldCount: number
}

/** Tüm ^FD gövdelerini maskeler; başka HİÇBİR bayta dokunmaz. */
export function maskZpl(zpl: string): MaskResult {
  const fields = parseZplFields(zpl)
  let out = ''
  let cursor = 0
  let maskedFieldCount = 0
  let emptyFieldCount = 0
  fields.forEach((field, index) => {
    const masked = maskFieldData(field, index)
    if (field.data === '') emptyFieldCount += 1
    else if (masked !== field.data) maskedFieldCount += 1
    out += zpl.slice(cursor, field.start) + masked
    cursor = field.end
  })
  return {
    masked: out + zpl.slice(cursor),
    fieldCount: fields.length,
    maskedFieldCount,
    emptyFieldCount,
  }
}

// ── Yapısal doğrulama ─────────────────────────────────────────────────────
export interface StructuralVerification {
  ok: boolean
  reasons: string[]
  structuralHashMatches: boolean
  commandSequenceMatches: boolean
  commandCount: number
  gbCount: number
  bcCount: number
  bxCount: number
  bqCount: number
  singleLabel: boolean
  lineEndingMatches: boolean
}

function commandSequence(zpl: string): string[] {
  return (zpl.match(/\^[A-Z][A-Z0-9@]?/gi) ?? []).map((token) => token.toUpperCase())
}

function detectLineEnding(zpl: string): string {
  if (zpl.includes('\r\n')) return 'CRLF'
  if (zpl.includes('\n')) return 'LF'
  if (zpl.includes('\r')) return 'CR'
  return 'NONE'
}

/** Kaynak ile maskelenmiş çıktının YAPISAL olarak aynı olduğunu kanıtlar. */
export function verifyStructuralEquality(
  source: string,
  masked: string,
): StructuralVerification {
  const reasons: string[] = []
  const sourceSkeleton = structuralSkeleton(source)
  const maskedSkeleton = structuralSkeleton(masked)
  const structuralHashMatches = sourceSkeleton === maskedSkeleton
  if (!structuralHashMatches) reasons.push('yapısal iskelet farklı')

  const sourceCommands = commandSequence(source)
  const maskedCommands = commandSequence(masked)
  const commandSequenceMatches =
    sourceCommands.length === maskedCommands.length &&
    sourceCommands.every((token, index) => token === maskedCommands[index])
  if (!commandSequenceMatches) reasons.push('komut dizisi farklı')

  const lineEndingMatches = detectLineEnding(source) === detectLineEnding(masked)
  if (!lineEndingMatches) reasons.push('satır sonu biçimi farklı')

  const count = (zpl: string, pattern: RegExp) => (zpl.match(pattern) ?? []).length
  const singleLabel =
    count(masked, /\^XA/g) === 1 && count(masked, /\^XZ/g) === 1
  if (!singleLabel) reasons.push('tek ^XA/^XZ değil')

  // Gövdeler DIŞINDA hiçbir bayt değişmemeli: iskeletler zaten eşitse bu
  // sağlanır, ancak alan sayısı da eşit olmalı.
  if (parseZplFields(source).length !== parseZplFields(masked).length) {
    reasons.push('^FD alan sayısı farklı')
  }

  return {
    ok: reasons.length === 0,
    reasons,
    structuralHashMatches,
    commandSequenceMatches,
    commandCount: maskedCommands.length,
    gbCount: count(masked, /\^GB/g),
    bcCount: count(masked, /\^BC/g),
    bxCount: count(masked, /\^BX/g),
    bqCount: count(masked, /\^BQ/g),
    singleLabel,
    lineEndingMatches,
  }
}

// ── PII taraması ──────────────────────────────────────────────────────────
export interface PiiFinding {
  rule: string
  /** Bulgunun KONUMU; değeri RAPORLANMAZ. */
  index: number
}

const PII_RULES: Array<{ rule: string; pattern: RegExp }> = [
  // Maskeleme sonrası KALMAMASI gereken gerçek biçimler.
  { rule: 'uzun-telefon', pattern: /(?:\+90|0)\s?5\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/g },
  { rule: 'turkce-harf', pattern: /[ÇĞİÖŞÜçğıöşü]/g },
]

/**
 * Maskelenmiş fixture'da yasak kalıp ve token araması. Bulunan DEĞER
 * raporlanmaz; yalnız kural adı ve konum döner.
 */
export function scanForPii(
  masked: string,
  denyTokens: string[] = [],
): { ok: boolean; findings: PiiFinding[] } {
  const findings: PiiFinding[] = []
  for (const { rule, pattern } of PII_RULES) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(masked)) !== null) {
      findings.push({ rule, index: match.index })
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1
    }
  }
  for (const token of denyTokens) {
    const needle = String(token ?? '').trim()
    if (!needle) continue
    let from = 0
    for (;;) {
      const at = masked.indexOf(needle, from)
      if (at === -1) break
      findings.push({ rule: 'deny-token', index: at })
      from = at + 1
    }
  }
  return { ok: findings.length === 0, findings }
}

// ── Yapı raporları (^FD DEĞERİ İÇERMEZ) ───────────────────────────────────
export interface GbCommand {
  rawCommand: string
  x: number
  y: number
  width: number
  height: number
  thickness: number
  type: 'horizontal' | 'vertical' | 'rectangle'
}

export function buildGbInventory(zpl: string): GbCommand[] {
  const rows: GbCommand[] = []
  const pattern = /\^F[OT](\d+),(\d+)[^^]*\^GB([0-9]*),([0-9]*),([0-9]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(zpl)) !== null) {
    const thickness = Number(match[5] || 1)
    const width = match[3] === '' ? thickness : Number(match[3])
    const height = match[4] === '' ? thickness : Number(match[4])
    rows.push({
      rawCommand: match[0].slice(match[0].indexOf('^GB')),
      x: Number(match[1]),
      y: Number(match[2]),
      width,
      height,
      thickness,
      type:
        width > thickness && height > thickness
          ? 'rectangle'
          : height > width
            ? 'vertical'
            : 'horizontal',
    })
  }
  return rows
}

/** Komut + koordinat yapısı; ^FD DEĞERLERİ RAPORA GİRMEZ. */
export function buildStructureReport(zpl: string) {
  const commands = commandSequence(zpl)
  const tally: Record<string, number> = {}
  for (const token of commands) tally[token] = (tally[token] ?? 0) + 1
  const positions: Array<{ command: string; x: number; y: number }> = []
  const positionPattern = /\^(F[OT])(\d+),(\d+)/g
  let match: RegExpExecArray | null
  while ((match = positionPattern.exec(zpl)) !== null) {
    positions.push({
      command: '^' + match[1].toUpperCase(),
      x: Number(match[2]),
      y: Number(match[3]),
    })
  }
  const readNumber = (pattern: RegExp) => {
    const found = zpl.match(pattern)
    return found ? Number(found[1]) : null
  }
  return {
    note: 'Bu rapor YALNIZ komut ve koordinat bilgisi taşır; ^FD değerleri İÇERMEZ.',
    printWidth: readNumber(/\^PW(\d+)/),
    labelLength: readNumber(/\^LL0*(\d+)/),
    commandCount: commands.length,
    commandTally: tally,
    fieldCount: parseZplFields(zpl).length,
    positions,
    fonts: (zpl.match(/\^A[0@][NRIB]?,\d+,\d+/g) ?? []),
    barcodeDefaults: (zpl.match(/\^BY[0-9.,]*/g) ?? []),
    code128: (zpl.match(/\^BC[^^]*/g) ?? []),
    dataMatrix: (zpl.match(/\^BX[^^]*/g) ?? []),
    qr: (zpl.match(/\^BQ[^^]*/g) ?? []),
    printQuantity: (zpl.match(/\^PQ[^^]*/g) ?? []),
    gb: buildGbInventory(zpl),
    lineEnding: detectLineEnding(zpl),
    structuralHash: structuralHash(zpl),
  }
}
