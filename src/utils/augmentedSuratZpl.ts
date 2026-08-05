// TÜRETİLMİŞ BASKI ZPL'İ (printZpl) — SAF (IO/DOM/ağ YOK).
//
// technicalZpl KUTSAL KAYNAKTIR ve HİÇ DEĞİŞTİRİLMEZ. Bu modül ondan
// DETERMINISTIK bir printZpl türetir:
//
//   [kaynak komutlar — AYNEN, aynı sırada, aynı satır sonlarıyla]
//   [ürün footer komutları]
//   [orijinal ^PQ]        (varsa)
//   [orijinal ^XZ]
//
// Naif replace('^XZ', …) KULLANILMAZ: son ^PQ / son ^XZ konumu bulunur ve
// ekleme yalnız oraya yapılır.
//
// Şablon bilinen Sürat şablonu değilse veya ürün satırı güvenli alana
// sığmıyorsa printZpl = technicalZpl olur ve sebep AÇIKÇA raporlanır
// (sessiz kırpma veya bilinmeyen koordinata yazma YOKTUR).
import { parseSuratZplGeometry } from './suratZplGeometry.ts'
import {
  buildFooterZplCommands,
  planSuratFooter,
  resolveSuratTemplateFingerprint,
  type SuratFooterProfileKey,
  type SuratProductLineItem,
} from './suratZplProductLine.ts'

export const PRINT_ZPL_VERSION = 'surat-product-line-v1'

export type AugmentedZplFallbackReason =
  | 'no_source'
  | 'unsupported_template'
  | 'no_items'
  | 'footer_overflow'

export interface AugmentedSuratZpl {
  /** Baskı/indirme/native için kullanılacak ZPL. */
  printZpl: string
  /** Kaynak ZPL — DEĞİŞTİRİLMEDEN taşınır. */
  sourceZpl: string
  printZplLength: number
  printZplVersion: string
  printZplFooterProfile: SuratFooterProfileKey | null
  templateFingerprint: string
  /** Ürün satırı gerçekten eklendi mi. */
  augmented: boolean
  fallbackReason?: AugmentedZplFallbackReason
  /** Kullanıcıya gösterilebilir güvenli açıklama (PII içermez). */
  fallbackMessage?: string
  /** Teşhis ölçüleri (dot) — PII içermez. */
  metrics?: {
    contentBottom: number
    footerTop: number
    footerBottom: number
    footerLeft: number
    footerWidth: number
    labelLength: number
    usedHeight: number
  }
}

// Kaynak ZPL'in sonundaki ^PQ (varsa) ve ^XZ konumunu bulur. Sondaki boşluk
// ve satır sonları AYNEN korunur.
function resolveInsertionIndex(zpl: string): number {
  const finalXz = zpl.lastIndexOf('^XZ')
  if (finalXz < 0) return -1
  const beforeXz = zpl.slice(0, finalXz)
  const finalPq = beforeXz.lastIndexOf('^PQ')
  if (finalPq >= 0) {
    // ^PQ'den HEMEN ÖNCE (satır başına hizalanmış olarak).
    return finalPq
  }
  return finalXz
}

