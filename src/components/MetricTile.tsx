import type { ReactNode } from 'react'

interface MetricTileProps {
  label: string
  value: string | number
  helper: string
  icon?: ReactNode
  tone?: 'teal' | 'blue' | 'amber' | 'green' | 'red' | 'violet'
  onClick?: () => void
}

export function MetricTile({
  label,
  value,
  helper,
  icon,
  tone = 'teal',
  onClick,
}: MetricTileProps) {
  const content = (
    <>
      <div className="dashboard-metric-top">
        <span>{label}</span>
        {icon ? <i>{icon}</i> : null}
      </div>
      <strong>{value}</strong>
      <small>{helper}</small>
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        className={`metric-tile dashboard-metric ${tone} clickable`}
        onClick={onClick}
      >
        {content}
      </button>
    )
  }
  return <div className={`metric-tile dashboard-metric ${tone}`}>{content}</div>
}
