import qrcode from 'qrcode-generator'
import { useMemo } from 'react'

interface QrCodeSvgProps {
  value: string
  title: string
  className?: string
}

export function QrCodeSvg({ value, title, className }: QrCodeSvgProps) {
  const modules = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(value || '-')
    qr.make()

    const moduleCount = qr.getModuleCount()
    const cells: Array<{ x: number; y: number }> = []
    for (let y = 0; y < moduleCount; y += 1) {
      for (let x = 0; x < moduleCount; x += 1) {
        if (qr.isDark(y, x)) cells.push({ x, y })
      }
    }
    return { moduleCount, cells }
  }, [value])

  const quietZone = 3
  const viewBoxSize = modules.moduleCount + quietZone * 2

  return (
    <svg
      className={className}
      role="img"
      aria-label={title}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      shapeRendering="crispEdges"
    >
      <title>{title}</title>
      <rect width={viewBoxSize} height={viewBoxSize} fill="#fff" />
      {modules.cells.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x + quietZone}
          y={cell.y + quietZone}
          width="1"
          height="1"
          fill="#111"
        />
      ))}
    </svg>
  )
}
