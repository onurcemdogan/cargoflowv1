// RESMÎ SÜRAT ZPL'İNİN YEREL SVG RENDERER'I — SAF (ağ/harici API YOK).
//
// AMAÇ: kullanıcı "Resmî Sürat Şablonu" seçtiğinde, Sürat'in kendi ZPL
// düzeni tarayıcıda Chrome yazdırma penceresinden basılabilsin. Harici
// Labelary/LabelZoom veya herhangi bir internet render servisi KULLANILMAZ;
// müşteri ZPL'i, adresi, telefonu ve barkodu CargoFlow dışına ÇIKMAZ.
//
// KAPSAM: genel amaçlı Zebra emülatörü DEĞİLDİR. Yalnız doğrulanmış Sürat
// şablonu fingerprint'i için deterministik render yapar. Desteklenmeyen
// KRİTİK komut görülürse SESSİZCE YOK SAYILMAZ: renderStatus
// 'unsupported_command' döner ve çağıran katman açık mesaj gösterir.
//
// KOORDİNAT SÖZLEŞMESİ: ZPL dot uzayı SVG kullanıcı birimiyle BİREBİR eşlenir.
//   viewBox="0 0 799 799"  width="100mm"  height="100mm"
// Böylece 203 dpi'de 799 dot = 100 mm ölçüsü kesin korunur ve HTML/CSS ile
// "yaklaşık" bir yeniden tasarım YAPILMAZ.
//
// Barkod/QR PAYLOAD'LARI KAYNAK ZPL'DEN OKUNUR; UI sipariş alanlarından
// yeniden üretilmez.
import qrcode from 'qrcode-generator'
import { parseSuratZplGeometry } from './suratZplGeometry.ts'
import { resolveSuratTemplateFingerprint } from './suratZplProductLine.ts'
import { encodeDataMatrix } from './dataMatrixEncoder.ts'

export const SURAT_SVG_RENDER_VERSION = 'surat-zpl-svg-v1'
export const SURAT_RENDER_UNAVAILABLE_MESSAGE =
  'Resmî Sürat etiketi tarayıcıda görüntülenemedi. CargoFlow şablonuyla yazdırabilirsiniz.'

export type SuratRenderStatus =
  | 'ok'
  | 'unsupported_command'
  | 'unsupported_template'
  | 'empty_source'
  /** Matris kod (QR/DataMatrix) YEREL olarak üretilemedi — placeholder ÇİZİLMEZ. */
  | 'matrix_encode_failed'

export interface SuratSvgRenderResult {
  renderStatus: SuratRenderStatus
  svg: string
  renderVersion: string
  templateFingerprint: string
  widthDots: number
  heightDots: number
  widthMm: number
  heightMm: number
  /** Güvenli uyarılar (ham ZPL veya müşteri verisi İÇERMEZ). */
  warnings: string[]
  /** Desteklenmeyen komut bulunduysa adı (teşhis; PII yok). */
  unsupportedCommand?: string
}

// 203 dpi: 8 dot/mm (Sürat ^PW799 ≈ 99.875 mm; fiziksel etiket 100 mm).
/** Fiziksel etiket ölçüsü (mm) — Sürat 100 × 100 mm. */
export const LABEL_MM = 100

// Render sırasında ANLAMLI olan komutlar. Bu listede OLMAYAN bir komut
// görülürse render reddedilir (sessiz yok sayma YOK).
const SUPPORTED_COMMANDS = new Set([
  'XA', 'XZ', 'PW', 'LL', 'LS', 'LH', 'MD', 'PR', 'PO', 'CI', 'CF',
  'FO', 'FT', 'FW', 'FB', 'FD', 'FS', 'FH', 'FR', 'FX',
  'A0', 'A@', 'GB', 'BY', 'BC', 'BX', 'BQ', 'PQ', 'F8', 'SN',
])

// Sürat şablonundaki font kullanımının TEK merkezî eşlemesi. Farklı
// dosyalarda kopyalanmaz. Sistemden sisteme aşırı sapmayı önlemek için
// açık ve dar bir yığın verilir.
export const ZPL_FONT_STACK =
  "'DejaVu Sans Mono','Liberation Mono','Consolas','Courier New',monospace"

