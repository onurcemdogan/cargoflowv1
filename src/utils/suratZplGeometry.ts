// Sürat resmî ZPL'inin GEOMETRİK ÖLÇÜMÜ — SAF (IO/DOM/ağ YOK).
//
// NEDEN ÖLÇÜM: ürün satırının nereye yazılacağı TAHMİN EDİLMEZ. Kaynak ZPL'in
// kendi komutları ayrıştırılıp resmî içeriğin gerçekte kapladığı en alt nokta
// hesaplanır; ürün satırı yalnız o noktanın ALTINDAKİ boş alana, ^LL sınırı
// içinde yerleştirilir. Böylece resmî alanların üzerine yazma riski ölçüyle
// elenir (görsele bakarak koordinat sabitlemek YERİNE).
//
// Ölçüm birimi ZPL nokta (dot). 203 dpi'de 1 mm ≈ 8 dot.
//
// DESTEKLENEN KOMUTLAR (Sürat şablonunda görülenler):
//   ^XA ^XZ ^PW ^LL ^LS ^CI ^FW
//   ^FO x,y   ^FT x,y            (konum)
//   ^A0<rot>,h,w  ^A@<rot>,h,w  ^A<font><rot>,h,w   (ölçeklenebilir font)
//   ^GB w,h,t                    (kutu/çizgi)
//   ^BY w,r,h                    (barkod varsayılanları)
//   ^BC<rot>,h,...               (Code128)
//   ^BQ / ^BX                    (QR / DataMatrix)
//   ^FB w,lines,space,just,indent
//   ^FD ... ^FS                  (veri)
// Tanınmayan komutlar ÖLÇÜMÜ BOZMAZ: yalnız yok sayılır, ancak fingerprint
// katmanı şablonun bilinen Sürat şablonu olduğunu ayrıca doğrular.

export interface ZplElementBox {
  x: number
  y: number
  width: number
  height: number
  /** Ölçümün hangi komuttan türediği (teşhis; PII içermez). */
  kind: 'text' | 'box' | 'barcode' | 'qr' | 'unknown'
  rotated: boolean
}

export interface ZplGeometry {
  ok: boolean
  printWidth: number
  labelLength: number
  elements: ZplElementBox[]
  /** Resmî içeriğin en alt kenarı (dot). */
  contentBottom: number
  /** Dikey sipariş rayının sağ kenarı (dot) — 0 ise ray bulunamadı. */
  leftRailRight: number
  /** İçerik alanının en sağ kenarı (dot). */
  contentRight: number
  reason?: string
}

const DEFAULT_PRINT_WIDTH = 799
const DEFAULT_LABEL_LENGTH = 799
// Döndürülmüş (B/R) alanlar sol rayı oluşturur; bu eşiğin solundaki dikey
// metinler "ray" sayılır.
const LEFT_RAIL_MAX_X = 120

function num(value: string | undefined, fallback = 0): number {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : fallback
}

// ^FD ... ^FS içeriğinin görünen uzunluğu (^FH heksadesimal kaçışları tek
// karakter sayılır; ölçüm şişmesin).
function visibleLength(data: string): number {
  return data.replace(/_[0-9a-fA-F]{2}/g, 'x').length
}

