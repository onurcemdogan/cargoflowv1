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
  /**
   * Çizilen her öğenin ÖLÇÜLMÜŞ sınırlayıcı kutusu (dot). SVG dizesini
   * ayrıştırmadan landmark karşılaştırması yapılabilsin diye üretilir;
   * kaynak ZPL semantiğinin doğrudan çıktısıdır.
   */
  elements: SuratRenderedElement[]
}

export interface SuratRenderedElement {
  kind: 'box' | 'line' | 'text' | 'barcode' | 'matrix'
  /** Sol üst köşe (dot, etiket koordinat uzayı). */
  x: number
  y: number
  width: number
  height: number
  /** ZPL alan dönüşü (0 / 90 / 180 / 270, saat yönü). */
  rotation: number
  /** Metin/barkod içeriği — teşhis amaçlı; LOGLANMAZ. */
  text?: string
  /** Metin taban çizgisi (dot) — ^FO/^FT farkı burada görünür. */
  baseline?: number
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

// ═══ ZPL ALAN SEMANTİĞİ ════════════════════════════════════════════════════
//
// Koordinatlar ETİKET ALANINA GÖRE ELLE yeniden kurulmaz; her şey kaynak
// ZPL komutundan türetilir.
//
//   ^FO x,y  FIELD ORIGIN  → (x,y) alanın SOL ÜST köşesidir. Metinde
//                            karakter hücresinin ÜSTÜ y'dedir; taban çizgisi
//                            y + ascent kadar aşağıdadır.
//   ^FT x,y  FIELD TYPESET → (x,y) TABAN ÇİZGİSİDİR. Barkodda çubukların ALT
//                            kenarı, matris kodda sembolün ALT kenarıdır.
//
// KÖK NEDEN (önceki sürüm): ^FT ile ^FO ayrımı YOKTU ve her metnin taban
// çizgisi y + TAM karakter yüksekliğine konuyordu. Sonuç: metinler olması
// gerekenden ~0.22 karakter yüksekliği kadar AŞAĞIDA çıkıyor, gönderici
// bloğu ile barkod arasında fazladan boşluk oluşuyordu.

/**
 * Karakter hücresinin üstünden taban çizgisine oran. Zebra ölçeklenebilir
 * fontunda (CG Triumvirate) istenen karakter yüksekliği HÜCRE yüksekliğidir;
 * taban çizgisi hücrenin üstünden yaklaşık bu oran kadar aşağıdadır.
 */
export const ZPL_TEXT_ASCENT_RATIO = 0.78
/**
 * Monospace yığında ortalama ilerleme genişliğinin em'e oranı. ^FB satır
 * kırılımı ve ölçülen metin genişliği bu orandan hesaplanır.
 */
export const ZPL_TEXT_ADVANCE_RATIO = 0.6
/** Çubuklarla insan-okur satır arasındaki boşluk (dot). */
export const BARCODE_TEXT_GAP = 4

type ZplRotation = 0 | 90 | 180 | 270

/** ^FW / alan komutlarındaki N,R,I,B → saat yönünde derece. */
export function resolveZplRotation(code: unknown, fallback: ZplRotation = 0): ZplRotation {
  const letter = String(code ?? '').trim().charAt(0).toUpperCase()
  if (letter === 'N') return 0
  if (letter === 'R') return 90
  if (letter === 'I') return 180
  if (letter === 'B') return 270
  return fallback
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Alan dönüşü + yatay ölçek için SVG transform listesi.
 * Liste SOLDAN SAĞA yazılır ve SAĞDAN SOLA uygulanır: önce yerel yatay
 * ölçekleme, sonra alan orijini etrafında döndürme.
 */
function fieldTransform(
  rotation: ZplRotation,
  anchorX: number,
  anchorY: number,
  scaleX: number,
): string {
  const parts: string[] = []
  if (rotation !== 0) parts.push(`rotate(${rotation} ${round(anchorX)} ${round(anchorY)})`)
  if (scaleX !== 1) {
    parts.push(
      `translate(${round(anchorX)} 0)`,
      `scale(${round(scaleX)} 1)`,
      `translate(${round(-anchorX)} 0)`,
    )
  }
  return parts.length > 0 ? ` transform="${parts.join(' ')}"` : ''
}

interface FieldState {
  /** Alan orijini (^FO) veya taban çizgisi (^FT) noktası. */
  x: number
  y: number
  /** ^FT ile açıldıysa true. */
  typeset: boolean
  rotation: ZplRotation
}

interface FontState {
  /** ^A0/^A@ karakter YÜKSEKLİĞİ (dot). */
  height: number
  /** ^A0/^A@ karakter GENİŞLİĞİ (dot). 0 → yükseklikle aynı. */
  width: number
  code: string
}

interface BlockState {
  /** ^FB blok genişliği (dot); 0 → sarma yok. */
  width: number
  /** ^FB en fazla satır. */
  lines: number
  /** ^FB satırlar arası ek boşluk (dot). */
  lineGap: number
  justify: 'L' | 'C' | 'R' | 'J'
}

interface DrawResult {
  svg: string
  elements: SuratRenderedElement[]
}

// ── METİN ──────────────────────────────────────────────────────────────────
function drawText(
  field: FieldState,
  font: FontState,
  block: BlockState,
  data: string,
): DrawResult {
  const height = Math.max(1, font.height)
  // ^A0h,w: w verilmezse (0) genişlik yüksekliğe eşittir.
  const width = font.width > 0 ? font.width : height
  const scaleX = width === height ? 1 : width / height
  const advance = ZPL_TEXT_ADVANCE_RATIO * width
  const ascent = height * ZPL_TEXT_ASCENT_RATIO

  // ^FB sarma: blok genişliği verildiyse kelime bazlı, en fazla `lines` satır.
  const lines: string[] = []
  if (block.width > 0) {
    const perLine = Math.max(1, Math.floor(block.width / Math.max(1, advance)))
    let current = ''
    for (const word of data.split(/\s+/).filter(Boolean)) {
      const next = current ? `${current} ${word}` : word
      if (next.length <= perLine) {
        current = next
        continue
      }
      if (current) lines.push(current)
      current = word
      if (lines.length >= block.lines) break
    }
    if (current && lines.length < block.lines) lines.push(current)
  } else {
    lines.push(data)
  }
  if (lines.length === 0) return { svg: '', elements: [] }

  const lineHeight = height + block.lineGap
  const family = resolveZplFontFamily(font.code)
  // ^FB hizalama: L/J sola, C ortaya, R sağa.
  const anchorAttribute =
    block.justify === 'C' ? 'middle' : block.justify === 'R' ? 'end' : 'start'
  const textX =
    block.justify === 'C'
      ? field.x + block.width / 2
      : block.justify === 'R'
        ? field.x + block.width
        : field.x
  // ^FT taban çizgisiyle, ^FO hücre üstüyle hizalanır.
  const firstBaseline = field.typeset ? field.y : field.y + ascent
  const transform = fieldTransform(field.rotation, field.x, field.y, scaleX)

  const parts: string[] = []
  let minX = Infinity
  let maxX = -Infinity
  lines.forEach((line, index) => {
    const baseline = firstBaseline + index * lineHeight
    // scaleX alan orijini etrafinda uygulandigindan hizalama noktasi geri
    // hesaplanir: field.x + (xUser - field.x) * scaleX === textX
    const anchorUserX =
      scaleX === 1 ? textX : field.x + (textX - field.x) / scaleX
    parts.push(
      `<text x="${round(anchorUserX)}" y="${round(baseline)}" ` +
        `font-family="${family}" font-size="${round(height)}" fill="#000" ` +
        `text-anchor="${anchorAttribute}" xml:space="preserve">${escapeXml(line)}</text>`,
    )
    const lineWidth = line.length * advance
    const startX =
      block.justify === 'C'
        ? textX - lineWidth / 2
        : block.justify === 'R'
          ? textX - lineWidth
          : textX
    minX = Math.min(minX, startX)
    maxX = Math.max(maxX, startX + lineWidth)
  })

  const top = firstBaseline - ascent
  const totalHeight = height + (lines.length - 1) * lineHeight
  return {
    svg: transform
      ? `<g${transform}>${parts.join('')}</g>`
      : parts.join(''),
    elements: [
      {
        kind: 'text',
        x: round(minX),
        y: round(top),
        width: round(maxX - minX),
        height: round(totalHeight),
        rotation: field.rotation,
        text: lines.join(' '),
        baseline: round(firstBaseline),
      },
    ],
  }
}

// ── ^GB KUTU / ÇİZGİ ───────────────────────────────────────────────────────
//
// ^GBw,h,t : w×h DIŞ ölçüsünde, kenarlığı İÇERİ doğru t kalınlığında kutu.
// w veya h kalınlıktan küçük/eşitse ZPL bunu DOLU BİR ÇİZGİ olarak basar:
//   ^GB0,height,thickness  → DİKEY çizgi
//   ^GBwidth,0,thickness   → YATAY çizgi
// KÖK NEDEN (eksik çizgiler): önceki sürüm her ^GB'yi `fill="none"` konturlu
// dikdörtgen olarak çiziyordu. Sıfır genişlikli/yükseklikli çizgiler bu
// yüzden ya hiç görünmüyor ya da içi boş bir çerçeve olarak çıkıyordu;
// bölüm ayırıcılarının tamamı kayboluyordu.
function drawGraphicBox(
  field: FieldState,
  args: string,
): DrawResult {
  const parts = args.split(',')
  const thickness = Math.max(1, num(parts[2], 1))
  const width = num(parts[0], thickness)
  const height = num(parts[1], thickness)
  const color = String(parts[3] ?? 'B').trim().toUpperCase().startsWith('W')
    ? '#fff'
    : '#000'
  const transform = fieldTransform(field.rotation, field.x, field.y, 1)

  if (width <= thickness || height <= thickness) {
    // DOLU ÇİZGİ (dikey veya yatay).
    const lineWidth = Math.max(width, thickness)
    const lineHeight = Math.max(height, thickness)
    const svg =
      `<rect x="${round(field.x)}" y="${round(field.y)}" ` +
      `width="${round(lineWidth)}" height="${round(lineHeight)}" fill="${color}"/>`
    return {
      svg: transform ? `<g${transform}>${svg}</g>` : svg,
      elements: [
        {
          kind: 'line',
          x: round(field.x),
          y: round(field.y),
          width: round(lineWidth),
          height: round(lineHeight),
          rotation: field.rotation,
        },
      ],
    }
  }

  // KUTU: dış ölçü w×h, kenarlık İÇERİ. SVG kontur merkezlendiği için
  // t/2 kadar içeri kaydırılır; böylece dış sınır tam olarak w×h olur.
  const inset = thickness / 2
  const svg =
    `<rect x="${round(field.x + inset)}" y="${round(field.y + inset)}" ` +
    `width="${round(width - thickness)}" height="${round(height - thickness)}" ` +
    `fill="none" stroke="${color}" stroke-width="${round(thickness)}"/>`
  return {
    svg: transform ? `<g${transform}>${svg}</g>` : svg,
    elements: [
      {
        kind: 'box',
        x: round(field.x),
        y: round(field.y),
        width: round(width),
        height: round(height),
        rotation: field.rotation,
      },
    ],
  }
}

// ── ^BC CODE 128 ───────────────────────────────────────────────────────────
function drawCode128(
  field: FieldState,
  data: string,
  moduleWidth: number,
  barHeight: number,
  showText: boolean,
  interpretationHeight: number,
): DrawResult {
  const widths = encodeCode128B(data)
  const totalModules = widths.reduce((total, value) => total + value, 0)
  const totalWidth = totalModules * moduleWidth
  // ^FT: y çubukların ALT kenarıdır. ^FO: y çubukların ÜST kenarıdır.
  const top = field.typeset ? field.y - barHeight : field.y
  const parts: string[] = []
  let cursor = field.x
  let dark = true
  for (const modules of widths) {
    const barWidth = modules * moduleWidth
    if (dark) {
      parts.push(
        `<rect x="${round(cursor)}" y="${round(top)}" ` +
          `width="${round(barWidth)}" height="${round(barHeight)}" fill="#000"/>`,
      )
    }
    cursor += barWidth
    dark = !dark
  }
  let bottom = top + barHeight
  if (showText) {
    // Yorum satırı ZPL'de aktif fontla basılır ve çubukların ALTINDA yer alır.
    const ascent = interpretationHeight * ZPL_TEXT_ASCENT_RATIO
    const baseline = top + barHeight + BARCODE_TEXT_GAP + ascent
    parts.push(
      `<text x="${round(field.x + totalWidth / 2)}" y="${round(baseline)}" ` +
        `font-family="${ZPL_FONT_STACK}" font-size="${round(interpretationHeight)}" ` +
        `text-anchor="middle" fill="#000">${escapeXml(data)}</text>`,
    )
    bottom = top + barHeight + BARCODE_TEXT_GAP + interpretationHeight
  }
  const transform = fieldTransform(field.rotation, field.x, field.y, 1)
  const svg = parts.join('')
  return {
    svg: transform ? `<g${transform}>${svg}</g>` : svg,
    elements: [
      {
        kind: 'barcode',
        x: round(field.x),
        y: round(top),
        width: round(totalWidth),
        height: round(bottom - top),
        rotation: field.rotation,
        text: data,
      },
    ],
  }
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
  (payload: string, errorCorrection?: string): boolean[][] | null
}

function drawMatrix(
  field: FieldState,
  modules: boolean[][] | null,
  moduleDots: number,
  quietModules: number,
): DrawResult | null {
  if (!modules || modules.length === 0) return null
  const count = modules.length
  const side = count * moduleDots
  // ^FT: y sembolün ALT kenarıdır. ^FO: ÜST kenarı.
  const top = field.typeset ? field.y - side : field.y
  const parts: string[] = []
  // QUIET ZONE: sembolün dört yanında `quietModules` modül genişliğinde
  // BEYAZ alan garanti edilir; komşu içerik sessiz alana taşamaz.
  if (quietModules > 0) {
    const quiet = quietModules * moduleDots
    parts.push(
      `<rect x="${round(field.x - quiet)}" y="${round(top - quiet)}" ` +
        `width="${round(side + quiet * 2)}" height="${round(side + quiet * 2)}" ` +
        `fill="#fff"/>`,
    )
  }
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!modules[row][col]) continue
      parts.push(
        `<rect x="${round(field.x + col * moduleDots)}" y="${round(top + row * moduleDots)}" ` +
          `width="${round(moduleDots)}" height="${round(moduleDots)}" fill="#000"/>`,
      )
    }
  }
  const transform = fieldTransform(field.rotation, field.x, field.y, 1)
  const svg = parts.join('')
  return {
    svg: transform ? `<g${transform}>${svg}</g>` : svg,
    elements: [
      {
        kind: 'matrix',
        x: round(field.x),
        y: round(top),
        width: round(side),
        height: round(side),
        rotation: field.rotation,
      },
    ],
  }
}

