// ORTAK ARAYÜZ İLKELLERİ — tanıtım sayfasıyla aynı tasarım sistemi.
//
// Görünüm `index.css` içindeki `ui-*` kurallarındadır; eski ekranların
// sınıfları (primary-button, panel, data-table, status-badge…) AYNI
// kurallara bağlıdır, böylece eski ve yeni ekranlar tek sistemden çıkar.
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'label'

/* ── Button ───────────────────────────────────────────────────────────── */
export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  busy?: boolean
}) {
  return (
    <button
      type="button"
      {...rest}
      aria-busy={busy || undefined}
      className={['ui-btn', `ui-btn-${variant}`, size !== 'md' ? `ui-btn-${size}` : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  )
}

/* ── Badge ────────────────────────────────────────────────────────────── */
export function Badge({ tone = 'neutral', dot = false, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className={dot ? `ui-badge tone-${tone} has-dot` : `ui-badge tone-${tone}`}>{children}</span>
}

/* ── Card ─────────────────────────────────────────────────────────────── */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  as: Tag = 'section',
  labelledBy,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article' | 'aside'
  labelledBy?: string
}) {
  return (
    <Tag className={['ui-card', className ?? ''].filter(Boolean).join(' ')} aria-labelledby={labelledBy}>
      {title || actions ? (
        <header className="ui-card-head">
          <div>
            {title ? <h2 id={labelledBy}>{title}</h2> : null}
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {actions ? <div className="ui-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </Tag>
  )
}

/* ── Spinner / Progress ───────────────────────────────────────────────── */
export function Spinner() {
  return <i className="ui-spinner" aria-hidden="true" />
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div
      className="ui-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <i style={{ width: `${percent}%` }} />
    </div>
  )
}

/* ── Alert ────────────────────────────────────────────────────────────── */
export function Alert({
  tone = 'info',
  title,
  children,
  role,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  role?: 'alert' | 'status'
}) {
  return (
    <div className={`ui-alert tone-${tone}`} role={role}>
      {title ? <strong>{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  )
}

/* ── Field ────────────────────────────────────────────────────────────── */
export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <label className="ui-field" htmlFor={htmlFor}>
      <span className="ui-field-label">{label}</span>
      {children}
      {hint ? <span className="ui-field-hint">{hint}</span> : null}
    </label>
  )
}

/* ── Setup item (onboarding satırı) ───────────────────────────────────── */
export function SetupItem({
  done,
  optional = false,
  active = false,
  title,
  description,
  meta,
  onClick,
}: {
  done: boolean
  optional?: boolean
  active?: boolean
  title: string
  description: string
  meta?: ReactNode
  onClick?: () => void
}) {
  const body = (
    <>
      <span className={done ? 'ui-setup-check is-done' : 'ui-setup-check'} aria-hidden="true">
        {done ? <Check size={13} strokeWidth={3} /> : null}
      </span>
      <span className="ui-setup-text">
        <b>{title}</b>
        <small>{description}</small>
      </span>
      {meta ? <span className="ui-setup-meta">{meta}</span> : null}
      {onClick ? <ChevronRight className="ui-setup-arrow" size={16} aria-hidden="true" /> : null}
    </>
  )
  const className = ['ui-setup-item', active ? 'is-active' : '', optional ? 'is-optional' : '', done ? 'is-done' : '']
    .filter(Boolean)
    .join(' ')
  return onClick ? (
    <button type="button" className={className} onClick={onClick} aria-current={active ? 'true' : undefined}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

/* ── Empty state + CargoFlow illüstrasyonları ─────────────────────────── */
export type IllustrationKind = 'orders' | 'package' | 'connection' | 'label' | 'error' | 'search' | 'done' | 'lock'

export function Illustration({ kind }: { kind: IllustrationKind }) {
  // Süs niteliğindedir; anlam başlık/metinde taşınır.
  return (
    <svg className={`ui-illustration ui-illustration-${kind}`} viewBox="0 0 120 88" aria-hidden="true">
      <rect x="16" y="14" width="88" height="60" rx="12" className="ui-ill-plate" />
      {kind === 'orders' ? (
        <>
          <rect x="30" y="26" width="60" height="10" rx="5" className="ui-ill-line" />
          <rect x="30" y="41" width="48" height="10" rx="5" className="ui-ill-line is-soft" />
          <rect x="30" y="56" width="36" height="10" rx="5" className="ui-ill-line is-faint" />
          <circle cx="92" cy="61" r="9" className="ui-ill-accent" />
        </>
      ) : null}
      {kind === 'package' ? (
        <>
          <path d="M60 24 L84 36 L60 48 L36 36 Z" className="ui-ill-line" />
          <path d="M36 36 L60 48 L60 70 L36 58 Z" className="ui-ill-line is-soft" />
          <path d="M84 36 L60 48 L60 70 L84 58 Z" className="ui-ill-line is-faint" />
          <path d="M48 30 L72 42" className="ui-ill-stroke" />
        </>
      ) : null}
      {kind === 'connection' ? (
        <>
          <circle cx="38" cy="44" r="10" className="ui-ill-line" />
          <circle cx="82" cy="44" r="10" className="ui-ill-line is-soft" />
          <path d="M48 44 H72" className="ui-ill-stroke is-dashed" />
          <circle cx="60" cy="44" r="4" className="ui-ill-accent" />
        </>
      ) : null}
      {kind === 'label' ? (
        <>
          <rect x="38" y="22" width="44" height="44" rx="4" className="ui-ill-paper" />
          {[44, 47, 51, 53, 57, 60, 64, 66, 70, 74].map((x) => (
            <rect key={x} x={x} y="32" width={x % 3 === 0 ? 2 : 1.4} height="14" className="ui-ill-ink" />
          ))}
          <rect x="44" y="52" width="24" height="3" rx="1.5" className="ui-ill-ink" />
          <rect x="44" y="58" width="16" height="3" rx="1.5" className="ui-ill-ink is-soft" />
        </>
      ) : null}
      {kind === 'error' ? (
        <>
          <circle cx="60" cy="44" r="16" className="ui-ill-danger" />
          <path d="M60 35 V46 M60 51 V53" className="ui-ill-on-danger" />
        </>
      ) : null}
      {kind === 'search' ? (
        <>
          <circle cx="55" cy="40" r="12" className="ui-ill-stroke is-thick" />
          <path d="M64 49 L74 59" className="ui-ill-stroke is-thick" />
        </>
      ) : null}
      {kind === 'done' ? (
        <>
          <circle cx="60" cy="44" r="16" className="ui-ill-success" />
          <path d="M52 44 L58 50 L69 38" className="ui-ill-on-success" />
        </>
      ) : null}
      {kind === 'lock' ? (
        <>
          <rect x="47" y="40" width="26" height="20" rx="4" className="ui-ill-line" />
          <path d="M52 40 V34 a8 8 0 0 1 16 0 V40" className="ui-ill-stroke is-thick" />
        </>
      ) : null}
    </svg>
  )
}

export function EmptyState({
  kind = 'orders',
  title,
  body,
  action,
  compact = false,
}: {
  kind?: IllustrationKind
  title: string
  body?: ReactNode
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={compact ? 'ui-empty is-compact' : 'ui-empty'}>
      <Illustration kind={kind} />
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  )
}