export function parseSuratZplGeometry(rawZpl: unknown): ZplGeometry {
  const zpl = String(rawZpl ?? '')
  const empty: ZplGeometry = {
    ok: false,
    printWidth: 0,
    labelLength: 0,
    elements: [],
    contentBottom: 0,
    leftRailRight: 0,
    contentRight: 0,
  }
  if (!zpl.trim()) return { ...empty, reason: 'ZPL boş.' }

  const printWidth = (() => {
    const match = zpl.match(/\^PW(\d+)/)
    return match ? num(match[1], DEFAULT_PRINT_WIDTH) : DEFAULT_PRINT_WIDTH
  })()
  const labelLength = (() => {
    const match = zpl.match(/\^LL(\d+)/)
    return match ? num(match[1], DEFAULT_LABEL_LENGTH) : DEFAULT_LABEL_LENGTH
  })()

  const elements: ZplElementBox[] = []
  // Komutları sırayla gez: ^ ile başlayan her token bir komuttur.
  const tokens = zpl.split('^').slice(1)
  let cursorX = 0
  let cursorY = 0
  let hasCursor = false
  /** Son konum komutu ^FT miydi (taban çizgisi) yoksa ^FO mu (üst kenar)? */
  let cursorIsBaseline = false
  let fontHeight = 20
  let fontWidth = 20
  let rotated = false
  let fieldRotated = false
  let barcodeModuleWidth = 2
  let barcodeHeight = 0
  let blockWidth = 0
  let blockLines = 1
  let pending: ZplElementBox['kind'] = 'text'

  for (const token of tokens) {
    const command = token.slice(0, 2).toUpperCase()
    const args = token.slice(2)

    if (command === 'FW') {
      rotated = /^[BR]/i.test(args)
      continue
    }
    if (command === 'FO' || command === 'FT') {
      const [x, y] = args.split(',')
      cursorX = num(x)
      cursorY = num(y)
      // ^FT taban çizgisi, ^FO üst kenar konumlandırır (ZPL II).
      cursorIsBaseline = command === 'FT'
      hasCursor = true
      pending = 'text'
      blockWidth = 0
      blockLines = 1
      fieldRotated = rotated
      continue
    }
    if (command === 'A0' || command === 'A@') {
      const parts = args.split(',')
      const orientation = String(parts[0] ?? '').replace(/^[^NRIB]*/i, '')
      if (/^[BR]/i.test(orientation)) fieldRotated = true
      fontHeight = num(parts[1], fontHeight)
      fontWidth = num(parts[2], fontHeight)
      continue
    }
    if (command === 'FB') {
      const parts = args.split(',')
      blockWidth = num(parts[0], 0)
      blockLines = Math.max(1, num(parts[1], 1))
      continue
    }
    if (command === 'BY') {
      const parts = args.split(',')
      barcodeModuleWidth = num(parts[0], barcodeModuleWidth)
      barcodeHeight = num(parts[2], barcodeHeight)
      continue
    }
    if (command === 'BC') {
      const parts = args.split(',')
      if (/^[BR]/i.test(String(parts[0] ?? ''))) fieldRotated = true
      barcodeHeight = num(parts[1], barcodeHeight || 100)
      pending = 'barcode'
      continue
    }
    if (command === 'BQ') {
      const parts = args.split(',')
      const magnification = num(parts[2], 4)
      barcodeHeight = magnification * 25
      pending = 'qr'
      continue
    }
    if (command === 'BX') {
      const parts = args.split(',')
      const moduleHeight = num(parts[1], 6)
      barcodeHeight = moduleHeight * 24
      pending = 'qr'
      continue
    }
    if (command === 'GB') {
      const parts = args.split(',')
      const width = num(parts[0])
      const height = num(parts[1])
      const thickness = num(parts[2], 1)
      if (hasCursor) {
        elements.push({
          x: cursorX,
          y: cursorY,
          width: Math.max(width, thickness),
          height: Math.max(height, thickness),
          kind: 'box',
          rotated: false,
        })
      }
      continue
    }
    if (command === 'FD') {
      if (!hasCursor) continue
      const data = args.split('^')[0] ?? ''
      const chars = visibleLength(data)
      if (pending === 'barcode') {
        // Code128: modül genişliği × (11 modül/karakter) + start/stop payı.
        const width = Math.round(barcodeModuleWidth * 11 * (chars + 4))
        elements.push({
          x: cursorX,
          y: cursorY,
          width,
          height: barcodeHeight || 100,
          kind: 'barcode',
          rotated: fieldRotated,
        })
      } else if (pending === 'qr') {
        const side = barcodeHeight || 100
        elements.push({
          x: cursorX,
          y: cursorY,
          width: side,
          height: side,
          kind: 'qr',
          rotated: fieldRotated,
        })
      } else {
        const lineWidth =
          blockWidth > 0 ? blockWidth : Math.round(chars * fontWidth * 0.62)
        const lines =
          blockWidth > 0
            ? Math.min(
                blockLines,
                Math.max(
                  1,
                  Math.ceil((chars * fontWidth * 0.62) / Math.max(1, blockWidth)),
                ),
              )
            : 1
        const lineHeight = Math.round(fontHeight * 1.15)
        const textHeight = lines * lineHeight
        // ^FO vs ^FT: ZPL'de ^FO y ALANIN ÜST kenarıdır, ^FT y ise TABAN
        // ÇİZGİSİDİR — metin taban çizgisinden YUKARI uzar, aşağıya yalnız
        // alt uzantı (descender) taşar.
        //
        // KÖK NEDEN (canlı 4057121401): ikisi de "üst kenar" sayılıyordu.
        // Etiketin en altındaki büyük ^FT metni (aktarma satırı, ~44 dot font)
        // için contentBottom bir font boyu FAZLA ölçülüyor, ürün footer'ına
        // kalan alan eksiye düşüyor ve augmentation still_overflow veriyordu.
        //
        // MUHAFAZAKÂR MODEL: taban çizgisinin ÜSTÜNDE tam font yüksekliği
        // (gerçek cap height daha küçüktür), ALTINDA %20 descender payı.
        // Böylece ölçü asla EKSİK çıkmaz; footer resmî içeriğe binmez.
        // Döndürülmüş metin (dikey sipariş rayı) DOKUNULMADAN bırakılır.
        const descender = Math.round(fontHeight * 0.2)
        const top =
          cursorIsBaseline && !fieldRotated
            ? Math.max(0, cursorY - fontHeight)
            : cursorY
        const height =
          cursorIsBaseline && !fieldRotated
            ? fontHeight + (lines - 1) * lineHeight + descender
            : textHeight
        elements.push({
          // Döndürülmüş metinde (dikey ray) genişlik/yükseklik yer değiştirir.
          x: cursorX,
          y: fieldRotated ? cursorY : top,
          width: fieldRotated ? Math.round(fontHeight * 1.15) : lineWidth,
          height: fieldRotated ? lineWidth : height,
          kind: 'text',
          rotated: fieldRotated,
        })
      }
      pending = 'text'
      continue
    }
  }

  if (elements.length === 0) {
    return { ...empty, printWidth, labelLength, reason: 'Ölçülebilir alan yok.' }
  }

  // CANLI REGRESYON KÖK NEDENİ: gerçek Sürat etiketinde bölümleri saran bir
  // DIŞ ÇERÇEVE (^GB) var ve neredeyse tüm etiketi kaplıyor. Çerçeve ÇİZGİDİR,
  // içerik DEĞİLDİR; içerik sayılınca contentBottom ~785 çıkıyor, ürün alanı
  // 0 kalıyor ve HER sipariş "sığmıyor" oluyordu. Etiketin büyük bölümünü
  // kaplayan kutular ölçümde yok sayılır (kutunun İÇİ boştur).
  const isFullLabelFrame = (element: ZplElementBox): boolean =>
    element.kind === 'box' &&
    element.width >= printWidth * 0.8 &&
    element.height >= labelLength * 0.6
  // AYNI SINIF, İKİNCİ BİÇİM: etiket boyunca uzanan İNCE DİKEY ÇİZGİ
  // (^GB0,h,t ile çizilen sütun ayırıcı / ray kenarı). Çerçeve gibi bu da
  // ÇİZGİDİR, içerik DEĞİLDİR.
  const isFullHeightRule = (element: ZplElementBox): boolean =>
    element.kind === 'box' &&
    element.height >= labelLength * 0.6 &&
    element.width <= 12
  // ÜÇÜNCÜ BİÇİM: sol dikey SİPARİŞ RAYI metni. Ray etiketin solunda baştan
  // sona uzanan YAPISAL bir şerittir ve footer alanı zaten rayın SAĞINDAN
  // başlar (resolveFooterArea → x = leftRailRight + gap). Ölçüm rayı aşağı
  // doğru uzuyor sayıp contentBottom'ı etiketin dışına taşıyordu.
  const isLeftRail = (element: ZplElementBox): boolean =>
    element.rotated && element.x <= LEFT_RAIL_MAX_X
  // KÖK NEDEN: bu üç yapısal öge "içerik" sayıldığında contentBottom etiketin
  // dibine yapışıyor, footer yüksekliği 0 kalıyor ve ürün satırı HİÇBİR
  // siparişe eklenemiyordu ("Ürün satırı eklenemedi" uyarısının sebebi).
  // Ölçüm yalnızca DARALTILDI; hiçbir yeni öge içerik sayılmaya başlamadı,
  // bu yüzden resmî alanların üzerine yazma riski ARTMAZ.
  const contentElements = elements.filter(
    (element) =>
      !isFullLabelFrame(element) &&
      !isFullHeightRule(element) &&
      !isLeftRail(element),
  )
  const contentBottom = (
    contentElements.length > 0 ? contentElements : elements
  ).reduce((bottom, element) => Math.max(bottom, element.y + element.height), 0)
  const contentRight = elements.reduce(
    (right, element) => Math.max(right, element.x + element.width),
    0,
  )
  const leftRailRight = elements
    .filter((element) => element.rotated && element.x <= LEFT_RAIL_MAX_X)
    .reduce((right, element) => Math.max(right, element.x + element.width), 0)

  return {
    ok: true,
    printWidth,
    labelLength,
    elements,
    contentBottom,
    leftRailRight,
    contentRight,
  }
}