export interface RenderOptions {
  /** Yerel QR üreteci (test edilebilirlik için). Ağ çağrısı YAPMAZ. */
  matrixRenderer?: MatrixCodeRenderer
}

/**
 * Varsayılan YEREL QR üreteci — repoda zaten bulunan `qrcode-generator`
 * paketini kullanır (yeni bağımlılık YOK, ağ çağrısı YOK).
 * Hata düzeltme seviyesi KAYNAK ^FD ön ekinden gelir ("LA,..." → L); sabit
 * bir seviye VARSAYILMAZ, çünkü seviye modül sayısını ve dolayısıyla
 * sembolün sınırlayıcı kutusunu doğrudan değiştirir.
 */
export const defaultMatrixRenderer: MatrixCodeRenderer = (payload, errorCorrection) => {
  const level =
    errorCorrection === 'L' || errorCorrection === 'M' ||
    errorCorrection === 'Q' || errorCorrection === 'H'
      ? errorCorrection
      : 'M'
  try {
    const qr = qrcode(0, level)
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
/** 203 dpi yazıcıda ^BQ büyütme varsayılanı (Zebra ZPL kılavuzu). */
export const QR_DEFAULT_MAGNIFICATION = 2

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
    elements: [] as SuratRenderedElement[],
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
  const elements: SuratRenderedElement[] = []

  // ── Yazıcı/etiket düzeyi durum ────────────────────────────────────────
  let homeX = 0
  let homeY = 0
  let shiftLeft = 0
  let defaultRotation: ZplRotation = 0

  // ── Alan düzeyi durum (^FS ile sıfırlanır) ────────────────────────────
  let field: FieldState = { x: 0, y: 0, typeset: false, rotation: 0 }
  // Zebra ^CF varsayilani: yerlesik font A (9 x 5 dot). ^A gormeyen alanlar
  // ve barkod yorum satiri bu fontu kullanir.
  let font: FontState = { height: 9, width: 5, code: 'A' }
  let defaultFont: FontState = { height: 9, width: 5, code: 'A' }
  let block: BlockState = { width: 0, lines: 1, lineGap: 0, justify: 'L' }
  let hexMarker = ''
  let barcodeModule = 2
  let barcodeHeight = 0
  let barcodeShowText = true
  let pending: 'text' | 'code128' | 'qr' | 'datamatrix' = 'text'
  let matrixModuleDots = 0
  let dataMatrixQuality = DATA_MATRIX_ECC200_QUALITY

  const resetField = () => {
    block = { width: 0, lines: 1, lineGap: 0, justify: 'L' }
    hexMarker = ''
    pending = 'text'
    font = { ...defaultFont }
    field = { ...field, rotation: defaultRotation, typeset: false }
  }

  const push = (result: DrawResult | null) => {
    if (!result) return
    body.push(result.svg)
    elements.push(...result.elements)
  }

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
      case 'LH': {
        // ^LHx,y — etiket başlangıcı; TÜM alanlar bu kadar ötelenir.
        const parts = args.split(',')
        homeX = num(parts[0], 0)
        homeY = num(parts[1], 0)
        break
      }
      case 'LS':
        // ^LSa — basılan görüntüyü SOLA kaydırır (x_efektif = x - a).
        shiftLeft = num(args, 0)
        break
      case 'CF': {
        // ^CFf,h,w — varsayılan font. Sonraki alanlar ^A görmezse bunu kullanır.
        const parts = args.split(',')
        defaultFont = {
          code: String(parts[0] ?? 'A').trim() || 'A',
          height: num(parts[1], defaultFont.height),
          width: num(parts[2], 0),
        }
        font = { ...defaultFont }
        break
      }
      case 'FW':
        defaultRotation = resolveZplRotation(args, defaultRotation)
        field = { ...field, rotation: defaultRotation }
        break
      case 'FO':
      case 'FT': {
        const parts = args.split(',')
        field = {
          x: num(parts[0]) + homeX - shiftLeft,
          y: num(parts[1]) + homeY,
          typeset: command === 'FT',
          rotation: defaultRotation,
        }
        block = { width: 0, lines: 1, lineGap: 0, justify: 'L' }
        pending = 'text'
        break
      }
      case 'A0':
      case 'A@': {
        // ^A0o,h,w — o: yön, h: karakter yüksekliği, w: karakter genişliği.
        const parts = args.split(',')
        field = { ...field, rotation: resolveZplRotation(parts[0], field.rotation) }
        font = {
          code: command,
          height: num(parts[1], font.height),
          width: num(parts[2], 0),
        }
        break
      }
      case 'FH':
        hexMarker = args.slice(0, 1) || '_'
        break
      case 'FB': {
        // ^FBa,b,c,d — a: blok genişliği, b: satır sayısı,
        // c: satırlar arası ek boşluk, d: hizalama.
        const parts = args.split(',')
        block = {
          width: num(parts[0], 0),
          lines: Math.max(1, num(parts[1], 1)),
          lineGap: num(parts[2], 0),
          justify: (String(parts[3] ?? 'L').trim().toUpperCase().charAt(0) ||
            'L') as BlockState['justify'],
        }
        break
      }
      case 'BY': {
        const parts = args.split(',')
        // ^BYw,r,h — w: modul genisligi, r: genis/dar orani, h: varsayilan
        // yukseklik. Code 128 SABIT genislikli bir simgelemedir; `r` orani
        // Code 128'de KULLANILMAZ (yalniz 2-of-5 turevlerinde anlamlidir),
        // bu yuzden burada saklanmaz.
        barcodeModule = Math.max(1, num(parts[0], barcodeModule))
        barcodeHeight = num(parts[2], barcodeHeight)
        break
      }
      case 'BC': {
        // ^BCo,h,f,g,e,m — o: yön, h: yükseklik, f: yorum satırı.
        const parts = args.split(',')
        field = { ...field, rotation: resolveZplRotation(parts[0], field.rotation) }
        barcodeHeight = num(parts[1], barcodeHeight || 100)
        barcodeShowText = String(parts[2] ?? 'Y').trim().toUpperCase() !== 'N'
        pending = 'code128'
        break
      }
      case 'BQ': {
        // ^BQa,b,c — a: yön, b: model, c: büyütme (modül başına dot).
        const parts = args.split(',')
        field = { ...field, rotation: resolveZplRotation(parts[0], field.rotation) }
        matrixModuleDots = Math.max(1, num(parts[2], QR_DEFAULT_MAGNIFICATION))
        pending = 'qr'
        break
      }
      case 'BX': {
        // ^BXo,h,s — o: yön, h: modül kenarı (varsayılan ^BY modül genişliği),
        // s: kalite (200 = ECC200).
        const parts = args.split(',')
        field = { ...field, rotation: resolveZplRotation(parts[0], field.rotation) }
        matrixModuleDots = Math.max(1, num(parts[1], barcodeModule))
        dataMatrixQuality = num(parts[2], DATA_MATRIX_ECC200_QUALITY)
        pending = 'datamatrix'
        break
      }
      case 'GB':
        push(drawGraphicBox(field, args))
        break
      case 'FS':
        resetField()
        break
      case 'FD': {
        const raw = args.split('^')[0] ?? ''
        const data = decodeHexEscapes(raw, hexMarker)
        if (pending === 'code128') {
          push(
            drawCode128(
              field,
              data,
              barcodeModule,
              barcodeHeight || 100,
              barcodeShowText,
              font.height,
            ),
          )
        } else if (pending === 'qr' || pending === 'datamatrix') {
          // ^BQ verisi "<hata düzeltme><giriş modu>,payload" biçimindedir;
          // ^BX verisi payload'ın KENDİSİDİR. İkisi de yalnız kaynak ZPL'den
          // gelir; sipariş/UI alanlarından türetilmez.
          const qrMatch = /^([HQML])([AM]),([\s\S]*)$/.exec(data)
          const payload = pending === 'qr' && qrMatch ? qrMatch[3] : data
          const errorCorrection = pending === 'qr' && qrMatch ? qrMatch[1] : undefined
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
            field,
            renderer(payload, errorCorrection),
            matrixModuleDots || barcodeModule,
            pending === 'datamatrix' ? DATA_MATRIX_QUIET_MODULES : 0,
          )
          if (!drawn) {
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
          push(drawn)
        } else if (data.trim()) {
          push(drawText(field, font, block, data))
        }
        pending = 'text'
        hexMarker = ''
        break
      }
      default:
        break
    }
  }

  // SINIR KONTROLÜ: hiçbir öğe etiket alanının dışına taşmamalı. Taşma
  // SESSİZ bırakılmaz; koordinatlar KEYFİ olarak kaydırılmaz (kaynak ZPL tek
  // doğrudur), yalnız güvenli bir uyarı üretilir.
  for (const element of elements) {
    if (element.rotation !== 0) continue
    if (
      element.x < 0 ||
      element.y < 0 ||
      element.x + element.width > printWidth ||
      element.y + element.height > labelLength
    ) {
      warnings.push(
        `Kaynak ZPL'de etiket alanını aşan öğe (${element.kind}); kaydırma YAPILMADI.`,
      )
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
    elements,
  }
}
