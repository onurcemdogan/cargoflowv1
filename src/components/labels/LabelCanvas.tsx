// 10×10 cm GERÇEK DÜZENLEME YÜZEYİ.
//
// ═══ NEDEN AYRI BİR ÜST KATMAN ═══════════════════════════════════════════
// İçerik (`LabelPrimitiveLayer`) ile ETKİLEŞİM (seçim kutusu, tutamaçlar)
// ayrı katmanlardadır. İçeriğin üstüne tutamaç çizmek, baskıda görünmeyecek
// bir şeyi baskı yoluna karıştırmak demek olurdu. Burada içerik kutusu
// baskıdakiyle AYNI ilkellerden gelir; üst katman YALNIZ düzenleyicide
// vardır ve baskı yoluna HİÇ girmez.
//
// ═══ NEDEN YAKINLAŞTIRMA GEOMETRİYİ DEĞİŞTİRMEZ ══════════════════════════
// Fare hareketi piksel cinsindendir; `pxToMm(dx, zoom)` ile milimetreye
// çevrilir ve BELGEYE milimetre yazılır. %200'de sürüklenen bir öğe
// %100'dekiyle AYNI fiziksel konuma gider.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { LabelDocument, LabelElement } from '../../labels/labelDocument'
import { minimumSizeMm } from '../../labels/labelDocument'
import type { LabelPrimitive } from '../../labels/labelDocumentRenderer'
import {
  ALIGNMENT_SNAP_TOLERANCE_MM,
  LABEL_CANVAS_HEIGHT_MM,
  LABEL_CANVAS_WIDTH_MM,
  SNAP_GRID_MM,
  mmToPx,
  pxToMm,
  snapToGrid,
} from '../../labels/labelGeometry'
import { LabelPrimitiveLayer } from './LabelPrimitiveLayer'

type ResizeHandle =
  | 'nw' | 'n' | 'ne'
  | 'w' | 'e'
  | 'sw' | 's' | 'se'

const RESIZE_HANDLES: ResizeHandle[] = [
  'nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se',
]

interface DragState {
  elementId: string
  mode: 'move' | ResizeHandle
  startX: number
  startY: number
  origin: { x: number; y: number; width: number; height: number }
}

export interface AlignmentGuide {
  axis: 'x' | 'y'
  positionMm: number
}

interface LabelCanvasProps {
  document: LabelDocument
  primitives: LabelPrimitive[]
  zoom: number
  selectedId?: string
  /** Izgara yakalaması açık mı? */
  snapEnabled: boolean
  onSelect: (elementId: string | undefined) => void
  onGestureStart: () => void
  onGestureEnd: () => void
  onElementChange: (elementId: string, patch: Partial<LabelElement>) => void
}

