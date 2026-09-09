// ZPL METİN GEOMETRİSİ — ÜST ÜSTE BİNME DEDEKTÖRÜ.
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
// Üretimde görülen hata şuydu: taşıyıcının kendi adres metni ile CargoFlow'un
// eklediği bold kopya AYNI taban çizgisine, AYNI x'e çiziliyordu. İki farklı
// font (bitmap `A0` genişlik 25 ve TrueType `A@` genişlik 10) aynı yerde
// üst üste binince adres OKUNAMAZ hale geliyordu.
//
// O hata "gözle bakınca" fark edilmişti. Bir daha SESSİZCE dönmemesi için
// binme, çıktı üstünde ÖLÇÜLEBİLİR olmalıdır. Bu modül ZPL alanlarının
// işgal kutularını hesaplar ve kesişenleri bildirir.
//
// ═══ NEDEN PİKSEL DEĞİL GEOMETRİ ═════════════════════════════════════════
// Piksel karşılaştırması render motoruna bağlıdır ve motor sürümü değişince
// kırılgandır. Alan geometrisi ZPL'in KENDİSİNDEN gelir: `^FT` taban çizgisi,
// font yüksekliği ve metin genişliği. Bu ölçüm motordan BAĞIMSIZDIR ve
// hangi alanların çakıştığını İSİMLE söyler — "bir yerde bir şey bozuk"
// demekle yetinmez.
//
// SAF: ağ yok, DOM yok, render yok.

import {
  collectZplFields,
  parseZplDocument,
  type ZplField,
} from './zplCommandModel.ts'