export function deriveAugmentedSuratZpl(
  rawSourceZpl: unknown,
  items: SuratProductLineItem[],
): AugmentedSuratZpl {
  const sourceZpl = String(rawSourceZpl ?? '')
  const base: AugmentedSuratZpl = {
    printZpl: sourceZpl,
    sourceZpl,
    printZplLength: sourceZpl.length,
    printZplVersion: PRINT_ZPL_VERSION,
    printZplFooterProfile: null,
    templateFingerprint: '',
    augmented: false,
  }
  if (!sourceZpl.trim()) {
    return { ...base, fallbackReason: 'no_source' }
  }

  const geometry = parseSuratZplGeometry(sourceZpl)
  const fingerprint = resolveSuratTemplateFingerprint(sourceZpl, geometry)
  const withFingerprint = { ...base, templateFingerprint: fingerprint.signature }
  if (!fingerprint.supported) {
    return {
      ...withFingerprint,
      fallbackReason: 'unsupported_template',
      // Sebep yalnız teknik şablon bilgisi taşır (müşteri verisi YOK).
      fallbackMessage: `Bilinmeyen etiket şablonu (${fingerprint.reason ?? 'imza eşleşmedi'}); resmî ZPL aynen kullanıldı.`,
    }
  }

  const usableItems = (Array.isArray(items) ? items : []).filter(
    (item) => String(item?.productName ?? '').trim().length > 0,
  )
  if (usableItems.length === 0) {
    return { ...withFingerprint, fallbackReason: 'no_items' }
  }

  const plan = planSuratFooter(usableItems, geometry)
  if (!plan.ok || !plan.profile || !plan.area || !plan.blocks) {
    return {
      ...withFingerprint,
      fallbackReason: 'footer_overflow',
      fallbackMessage: plan.reason,
    }
  }

  // Kaynak ^CI28 (UTF-8) kullanıyorsa Türkçe karakterler AYNEN yazılır.
  const utf8 = /\^CI28/i.test(sourceZpl)
  const commands = buildFooterZplCommands(plan, { utf8 })
  if (commands.length === 0) {
    return { ...withFingerprint, fallbackReason: 'footer_overflow' }
  }

  const insertAt = resolveInsertionIndex(sourceZpl)
  if (insertAt < 0) {
    return { ...withFingerprint, fallbackReason: 'unsupported_template' }
  }
  const head = sourceZpl.slice(0, insertAt)
  const tail = sourceZpl.slice(insertAt)
  // Kaynağın satır sonu biçimini KORU (CRLF/LF).
  const newline = sourceZpl.includes('\r\n') ? '\r\n' : '\n'
  const needsLeadingBreak = head.length > 0 && !/\r?\n$/.test(head)
  const printZpl =
    head +
    (needsLeadingBreak ? newline : '') +
    commands.join(newline) +
    newline +
    tail

  return {
    printZpl,
    sourceZpl,
    printZplLength: printZpl.length,
    printZplVersion: PRINT_ZPL_VERSION,
    printZplFooterProfile: plan.profile.key,
    templateFingerprint: fingerprint.signature,
    augmented: true,
    metrics: {
      contentBottom: geometry.contentBottom,
      footerTop: plan.area.top,
      footerBottom: plan.area.top + (plan.usedHeight ?? 0),
      footerLeft: plan.area.x,
      footerWidth: plan.area.width,
      labelLength: geometry.labelLength,
      usedHeight: plan.usedHeight ?? 0,
    },
  }
}

// ── Hash ─────────────────────────────────────────────────────────────────
// SHA-256 saf ve senkron uygulanır: aynı girdi HER ORTAMDA (tarayıcı, Node,
// test) aynı değeri verir; harici bağımlılık ve async API gerekmez.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

export function sha256Hex(input: string): string {
  const bytes: number[] = []
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      )
    }
  }
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let i = 7; i >= 0; i -= 1) {
    bytes.push(Math.floor(bitLength / 2 ** (i * 8)) & 0xff)
  }

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Array<number>(64)

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] =
        ((bytes[chunk + i * 4] << 24) |
          (bytes[chunk + i * 4 + 1] << 16) |
          (bytes[chunk + i * 4 + 2] << 8) |
          bytes[chunk + i * 4 + 3]) >>>
        0
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e
      e = (d + temp1) >>> 0
      d = c; c = b; b = a
      a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('')
}

export interface AugmentedSuratZplWithHashes extends AugmentedSuratZpl {
  printZplSha256: string
  printZplSourceSha256: string
}

export function deriveAugmentedSuratZplWithHashes(
  rawSourceZpl: unknown,
  items: SuratProductLineItem[],
): AugmentedSuratZplWithHashes {
  const derived = deriveAugmentedSuratZpl(rawSourceZpl, items)
  return {
    ...derived,
    printZplSha256: sha256Hex(derived.printZpl),
    printZplSourceSha256: sha256Hex(derived.sourceZpl),
  }
}
