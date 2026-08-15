// SÜRAT KANONİK YAZDIRILABİLİR ETİKET SINIFLANDIRICISI.
//
// RESMİ SÖZLEŞME (api02 /swagger/v2/swagger.json · ResultMesaj):
//   BarcodeNo : array<string>   → TİPLİ. Barkod NUMARASIDIR (tanımlayıcı).
//   Barcode   : array, items:{} → TİPSİZ. Eleman tipi resmî dokümanda
//                                 BELİRTİLMEMİŞTİR; örnek/açıklama da yok.
//
// Bu yüzden format TAHMİN EDİLMEZ: yalnız içeriğin kendisi yapısal olarak
// kanıtlarsa bir format kabul edilir. Kanıt yoksa UNRESOLVED kalır ve
// gönderi BAŞARISIZ SAYILMAZ.

import { createHash } from 'node:crypto'

export type SuratArtifactFormat = 'ZPL' | 'EPL' | 'PDF' | 'PNG' | 'UNKNOWN'

export interface SuratArtifactClassification {
  format: SuratArtifactFormat
  /** Yazdırılabilir kabul edilebilir mi? Yalnız yapısal kanıt varsa. */
  printable: boolean
  /** Base64 katmanı çözülerek mi sınıflandırıldı? */
  base64Decoded: boolean
  byteLength: number
  /** İçeriğin kendisi DEĞİL; yalnız denetim izi. */
  sha256: string
}

const BASE64_PATTERN = /^[A-Za-z0-9+/\r\n]+={0,2}$/

/** ZPL: `^XA` ile başlar, `^XZ` ile biter. Uzun string ZPL DEĞİLDİR. */
function isZpl(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('^XA') && trimmed.endsWith('^XZ')
}

/**
 * EPL2: `N` komutuyla başlar ve `P<n>` yazdırma komutuyla biter.
 * Her iki uç da satır sınırında olmalıdır — tek harfli tesadüfi
 * eşleşmeleri elemek için ikisi birden aranır.
 */
function isEpl(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim())
  if (lines.length < 2) return false
  return lines[0] === 'N' && /^P\d+$/.test(lines[lines.length - 1])
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

function classifyBytes(bytes: Uint8Array): SuratArtifactFormat {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return 'PDF'
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return 'PNG'
    }
  }
  const text = Buffer.from(bytes).toString('utf8')
  if (isZpl(text)) return 'ZPL'
  if (isEpl(text)) return 'EPL'
  return 'UNKNOWN'
}

/**
 * TEK bir `Barcode[]` elemanını sınıflandırır.
 *
 * Base64 ise ÖNCE çözülür ve çözülmüş içerik doğrulanır; doğrulanamayan
 * base64 yazdırılabilir SAYILMAZ (§5).
 */
export function classifySuratVendorArtifact(
  value: unknown,
): SuratArtifactClassification {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      format: 'UNKNOWN', printable: false, base64Decoded: false,
      byteLength: 0, sha256: '',
    }
  }
  const raw = Buffer.from(value, 'utf8')
  const direct = classifyBytes(raw)
  if (direct !== 'UNKNOWN') {
    return {
      format: direct, printable: true, base64Decoded: false,
      byteLength: raw.length, sha256: sha256Hex(raw),
    }
  }
  const compact = value.replace(/\s+/g, '')
  if (compact.length >= 8 && compact.length % 4 === 0 && BASE64_PATTERN.test(value)) {
    const decoded = Buffer.from(compact, 'base64')
    // Yuvarlak dönüş doğrulaması: gerçekten base64 mü?
    if (decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') ===
        compact.replace(/=+$/, '')) {
      const inner = classifyBytes(decoded)
      if (inner !== 'UNKNOWN') {
        return {
          format: inner, printable: true, base64Decoded: true,
          byteLength: decoded.length, sha256: sha256Hex(decoded),
        }
      }
    }
  }
  // Kanıt yok → yazdırılabilir DEĞİL.
  return {
    format: 'UNKNOWN', printable: false, base64Decoded: false,
    byteLength: raw.length, sha256: sha256Hex(raw),
  }
}

export interface SuratPrintableArtifactResolution {
  status: 'RESOLVED' | 'UNRESOLVED' | 'MISSING'
  format: SuratArtifactFormat
  /** Yalnız status === 'RESOLVED' iken doludur. */
  artifact: string | null
  base64Decoded: boolean
  /** `Barcode[]` içindeki seçilen elemanın indeksi. */
  index: number | null
  sha256: string
  byteLength: number
  barcodeCount: number
  barcodeNoCount: number
}

/**
 * `Barcode[]` / `BarcodeNo[]` üzerinden yazdırılabilir etiketi çözer.
 *
 * KURAL: `BarcodeNo` ASLA yazdırılabilir payload olarak kullanılmaz —
 * resmî şemada `array<string>` olarak tanımlıdır ve barkod numarasıdır.
 * `Barcode[]` içinde yapısal olarak doğrulanan İLK eleman seçilir; hiçbiri
 * doğrulanamazsa UNRESOLVED döner (tahmin yok).
 */
export function resolveSuratPrintableArtifact(result: {
  barcode?: unknown[]
  barcodeNo?: unknown[]
}): SuratPrintableArtifactResolution {
  const barcode = Array.isArray(result.barcode) ? result.barcode : []
  const barcodeNo = Array.isArray(result.barcodeNo) ? result.barcodeNo : []
  const base = {
    artifact: null, base64Decoded: false, index: null,
    sha256: '', byteLength: 0,
    barcodeCount: barcode.length, barcodeNoCount: barcodeNo.length,
  }
  if (barcode.length === 0 && barcodeNo.length === 0) {
    return { ...base, status: 'MISSING', format: 'UNKNOWN' }
  }
  for (let index = 0; index < barcode.length; index += 1) {
    const classification = classifySuratVendorArtifact(barcode[index])
    if (classification.printable) {
      return {
        ...base,
        status: 'RESOLVED',
        format: classification.format,
        artifact: String(barcode[index]),
        base64Decoded: classification.base64Decoded,
        index,
        sha256: classification.sha256,
        byteLength: classification.byteLength,
      }
    }
  }
  return { ...base, status: 'UNRESOLVED', format: 'UNKNOWN' }
}

/** Sır içermeyen artifact log/telemetri bağlamı (§21: içerik YOK). */
export function buildSuratArtifactLogContext(
  resolution: SuratPrintableArtifactResolution,
): Record<string, string | number | boolean> {
  return {
    artifactStatus: resolution.status,
    artifactDetectedFormat: resolution.format,
    artifactBase64Decoded: resolution.base64Decoded,
    artifactByteLength: resolution.byteLength,
    artifactSha256: resolution.sha256.slice(0, 16),
    barcodeCount: resolution.barcodeCount,
    barcodeNoCount: resolution.barcodeNoCount,
  }
}