/** Etiket alanının dot cinsinden işgal kutusu. */
export interface ZplTextBox {
  readonly field: ZplField
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ZplTextOverlap {
  readonly left: ZplTextBox
  readonly right: ZplTextBox
  /** Kesişen alanın dot² cinsinden büyüklüğü. */
  readonly area: number
}

/**
 * Ortalama karakter ilerlemesi — font genişliğine ORANLA.
 *
 * ÖLÇÜLDÜ (yerel zebrash render, `A0` w=25, 49 karakter): mürekkep 63→679
 * dot, yani karakter başına ~12.6 dot ≈ genişliğin yarısı. Oran temkinli
 * seçilir: FAZLA geniş tahmin yanlış alarm üretir, FAZLA dar tahmin gerçek
 * binmeyi kaçırır. Kaçırmamak önceliklidir, bu yüzden hafif YÜKSEK tutulur.
 */
const ADVANCE_RATIO = 0.55

/** Aynı alanın çift vuruşu (bold taklidi) binme SAYILMAZ. */
const DOUBLE_STRIKE_TOLERANCE = 2

function textWidth(text: string, fontWidth: number): number {
  return Math.ceil(text.length * fontWidth * ADVANCE_RATIO)
}

/**
 * `^FT` taban çizgisi TABANDIR: alan taban çizgisinden YUKARI doğru font
 * yüksekliği kadar uzanır. `^FO` ise SOL ÜST köşedir. İkisi karıştırılırsa
 * kutular bir satır kayar ve dedektör yanlış cevap verir.
 */
export function fieldTextBox(field: ZplField): ZplTextBox | null {
  if (field.kind !== 'text') return null
  const text = String(field.data ?? '')
  if (text.trim() === '') return null
  const cell = field.font?.height ?? 0
  const fontWidth = field.font?.width ?? 0
  if (cell <= 0 || fontWidth <= 0) return null
  const run = textWidth(text, fontWidth)
  const orientation = field.font?.orientation ?? 'N'
  const rotated = orientation === 'B' || orientation === 'R'
  const width = rotated ? cell : run
  const height = rotated ? run : cell

  // ═══ DÖNDÜRÜLMÜŞ `^FT` ALANI HANGİ YÖNE UZAR ════════════════════════
  //
  // `^FO` SOL ÜST köşedir: yönelim ne olursa olsun kutu origin'den SAĞA ve
  // AŞAĞI uzar; yalnız en/boy takas edilir.
  //
  // `^FT` TABAN ÇİZGİSİDİR ve yönelimle birlikte DÖNER. Bu, gerçek render
  // ile ölçülmüştür (799×799, `^A0*,20,28`, origin 400,400):
  //
  //     N : mürekkep x 401..588, y 385..399  → [x, x+run] × [y-cell, y]
  //     B : mürekkep x 385..403, y 211..398  → [x-cell, x] × [y-run, y]
  //     R : mürekkep x 396..414, y 401..588  → [x, x+cell] × [y, y+run]
  //     I : mürekkep x 211..398, y 396..414  → [x-run, x] × [y, y+cell]
  //
  // ═══ NEDEN ÖNEMLİ ═══════════════════════════════════════════════════
  // Kod, döndürülmüş alanı KOŞULSUZ `x` sağına ve `y` yukarısına koyuyordu.
  // Gerçek şablonun dikey "ALICI" başlığı (^FT54,430 A0B) bu yüzden
  // [54..77] şeridinde sanılıyordu; GERÇEKTE [31..54] şeridindedir. Yani
  // dedektör dikey alanlar için 23 dotluk YANLIŞ bir sütuna bakıyordu:
  // gerçek binmeyi kaçırabilir, olmayan binmeyi uydurabilirdi.
  const anchorsRight = orientation === 'B' || orientation === 'I'
  const anchorsBottom = orientation === 'N' || orientation === 'B'
  const left =
    field.positionType === 'FT' && anchorsRight ? field.x - width : field.x
  const top =
    field.positionType === 'FT' && anchorsBottom ? field.y - height : field.y
  return { field, text, x: left, y: top, width, height }
}

/**
 * KOMŞULUK BİNME DEĞİLDİR.
 *
 * Etiket tasarımı satırları sıkı yerleştirir; iki satırın kutuları bir-iki
 * dot değebilir ve baskıda bu SORUN DEĞİLDİR. Gerçek hata metnin metnin
 * ÜSTÜNE çizilmesidir. Ayırt edici ölçü, kesişimin küçük kutunun DİKEY
 * yüksekliğine oranıdır: üst üste basılan iki satırda bu oran ~1.0, komşu
 * iki satırda ~0.02'dir. Eşik ikisinin ARASINDA, ayrımın net olduğu yerde.
 */
const VERTICAL_SUPERPOSITION_RATIO = 0.5

/**
 * YATAY ÖLÇÜT — genişlik TAHMİN olduğu için gereklidir.
 *
 * Metin genişliği karakter sayısından TAHMİN edilir; orantılı fontta bu birkaç
 * dot şaşabilir. Yan yana duran iki alanın kutuları bu şaşma yüzünden birkaç
 * dot çakışabilir — bu binme DEĞİLDİR. Gerçek süperpozisyonda küçük kutunun
 * yatay uzunluğunun BÜYÜK bölümü örtüşür.
 */
const HORIZONTAL_SUPERPOSITION_RATIO = 0.25

function intersectionArea(left: ZplTextBox, right: ZplTextBox): number {
  const x0 = Math.max(left.x, right.x)
  const x1 = Math.min(left.x + left.width, right.x + right.width)
  const y0 = Math.max(left.y, right.y)
  const y1 = Math.min(left.y + left.height, right.y + right.height)
  if (x1 <= x0 || y1 <= y0) return 0
  const verticalOverlap = y1 - y0
  const horizontalOverlap = x1 - x0
  const minHeight = Math.min(left.height, right.height)
  const minWidth = Math.min(left.width, right.width)
  if (minHeight <= 0 || minWidth <= 0) return 0
  if (verticalOverlap / minHeight < VERTICAL_SUPERPOSITION_RATIO) return 0
  if (horizontalOverlap / minWidth < HORIZONTAL_SUPERPOSITION_RATIO) return 0
  return horizontalOverlap * verticalOverlap
}

/**
 * AYNI metnin çift vuruşu mu?
 *
 * Composer bold taklidi için aynı alanı +1 dot kaydırarak iki kez çizer.
 * Bu KASITLIDIR ve binme değildir.
 *
 * ═══ FONT EŞİTLİĞİ ŞARTTIR ═════════════════════════════════════════════
 * Yalnız "metin aynı + kayma ≤ 2 dot" demek YETMEZ ve TEHLİKELİDİR: üretimde
 * görülen hata tam olarak aynı metnin FARKLI fontlarla (taşıyıcının bitmap
 * `A0` genişlik 25'i ile bizim TrueType `A@` genişlik 10'umuz) aynı taban
 * çizgisine çizilmesiydi. Font kontrolü olmadan dedektör bu gerçek binmeyi
 * "kasıtlı bold vuruşu" sanıp SESSİZCE geçiyordu.
 *
 * Çift vuruş, aynı alanın kopyasıdır: font ailesi, yüksekliği ve genişliği
 * de AYNI olmalıdır. Farklı font = farklı çizim = gerçek binme.
 */
function isDoubleStrike(left: ZplTextBox, right: ZplTextBox): boolean {
  if (left.text !== right.text) return false
  if (Math.abs(left.x - right.x) > DOUBLE_STRIKE_TOLERANCE) return false
  if (Math.abs(left.y - right.y) > DOUBLE_STRIKE_TOLERANCE) return false
  const leftFont = left.field.font
  const rightFont = right.field.font
  return (
    leftFont?.command === rightFont?.command &&
    leftFont?.height === rightFont?.height &&
    leftFont?.width === rightFont?.width &&
    leftFont?.fontName === rightFont?.fontName
  )
}

/** ZPL'deki tüm görünür metin alanlarının işgal kutuları. */
export function zplTextBoxes(zpl: string): ZplTextBox[] {
  const fields = collectZplFields(parseZplDocument(String(zpl ?? '')))
  const boxes: ZplTextBox[] = []
  for (const field of fields) {
    const box = fieldTextBox(field)
    if (box) boxes.push(box)
  }
  return boxes
}

/**
 * Üst üste binen metin çiftleri.
 *
 * `minArea` gürültü eşiğidir: bitişik alanların bir-iki dot değmesi baskıda
 * sorun DEĞİLDİR. Gerçek binme (bir harfin üstüne başka harf) çok daha
 * büyük bir kesişim üretir.
 */
export function findZplTextOverlaps(
  zpl: string,
  minArea = 24,
): ZplTextOverlap[] {
  const boxes = zplTextBoxes(zpl)
  const overlaps: ZplTextOverlap[] = []
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const left = boxes[i]
      const right = boxes[j]
      if (isDoubleStrike(left, right)) continue
      const area = intersectionArea(left, right)
      if (area >= minArea) overlaps.push({ left, right, area })
    }
  }
  return overlaps.sort((a, b) => b.area - a.area)
}

/** İnsan-okunur özet — test hatasında NE çakıştığını söyler. */
export function describeOverlap(overlap: ZplTextOverlap): string {
  const at = (box: ZplTextBox) =>
    `"${box.text}" @(${box.x},${box.y} ${box.width}x${box.height})`
  return `${at(overlap.left)} ↔ ${at(overlap.right)} [kesişim ${overlap.area} dot²]`
}
