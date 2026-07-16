import JsBarcode from 'jsbarcode'
import { useEffect, useRef } from 'react'

interface BarcodePreviewProps {
  value: string
  height?: number
  displayValue?: boolean
  width?: number
  margin?: number
  fontSize?: number
  className?: string
}

export function BarcodePreview({
  value,
  height = 92,
  displayValue = true,
  width = 2,
  margin = 8,
  fontSize = 16,
  className,
}: BarcodePreviewProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    if (!svgRef.current || !value) return

    try {
      JsBarcode(svgRef.current, value, {
        format: 'CODE128',
        height,
        width,
        margin,
        displayValue,
        fontSize,
        textMargin: 4,
      })
    } catch {
      svgRef.current.replaceChildren()
    }
  }, [displayValue, fontSize, height, margin, value, width])

  if (!value) return <p className="empty-state">Barkod değeri yok.</p>

  return (
    <div className={`barcode-svg-wrap ${className ?? ''}`}>
      <svg ref={svgRef} role="img" aria-label={`Code128 barkod ${value}`} />
    </div>
  )
}
