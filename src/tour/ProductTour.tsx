// ÜRÜN TURU KATMANI — odaklı, klavye erişilebilir, yan etkisiz.
//
// Tur YALNIZ mevcut navigasyonu çağırır ve açıklar: senkron, gönderi
// oluşturma, baskı, ayar kaydı/testi YAPMAZ ve hiçbir operasyon düğmesine
// tıklama BENZETİMİ yapmaz. İlerleme yalnız tur düğmeleriyledir.
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PageKey } from '../types/cargoflow'
import { tourTargetSelector, type ProductTourStep } from './productTourDefinition'
import {
  isHighlightable,
  isRectInViewport,
  placeTourCard,
  type TourRect,
  type TourSize,
} from './productTourGeometry'
import { TOUR_TARGET_TIMEOUT_MS, waitForTourTarget } from './waitForTourTarget'

const DEFAULT_CARD: TourSize = { width: 360, height: 230 }
const HIGHLIGHT_PADDING = 6

interface Resolution {
  index: number
  element: Element | null
  status: 'none' | 'found' | 'missing'
}

interface Geometry {
  index: number
  rect: TourRect | null
  viewport: TourSize
  card: TourSize
}

function viewportSize(): TourSize {
  return { width: window.innerWidth, height: window.innerHeight }
}

