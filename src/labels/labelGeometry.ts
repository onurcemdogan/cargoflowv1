// FİZİKSEL GEOMETRİ — TEK DÖNÜŞTÜRÜCÜ.
//
// ═══ NEDEN TEK YER ═══════════════════════════════════════════════════════
// Etiket üç ayrı koordinat sisteminde yaşar:
//   1. FİZİKSEL   — milimetre (kanonik; belgede saklanan tek birim)
//   2. EKRAN      — piksel (yakınlaştırmaya bağlı, GEÇİCİ)
//   3. YAZICI     — dot (203 dpi termal)
//
// Bu dönüşümler bileşenlere dağılırsa kaçınılmaz olarak ayrışır: önizlemede
// doğru görünen bir yerleşim baskıda kayar. Bu yüzden dönüştürme YALNIZ
// buradadır ve hem düzenleyici hem baskı yolu aynı fonksiyonları kullanır.
//
// ═══ YAKINLAŞTIRMA GEOMETRİYİ DEĞİŞTİRMEZ ════════════════════════════════
// `zoom` yalnız EKRAN piksel oranını etkiler. Kaydedilen belge milimetre
// cinsindendir; %200 yakınlaştırmada sürüklenen bir öğe %100'dekiyle AYNI
// fiziksel konuma gider.

/** Etiket fiziksel ölçüsü — 10 cm × 10 cm. */
export const LABEL_CANVAS_WIDTH_MM = 100
export const LABEL_CANVAS_HEIGHT_MM = 100

/** Termal yazıcı çözünürlüğü (Sürat/Zebra yerleşimiyle uyumlu). */
export const LABEL_PRINTER_DPI = 203

const MM_PER_INCH = 25.4

/** Ekranda %100 yakınlaştırmada 1 mm kaç CSS pikselidir. */
export const BASE_PX_PER_MM = 3.78

/** Okunabilirlik tabanları (mm). Bunların altı OKUNMAZ, otomatik küçültme YOK. */
export const MIN_ELEMENT_SIZE_MM = 3
export const MIN_BARCODE_WIDTH_MM = 25
export const MIN_BARCODE_HEIGHT_MM = 8
export const MIN_QR_SIZE_MM = 10

/** Yakalama (snap) ızgarası — mm. */
export const SNAP_GRID_MM = 1
/** Hizalama kılavuzu tolerans eşiği — mm. */
export const ALIGNMENT_SNAP_TOLERANCE_MM = 0.8

export function mmToDots(mm: number, dpi: number = LABEL_PRINTER_DPI): number {
  return Math.round((mm / MM_PER_INCH) * dpi)
}

export function dotsToMm(dots: number, dpi: number = LABEL_PRINTER_DPI): number {
  return (dots / dpi) * MM_PER_INCH
}

export function mmToPx(mm: number, zoom = 1): number {
  return mm * BASE_PX_PER_MM * zoom
}

export function pxToMm(px: number, zoom = 1): number {
  return px / (BASE_PX_PER_MM * zoom)
}

/** Punto (pt) → milimetre. Tipografi de fiziksel ölçüye bağlanır. */
export function ptToMm(pt: number): number {
  return (pt / 72) * MM_PER_INCH
}

export function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * 72
}

/** Izgaraya yakala. `grid = 0` → yakalama YOK (serbest konumlandırma). */
export function snapToGrid(mm: number, grid: number = SNAP_GRID_MM): number {
  if (!Number.isFinite(grid) || grid <= 0) return mm
  return Math.round(mm / grid) * grid
}

export function clampToCanvas(
  value: number,
  size: number,
  axis: 'x' | 'y',
): number {
  const limit =
    (axis === 'x' ? LABEL_CANVAS_WIDTH_MM : LABEL_CANVAS_HEIGHT_MM) - size
  return Math.min(Math.max(0, limit), Math.max(0, value))
}

export interface RectMm {
  x: number
  y: number
  width: number
  height: number
}

export function rectsOverlap(left: RectMm, right: RectMm): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  )
}

export function rectWithinCanvas(rect: RectMm): boolean {
  return (
    rect.x >= -0.001 &&
    rect.y >= -0.001 &&
    rect.x + rect.width <= LABEL_CANVAS_WIDTH_MM + 0.001 &&
    rect.y + rect.height <= LABEL_CANVAS_HEIGHT_MM + 0.001
  )
}