export function LabelCanvas({
  document: doc,
  primitives,
  zoom,
  selectedId,
  snapEnabled,
  onSelect,
  onGestureStart,
  onGestureEnd,
  onElementChange,
}: LabelCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<{ id: string; patch: Partial<LabelElement> } | null>(
    null,
  )
  const [guides, setGuides] = useState<AlignmentGuide[]>([])

  const elementsById = useMemo(() => {
    const map = new Map<string, LabelElement>()
    for (const element of doc.elements) map.set(element.id, element)
    return map
  }, [doc.elements])

  // Hizalama adaylari: diger GORUNUR ogelerin kenarlari ve merkezleri.
  const alignmentCandidates = useCallback(
    (excludeId: string) => {
      const xs: number[] = [0, LABEL_CANVAS_WIDTH_MM / 2, LABEL_CANVAS_WIDTH_MM]
      const ys: number[] = [0, LABEL_CANVAS_HEIGHT_MM / 2, LABEL_CANVAS_HEIGHT_MM]
      for (const element of doc.elements) {
        if (element.id === excludeId || element.visible === false) continue
        xs.push(element.x, element.x + element.width / 2, element.x + element.width)
        ys.push(element.y, element.y + element.height / 2, element.y + element.height)
      }
      return { xs, ys }
    },
    [doc.elements],
  )

  const flush = useCallback(() => {
    frameRef.current = null
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) onElementChange(pending.id, pending.patch)
  }, [onElementChange])

  const schedule = useCallback(
    (id: string, patch: Partial<LabelElement>) => {
      pendingRef.current = { id, patch }
      // Her pointermove'da tam bir yeniden cizim TETIKLENMEZ; kare basina
      // TEK guncelleme yapilir. Surukleme boylece akici kalir.
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush)
      }
    },
    [flush],
  )

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    elementId: string,
    mode: DragState['mode'],
  ) {
    const element = elementsById.get(elementId)
    if (!element) return
    event.preventDefault()
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    dragRef.current = {
      elementId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      },
    }
    onSelect(elementId)
    onGestureStart()
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag) return
    event.preventDefault()
    const dxMm = pxToMm(event.clientX - drag.startX, zoom)
    const dyMm = pxToMm(event.clientY - drag.startY, zoom)
    const min = minimumSizeMm(
      elementsById.get(drag.elementId)?.type ?? 'staticText',
    )

    let next = { ...drag.origin }
    if (drag.mode === 'move') {
      next.x = drag.origin.x + dxMm
      next.y = drag.origin.y + dyMm
    } else {
      if (drag.mode.includes('e')) next.width = drag.origin.width + dxMm
      if (drag.mode.includes('s')) next.height = drag.origin.height + dyMm
      if (drag.mode.includes('w')) {
        next.x = drag.origin.x + dxMm
        next.width = drag.origin.width - dxMm
      }
      if (drag.mode.includes('n')) {
        next.y = drag.origin.y + dyMm
        next.height = drag.origin.height - dyMm
      }
      // ASGARI OLCU: tutamaci ters yone cekmek ogeyi YOK ETMEZ; olcu
      // tabanda durur ve karsi kenar SABIT kalir (siçrama olmaz).
      if (next.width < min.width) {
        if (drag.mode.includes('w')) {
          next.x = drag.origin.x + drag.origin.width - min.width
        }
        next.width = min.width
      }
      if (next.height < min.height) {
        if (drag.mode.includes('n')) {
          next.y = drag.origin.y + drag.origin.height - min.height
        }
        next.height = min.height
      }
    }

    // Izgara + hizalama yakalamasi.
    const activeGuides: AlignmentGuide[] = []
    if (snapEnabled) {
      const { xs, ys } = alignmentCandidates(drag.elementId)
      const snapEdge = (value: number, candidates: number[]) => {
        for (const candidate of candidates) {
          if (Math.abs(value - candidate) <= ALIGNMENT_SNAP_TOLERANCE_MM) {
            return candidate
          }
        }
        return null
      }
      const snappedLeft = snapEdge(next.x, xs)
      const snappedRight = snapEdge(next.x + next.width, xs)
      const snappedTop = snapEdge(next.y, ys)
      const snappedBottom = snapEdge(next.y + next.height, ys)

      if (drag.mode === 'move') {
        if (snappedLeft !== null) {
          next.x = snappedLeft
          activeGuides.push({ axis: 'x', positionMm: snappedLeft })
        } else if (snappedRight !== null) {
          next.x = snappedRight - next.width
          activeGuides.push({ axis: 'x', positionMm: snappedRight })
        } else {
          next.x = snapToGrid(next.x, SNAP_GRID_MM)
        }
        if (snappedTop !== null) {
          next.y = snappedTop
          activeGuides.push({ axis: 'y', positionMm: snappedTop })
        } else if (snappedBottom !== null) {
          next.y = snappedBottom - next.height
          activeGuides.push({ axis: 'y', positionMm: snappedBottom })
        } else {
          next.y = snapToGrid(next.y, SNAP_GRID_MM)
        }
      } else {
        next.x = snapToGrid(next.x, SNAP_GRID_MM)
        next.y = snapToGrid(next.y, SNAP_GRID_MM)
        next.width = snapToGrid(next.width, SNAP_GRID_MM)
        next.height = snapToGrid(next.height, SNAP_GRID_MM)
      }
    }

    // TUVAL SINIRI: oge disariya CIKAMAZ (negatif/tasan geometri olusmaz).
    next.width = Math.min(next.width, LABEL_CANVAS_WIDTH_MM)
    next.height = Math.min(next.height, LABEL_CANVAS_HEIGHT_MM)
    next.x = Math.min(
      Math.max(0, next.x),
      LABEL_CANVAS_WIDTH_MM - next.width,
    )
    next.y = Math.min(
      Math.max(0, next.y),
      LABEL_CANVAS_HEIGHT_MM - next.height,
    )

    next = {
      x: round2(next.x),
      y: round2(next.y),
      width: round2(Math.max(min.width, next.width)),
      height: round2(Math.max(min.height, next.height)),
    }
    setGuides(activeGuides)
    schedule(drag.elementId, next)
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current) return
    try {
      ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
    } catch {
      // Yakalama zaten birakildiysa akisi bozma.
    }
    // Bekleyen kare varsa ONCE uygula: birakma aninda konum SIÇRAMAZ.
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      flush()
    }
    dragRef.current = null
    setGuides([])
    onGestureEnd()
  }

  const widthPx = mmToPx(LABEL_CANVAS_WIDTH_MM, zoom)
  const heightPx = mmToPx(LABEL_CANVAS_HEIGHT_MM, zoom)

  return (
    <div
      className="label-canvas-viewport"
      data-testid="label-canvas-viewport"
      onPointerDown={() => onSelect(undefined)}
    >
      <div
        ref={surfaceRef}
        className="label-canvas-surface"
        data-testid="label-canvas"
        data-width-mm={LABEL_CANVAS_WIDTH_MM}
        data-height-mm={LABEL_CANVAS_HEIGHT_MM}
        data-zoom={zoom}
        style={{
          width: `${widthPx}px`,
          height: `${heightPx}px`,
          backgroundSize: `${mmToPx(10, zoom)}px ${mmToPx(10, zoom)}px`,
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <LabelPrimitiveLayer primitives={primitives} zoom={zoom} />

        {guides.map((guide) => (
          <div
            key={`${guide.axis}-${guide.positionMm}`}
            className={`label-guide label-guide-${guide.axis}`}
            data-testid="label-alignment-guide"
            style={
              guide.axis === 'x'
                ? { left: `${mmToPx(guide.positionMm, zoom)}px` }
                : { top: `${mmToPx(guide.positionMm, zoom)}px` }
            }
          />
        ))}

        {doc.elements
          .filter((element) => element.visible !== false)
          .map((element) => {
            const selected = element.id === selectedId
            return (
              <div
                key={element.id}
                role="button"
                tabIndex={0}
                aria-label={`${element.type} öğesi`}
                aria-pressed={selected}
                data-testid={`label-element-${element.id}`}
                data-element-id={element.id}
                data-element-type={element.type}
                data-x-mm={element.x}
                data-y-mm={element.y}
                data-width-mm={element.width}
                data-height-mm={element.height}
                className={`label-element-frame${selected ? ' is-selected' : ''}`}
                style={{
                  left: `${mmToPx(element.x, zoom)}px`,
                  top: `${mmToPx(element.y, zoom)}px`,
                  width: `${mmToPx(element.width, zoom)}px`,
                  height: `${mmToPx(element.height, zoom)}px`,
                }}
                onPointerDown={(event) => beginDrag(event, element.id, 'move')}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 5 : 0.5
                  const move = (dx: number, dy: number) => {
                    event.preventDefault()
                    onElementChange(element.id, {
                      x: round2(
                        Math.min(
                          LABEL_CANVAS_WIDTH_MM - element.width,
                          Math.max(0, element.x + dx),
                        ),
                      ),
                      y: round2(
                        Math.min(
                          LABEL_CANVAS_HEIGHT_MM - element.height,
                          Math.max(0, element.y + dy),
                        ),
                      ),
                    })
                  }
                  if (event.key === 'ArrowLeft') move(-step, 0)
                  else if (event.key === 'ArrowRight') move(step, 0)
                  else if (event.key === 'ArrowUp') move(0, -step)
                  else if (event.key === 'ArrowDown') move(0, step)
                  else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(element.id)
                  }
                }}
              >
                {selected
                  ? RESIZE_HANDLES.map((handle) => (
                      <span
                        key={handle}
                        role="button"
                        tabIndex={-1}
                        aria-label={`Boyutlandır ${handle}`}
                        data-testid={`label-handle-${element.id}-${handle}`}
                        className={`label-resize-handle label-resize-${handle}`}
                        onPointerDown={(event) =>
                          beginDrag(event, element.id, handle)
                        }
                      />
                    ))
                  : null}
              </div>
            )
          })}
      </div>
    </div>
  )
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
