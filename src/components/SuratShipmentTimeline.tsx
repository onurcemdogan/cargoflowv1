import type { CargoOrder } from '../types/cargoflow'
import { buildSuratShipmentTimeline } from '../utils/suratShipmentTimeline'

// Salt-okunur zaman çizelgesi: modeli utils/suratShipmentTimeline üretir;
// bu component yalnız render eder, API çağrısı yapmaz.
export function SuratShipmentTimeline({ order }: { order: CargoOrder }) {
  const steps = buildSuratShipmentTimeline(order)
  return (
    <ol className="surat-timeline" aria-label="Kargo zaman çizelgesi">
      {steps.map((step) => (
        <li
          key={step.key}
          className={`surat-timeline-step surat-timeline-${step.status}`}
        >
          <span className="surat-timeline-dot" aria-hidden="true" />
          <div className="surat-timeline-copy">
            <div className="surat-timeline-head">
              <strong>{step.label}</strong>
              <span className="surat-timeline-time">
                {step.timestamp || '—'}
              </span>
            </div>
            <span className="surat-timeline-description">
              {step.description}
            </span>
          </div>
        </li>
      ))}
    </ol>
  )
}
