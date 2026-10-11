// ÜRÜN TURU GEOMETRİSİ — saf fonksiyonlar (DOM okumaz, test edilebilir).

export interface TourRect {
  top: number
  left: number
  width: number
  height: number
}

export interface TourSize {
  width: number
  height: number
}

export type TourPlacement = 'below' | 'above' | 'center'

export const TOUR_MARGIN = 12
export const TOUR_GAP = 12

/** Hedef gerçekten vurgulanabilir mi? (boyutsuz/gizli hedef → hayır) */
export function isHighlightable(rect: TourRect | null, viewport: TourSize): rect is TourRect {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false
  // Görünür alanla hiç kesişmiyorsa (kaydırma sonrası bile) ortalanır.
  return (
    rect.top < viewport.height &&
    rect.top + rect.height > 0 &&
    rect.left < viewport.width &&
    rect.left + rect.width > 0
  )
}

export function isRectInViewport(rect: TourRect, viewport: TourSize): boolean {
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.top + rect.height <= viewport.height &&
    rect.left + rect.width <= viewport.width
  )
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * Kartı görünüm alanı İÇİNDE konumlar: yer varsa hedefin altına, yoksa
 * üstüne, o da yoksa güvenli ortaya. Kart asla ekran dışına taşmaz.
 */
export function placeTourCard(
  target: TourRect | null,
  card: TourSize,
  viewport: TourSize,
): { top: number; left: number; width: number; placement: TourPlacement } {
  const width = Math.max(0, Math.min(card.width, viewport.width - TOUR_MARGIN * 2))
  const height = Math.min(card.height, Math.max(0, viewport.height - TOUR_MARGIN * 2))
  const centered = () => ({
    top: clamp((viewport.height - height) / 2, TOUR_MARGIN, viewport.height - height - TOUR_MARGIN),
    left: clamp((viewport.width - width) / 2, TOUR_MARGIN, viewport.width - width - TOUR_MARGIN),
    width,
    placement: 'center' as const,
  })
  if (!isHighlightable(target, viewport)) return centered()

  const left = clamp(target.left, TOUR_MARGIN, viewport.width - width - TOUR_MARGIN)
  const below = target.top + target.height + TOUR_GAP
  if (below + height <= viewport.height - TOUR_MARGIN) {
    return { top: below, left, width, placement: 'below' }
  }
  const above = target.top - TOUR_GAP - height
  if (above >= TOUR_MARGIN) {
    return { top: above, left, width, placement: 'above' }
  }
  return centered()
}