function toRect(element: Element | null): TourRect | null {
  if (!element) return null
  const box = element.getBoundingClientRect()
  return { top: box.top, left: box.left, width: box.width, height: box.height }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export function ProductTour({
  steps,
  onNavigate,
  onComplete,
  onDismiss,
  targetTimeoutMs = TOUR_TARGET_TIMEOUT_MS,
}: {
  steps: readonly ProductTourStep[]
  onNavigate: (page: PageKey) => void
  onComplete: () => void
  onDismiss: () => void
  targetTimeoutMs?: number
}) {
  const [index, setIndex] = useState(0)
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [previousFocus] = useState<Element | null>(() => document.activeElement)
  const cardRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()

  // En güncel geri çağrılar ref'te tutulur: üst bileşenin her render'ında
  // değişen işlev kimliği turu YENİDEN NAVİGE ETMEZ.
  const handlers = useRef({ onNavigate, onComplete, onDismiss })
  useEffect(() => {
    handlers.current = { onNavigate, onComplete, onDismiss }
  })

  const step = steps[index]
  const last = index === steps.length - 1

  // ── ADIMA GİR: mevcut navigasyon → sınırlı hedef bekleme ──────────────
  useEffect(() => {
    const controller = new AbortController()
    handlers.current.onNavigate(step.page)
    if (!step.target) {
      void Promise.resolve().then(() => {
        if (!controller.signal.aborted) setResolution({ index, element: null, status: 'none' })
      })
    } else {
      void waitForTourTarget(tourTargetSelector(step.target), {
        timeoutMs: targetTimeoutMs,
        signal: controller.signal,
      }).then((element) => {
        if (controller.signal.aborted) return
        const rect = toRect(element)
        // Yalnız GÖRÜNMEYEN hedef kaydırılır; her render'da kaydırma YOK.
        if (element && rect && rect.width > 0 && !isRectInViewport(rect, viewportSize())) {
          const scrollable = element as Element & {
            scrollIntoView?: (options?: ScrollIntoViewOptions) => void
          }
          scrollable.scrollIntoView?.({
            block: 'center',
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          })
        }
        setResolution({ index, element, status: element ? 'found' : 'missing' })
      })
    }
    return () => controller.abort()
  }, [index, step.page, step.target, targetTimeoutMs])

  // ── ÖLÇ: adım değişimi, yeniden boyutlandırma, kaydırma (rAF ile sınırlı) ──
  useEffect(() => {
    const element = resolution?.index === index ? resolution.element : null
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const cardBox = cardRef.current?.getBoundingClientRect()
        setGeometry({
          index,
          rect: toRect(element),
          viewport: viewportSize(),
          card:
            cardBox && cardBox.width > 0 && cardBox.height > 0
              ? { width: cardBox.width, height: cardBox.height }
              : DEFAULT_CARD,
        })
      })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [index, resolution])

  // ── ODAK: tura gir; kapanışta önceki odağa DÖN ────────────────────────
  useEffect(() => {
    primaryRef.current?.focus()
  }, [index])
  useEffect(
    () => () => {
      const back =
        previousFocus instanceof HTMLElement &&
        previousFocus !== document.body &&
        document.contains(previousFocus)
          ? previousFocus
          : document.querySelector<HTMLElement>('[data-tour-replay]')
      back?.focus()
    },
    [previousFocus],
  )

  // ── KLAVYE: Escape / oklar / Tab tuzağı ───────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handlers.current.onDismiss()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setIndex((current) => Math.max(0, current - 1))
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        // Son adımda ok tuşu turu BİTİRMEZ; bitiş açık düğmeyle.
        setIndex((current) => Math.min(steps.length - 1, current + 1))
        return
      }
      if (event.key === 'Tab') {
        const card = cardRef.current
        if (!card) return
        const focusables = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)]
        if (focusables.length === 0) return
        const first = focusables[0]
        const lastFocusable = focusables[focusables.length - 1]
        const activeInside = card.contains(document.activeElement)
        if (!activeInside) {
          event.preventDefault()
          first.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          lastFocusable.focus()
        } else if (!event.shiftKey && document.activeElement === lastFocusable) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [steps.length])

  // Önceki adımın geometrisi ASLA yeni adımda kullanılmaz.
  const current = geometry?.index === index ? geometry : null
  const viewport = current?.viewport ?? viewportSize()
  const highlightRect = current && isHighlightable(current.rect, viewport) ? current.rect : null
  const placement = placeTourCard(highlightRect, current?.card ?? DEFAULT_CARD, viewport)
  const missing = resolution?.index === index && resolution.status === 'missing'

  const stopBackground = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault()
    event.stopPropagation()
  }

  return createPortal(
    <div className="product-tour-layer" data-testid="product-tour-layer">
      <div
        className={highlightRect ? 'product-tour-blocker' : 'product-tour-blocker is-dimmed'}
        data-testid="product-tour-blocker"
        aria-hidden="true"
        onClick={stopBackground}
        onPointerDown={stopBackground}
      />
      {highlightRect ? (
        <div
          className="product-tour-highlight"
          data-testid="product-tour-highlight"
          aria-hidden="true"
          style={{
            top: highlightRect.top - HIGHLIGHT_PADDING,
            left: highlightRect.left - HIGHLIGHT_PADDING,
            width: highlightRect.width + HIGHLIGHT_PADDING * 2,
            height: highlightRect.height + HIGHLIGHT_PADDING * 2,
          }}
        />
      ) : null}
      <div
        ref={cardRef}
        className="product-tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="product-tour-card"
        data-placement={placement.placement}
        data-step={step.id}
        data-target-status={
          resolution?.index === index ? resolution.status : 'resolving'
        }
        style={{ top: placement.top, left: placement.left, width: placement.width }}
      >
        <div className="product-tour-card-head">
          <span className="product-tour-progress" aria-live="polite">
            {index + 1} / {steps.length}
          </span>
          <button
            type="button"
            className="product-tour-close"
            aria-label="Turu kapat"
            onClick={() => handlers.current.onDismiss()}
          >
            ×
          </button>
        </div>
        <h2 id={titleId}>{step.title}</h2>
        <p id={bodyId}>{step.body}</p>
        {missing ? (
          <p className="product-tour-note" role="note">
            Bu bölüm şu an görüntülenemiyor; açıklamayı okuyup devam edebilirsiniz.
          </p>
        ) : null}
        <div className="product-tour-actions">
          <button
            type="button"
            className="product-tour-skip"
            onClick={() => handlers.current.onDismiss()}
          >
            Turu Atla
          </button>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={index === 0}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
            >
              Geri
            </button>
            <button
              ref={primaryRef}
              type="button"
              className="primary-button"
              onClick={() =>
                last ? handlers.current.onComplete() : setIndex((value) => value + 1)
              }
            >
              {last ? 'Bitir' : 'İleri'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