export function resolveZplFontFamily(fontCode: string): string {
  // ^A0 (ölçeklenebilir) ve TT0003M_ gibi yerleşik Zebra fontları aynı
  // güvenli yığına eşlenir; Türkçe karakterler bozulmadan basılır.
  void fontCode
  return ZPL_FONT_STACK
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ^FH kullanıldığında _XX heksadesimal kaçışları çözülür (Türkçe karakterler
// kaynak ZPL'deki değerle AYNI kalır).
function decodeHexEscapes(value: string, marker: string): string {
  if (!marker) return value
  const pattern = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-fA-F]{2})`, 'g')
  const bytes: number[] = []
  let index = 0
  let out = ''
  const flush = () => {
    if (bytes.length === 0) return
    out += new TextDecoder('utf-8').decode(new Uint8Array(bytes))
    bytes.length = 0
  }
  while (index < value.length) {
    pattern.lastIndex = index
    const match = pattern.exec(value)
    if (match && match.index === index) {
      bytes.push(parseInt(match[1], 16))
      index += match[0].length
      continue
    }
    flush()
    out += value[index]
    index += 1
  }
  flush()
  return out
}

function num(value: string | undefined, fallback = 0): number {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : fallback
}

// ── Code128 kodlaması (payload KAYNAKTAN gelir, yeniden üretilmez) ────────
const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
]

/** Code128-B çubuk genişlik dizisi (modül cinsinden). */
export function encodeCode128B(value: string): number[] {
  const codes: number[] = [104] // START B
  let checksum = 104
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i) - 32
    if (code < 0 || code > 94) continue
    codes.push(code)
    checksum += code * (i + 1)
  }
  codes.push(checksum % 103)
  codes.push(106) // STOP
  const widths: number[] = []
  for (const code of codes) {
    for (const char of CODE128_PATTERNS[code] ?? '') {
      widths.push(Number(char))
    }
  }
  return widths
}

function renderCode128(
  x: number,
  y: number,
  data: string,
  moduleWidth: number,
  height: number,
  showText: boolean,
  fontSize: number,
): string {
  const widths = encodeCode128B(data)
  let cursor = x
  let dark = true
  const bars: string[] = []
  for (const width of widths) {
    const w = width * moduleWidth
    if (dark) {
      bars.push(
        `<rect x="${cursor}" y="${y}" width="${w}" height="${height}" fill="#000"/>`,
      )
    }
    cursor += w
    dark = !dark
  }
  const totalWidth = cursor - x
  const text = showText
    ? `<text x="${x + totalWidth / 2}" y="${y + height + fontSize}" ` +
      `font-family="${ZPL_FONT_STACK}" font-size="${fontSize}" ` +
      `text-anchor="middle" fill="#000" letter-spacing="2">${escapeXml(data)}</text>`
    : ''
  return bars.join('') + text
}

// ── QR / DataMatrix ───────────────────────────────────────────────────────
// PAYLOAD KAYNAK ZPL'DEN alınır ve UI/sipariş alanlarından ASLA yeniden
// üretilmez. İki üreteç de YEREL'dir:
//   ^BQ QR         → repoda zaten bulunan qrcode-generator (yeni bağımlılık YOK)
//   ^BX DataMatrix → CargoFlow içindeki ECC200 üreteci (dataMatrixEncoder.ts)
// Üretim başarısız olursa SESSİZ placeholder ÇİZİLMEZ: render açık durumla
// (matrix_encode_failed) reddedilir ve çağıran katman CargoFlow şablonuna
// düşmeyi önerir.
export interface MatrixCodeRenderer {
  (payload: string): boolean[][] | null
}

export interface MatrixDrawResult {
  svg: string
  /** false ise matris yerel olarak üretilemedi (placeholder ÇİZİLMEZ). */
  ok: boolean
}

function drawMatrix(
  x: number,
  y: number,
  modules: boolean[][] | null,
  moduleDots: number,
  quietModules: number,
  transform: string,
): MatrixDrawResult {
  if (!modules || modules.length === 0) return { svg: '', ok: false }
  const count = modules.length
  const cell = moduleDots
  const parts: string[] = []
  // QUIET ZONE: sembolün dört yanında `quietModules` modül genişliğinde
  // BEYAZ alan garanti edilir; komşu içerik sessiz alana taşamaz.
  if (quietModules > 0) {
    const quiet = quietModules * cell
    parts.push(
      `<rect x="${x - quiet}" y="${y - quiet}" ` +
        `width="${count * cell + quiet * 2}" height="${count * cell + quiet * 2}" ` +
        `fill="#fff"/>`,
    )
  }
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!modules[row][col]) continue
      parts.push(
        `<rect x="${x + col * cell}" y="${y + row * cell}" width="${cell}" height="${cell}" fill="#000"/>`,
      )
    }
  }
  const inner = parts.join('')
  return {
    svg: transform ? `<g${transform}>${inner}</g>` : inner,
    ok: true,
  }
}

export interface RenderOptions {
  /** Yerel QR üreteci (test edilebilirlik için). Ağ çağrısı YAPMAZ. */
  matrixRenderer?: MatrixCodeRenderer
}

/**
 * Varsayılan YEREL QR üreteci — repoda zaten bulunan `qrcode-generator`
 * paketini kullanır (yeni bağımlılık YOK, ağ çağrısı YOK).
 */
export const defaultMatrixRenderer: MatrixCodeRenderer = (payload) => {
  try {
    const qr = qrcode(0, 'M')
    qr.addData(payload || '-')
    qr.make()
    const count = qr.getModuleCount()
    return Array.from({ length: count }, (_, row) =>
      Array.from({ length: count }, (_, col) => qr.isDark(row, col)),
    )
  } catch {
    return null
  }
}

/**
 * YEREL DataMatrix (ECC200) üreteci. Payload kaynak ZPL'den gelir; burada
 * hiçbir alan yeniden türetilmez. Yalnız payload → matris dönüşümü yapar.
 */
export const defaultDataMatrixRenderer: MatrixCodeRenderer = (payload) => {
  const symbol = encodeDataMatrix(payload)
  return symbol ? symbol.modules : null
}

/** ^BX yalnız ECC200 (kalite 200) için birebir üretilebilir. */
export const DATA_MATRIX_ECC200_QUALITY = 200
/**
 * ECC200 zorunlu sessiz alanı: her kenarda 1 modül. DataMatrix için AÇIKÇA
 * çizilir. ^BQ QR'da sessiz alan kaynak etiket düzeninin kendi beyaz
 * boşluğundan gelir (Zebra ^BQ de sessiz alan çizmez); oraya beyaz dikdörtgen
 * basmak resmî çerçeveyi silerdi.
 */
export const DATA_MATRIX_QUIET_MODULES = 1

export function renderSuratZplToSvg(
  rawZpl: unknown,
  options: RenderOptions = {},
): SuratSvgRenderResult {
  const zpl = String(rawZpl ?? '')
  const base = {
    renderVersion: SURAT_SVG_RENDER_VERSION,
    widthDots: 799,
    heightDots: 799,
    widthMm: LABEL_MM,
    heightMm: LABEL_MM,
    warnings: [] as string[],
  }
  if (!zpl.trim()) {
    return { ...base, renderStatus: 'empty_source', svg: '', templateFingerprint: '' }
  }

  const geometry = parseSuratZplGeometry(zpl)
  const fingerprint = resolveSuratTemplateFingerprint(zpl, geometry)
  if (!fingerprint.supported) {
    return {
      ...base,
      renderStatus: 'unsupported_template',
      svg: '',
      templateFingerprint: fingerprint.signature,
      warnings: [`Bilinmeyen etiket şablonu (${fingerprint.reason ?? 'imza eşleşmedi'}).`],
    }
  }

  const printWidth = geometry.printWidth || 799
  const labelLength = geometry.labelLength || 799
  const warnings: string[] = []
  const body: string[] = []

  // ── ZPL komutlarını sırayla yorumla ─────────────────────────────────────
  let x = 0
  let y = 0
  let fontHeight = 20
  let fontWidth = 20
  let fontCode = '0'
  let rotated = false
  let fieldRotated = false
  let blockWidth = 0
  let blockLines = 1
  let hexMarker = ''
  let barcodeModule = 2
  let barcodeRatio = 3
  let barcodeHeight = 0
  let barcodeShowText = true
  let pending: 'text' | 'code128' | 'qr' | 'datamatrix' = 'text'
  let matrixModuleDots = 6
  let dataMatrixQuality = DATA_MATRIX_ECC200_QUALITY

  for (const token of zpl.split('^').slice(1)) {
    const command = token.slice(0, 2).toUpperCase()
    const args = token.slice(2)
    if (!SUPPORTED_COMMANDS.has(command)) {
      return {
        ...base,
        renderStatus: 'unsupported_command',
        svg: '',
        templateFingerprint: fingerprint.signature,
        unsupportedCommand: `^${command}`,
        warnings: [`Desteklenmeyen ZPL komutu: ^${command}`],
      }
    }
    switch (command) {
      case 'FW':
        rotated = /^[BR]/i.test(args)
        break
      case 'FO':
      case 'FT': {
        const [px, py] = args.split(',')
        x = num(px)
        y = num(py)
        fieldRotated = rotated
        blockWidth = 0
        blockLines = 1
        pending = 'text'
        break
      }
      case 'A0':
      case 'A@': {
        const parts = args.split(',')
        fontCode = command
        if (/^[BR]/i.test(String(parts[0] ?? ''))) fieldRotated = true
        fontHeight = num(parts[1], fontHeight)
        fontWidth = num(parts[2], fontHeight)
        break
      }
      case 'FH':
        hexMarker = args.slice(0, 1) || '_'
        break
      case 'FB': {
        const parts = args.split(',')
        blockWidth = num(parts[0], 0)
        blockLines = Math.max(1, num(parts[1], 1))
        break
      }
      case 'BY': {
        const parts = args.split(',')
        barcodeModule = num(parts[0], barcodeModule)
        barcodeRatio = num(parts[1], barcodeRatio)
        barcodeHeight = num(parts[2], barcodeHeight)
        break
      }
      case 'BC': {
        const parts = args.split(',')
        if (/^[BR]/i.test(String(parts[0] ?? ''))) fieldRotated = true
        barcodeHeight = num(parts[1], barcodeHeight || 100)
        barcodeShowText = String(parts[2] ?? 'Y').toUpperCase() !== 'N'
        pending = 'code128'
        break
      }
      case 'BQ': {
        // ^BQa,b,c → a: yön, b: model, c: büyütme (modül başına dot).
        const parts = args.split(',')
        if (/^[BR]/i.test(String(parts[0] ?? ''))) fieldRotated = true
        matrixModuleDots = Math.max(1, num(parts[2], 4))
        pending = 'qr'
        break
      }
      case 'BX': {
        // ^BXo,h,s → o: yön, h: modül kenarı (dot), s: kalite (200 = ECC200).
        const parts = args.split(',')
        if (/^[BR]/i.test(String(parts[0] ?? ''))) fieldRotated = true
        matrixModuleDots = Math.max(1, num(parts[1], 6))
        dataMatrixQuality = num(parts[2], DATA_MATRIX_ECC200_QUALITY)
        pending = 'datamatrix'
        break
      }
      case 'GB': {
        const parts = args.split(',')
        const width = num(parts[0])
        const height = num(parts[1])
        const thickness = Math.max(1, num(parts[2], 1))
        // Dış çerçeve GÖRSELDE ÇİZİLİR (footer fit ölçümünden ayrıdır).
        body.push(
          `<rect x="${x}" y="${y}" width="${Math.max(width, thickness)}" ` +
            `height="${Math.max(height, thickness)}" fill="none" stroke="#000" ` +
            `stroke-width="${thickness}"/>`,
        )
        break
      }
      case 'FD': {
        const raw = args.split('^')[0] ?? ''
        const data = decodeHexEscapes(raw, hexMarker)
        if (pending === 'code128') {
          body.push(
            renderCode128(
              x, y, data,
              barcodeModule,
              barcodeHeight || 100,
              barcodeShowText,
              Math.max(14, barcodeModule * 6),
            ),
          )
        } else if (pending === 'qr' || pending === 'datamatrix') {
          // ^BQ verisi "LA,payload" biçimindedir; payload AYNEN korunur.
          // ^BX verisi payload'ın KENDİSİDİR. İkisi de yalnız kaynak ZPL'den
          // gelir; sipariş/UI alanlarından türetilmez.
          const payload = pending === 'qr' ? data.replace(/^[A-Z]{2},/i, '') : data
          if (
            pending === 'datamatrix' &&
            dataMatrixQuality !== DATA_MATRIX_ECC200_QUALITY
          ) {
            // Kaynak sözleşmeye uymayan kalite seviyesi TAHMİNLE çizilmez.
            return {
              ...base,
              renderStatus: 'matrix_encode_failed',
              svg: '',
              templateFingerprint: fingerprint.signature,
              unsupportedCommand: '^BX',
              warnings: [
                `Desteklenmeyen DataMatrix kalite seviyesi (${dataMatrixQuality}); yalnız ECC200 üretilir.`,
              ],
            }
          }
          const renderer =
            pending === 'qr'
              ? (options.matrixRenderer ?? defaultMatrixRenderer)
              : defaultDataMatrixRenderer
          const drawn = drawMatrix(
            x,
            y,
            renderer(payload),
            matrixModuleDots,
            pending === 'datamatrix' ? DATA_MATRIX_QUIET_MODULES : 0,
            fieldRotated ? ` transform="rotate(-90 ${x} ${y})"` : '',
          )
          if (!drawn.ok) {
            // SESSİZ PLACEHOLDER YOK: boş/yanlış bir kare çizmek yerine
            // render açık durumla reddedilir.
            return {
              ...base,
              renderStatus: 'matrix_encode_failed',
              svg: '',
              templateFingerprint: fingerprint.signature,
              unsupportedCommand: pending === 'qr' ? '^BQ' : '^BX',
              warnings: ['Matris kod yerel olarak üretilemedi.'],
            }
          }
          body.push(drawn.svg)
        } else if (data.trim()) {
          const family = resolveZplFontFamily(fontCode)
          const transform = fieldRotated
            ? ` transform="rotate(-90 ${x} ${y})"`
            : ''
          if (blockWidth > 0 && blockLines > 1) {
            // ^FB: kelime bazlı sarma; metin KESİLMEZ.
            const charsPerLine = Math.max(
              1,
              Math.floor(blockWidth / Math.max(1, fontWidth * 0.6)),
            )
            const lines: string[] = []
            let current = ''
            for (const word of data.split(/\s+/)) {
              const next = current ? `${current} ${word}` : word
              if (next.length <= charsPerLine) current = next
              else {
                if (current) lines.push(current)
                current = word
              }
              if (lines.length >= blockLines) break
            }
            if (current && lines.length < blockLines) lines.push(current)
            lines.forEach((line, index) => {
              body.push(
                `<text x="${x}" y="${y + fontHeight * (index + 1)}" ` +
                  `font-family="${family}" font-size="${fontHeight}" ` +
                  `fill="#000"${transform}>${escapeXml(line)}</text>`,
              )
            })
          } else {
            body.push(
              `<text x="${x}" y="${y + fontHeight}" font-family="${family}" ` +
                `font-size="${fontHeight}" fill="#000"${transform}>${escapeXml(data)}</text>`,
            )
          }
        }
        pending = 'text'
        hexMarker = ''
        break
      }
      default:
        break
    }
  }

  // ÖLÇÜ SÖZLEŞMESİ: 100 × 100 mm etiket. viewBox ZPL dot uzayını AYNEN
  // taşır; preserveAspectRatio="none" ile 799 dot tam olarak 100 mm'ye
  // oturur (203 dpi'de 799 dot = 99.875 mm; yazıcı/sayfa ölçüsü 100 mm
  // olduğu için ölçek SVG içinde kesinleştirilir, tarayıcı ölçeklemesi YOK).
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${printWidth} ${labelLength}" ` +
    `width="${LABEL_MM}mm" height="${LABEL_MM}mm" ` +
    `preserveAspectRatio="none" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${printWidth}" height="${labelLength}" fill="#fff"/>` +
    body.join('') +
    `</svg>`

  return {
    renderStatus: 'ok',
    svg,
    renderVersion: SURAT_SVG_RENDER_VERSION,
    templateFingerprint: fingerprint.signature,
    widthDots: printWidth,
    heightDots: labelLength,
    widthMm: LABEL_MM,
    heightMm: LABEL_MM,
    warnings,
  }
}
