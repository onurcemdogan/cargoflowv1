import type { HTMLAttributes, ReactNode } from 'react'
import { ShoppingBag, Store, Truck } from 'lucide-react'

/** Presentation only: provider modules own credentials, requests and capability decisions. */
export function IntegrationConnectionCard({
  provider,
  title,
  kind,
  description,
  badges,
  children,
  testId,
}: {
  provider: string
  title: string
  kind: 'marketplace' | 'commerce' | 'carrier'
  description: ReactNode
  badges?: ReactNode
  children: ReactNode
  testId?: string
}) {
  const Icon =
    kind === 'carrier' ? Truck : kind === 'commerce' ? Store : ShoppingBag
  return (
    <section
      className="ui-card integration-connection"
      aria-labelledby={`${provider}-title`}
      data-provider-management={provider}
      data-testid={testId}
      tabIndex={-1}
    >
      <header className="integration-connection-header">
        <span
          className={`integration-provider-icon ${kind === 'carrier' ? 'carrier' : 'marketplace'}`}
          aria-hidden="true"
        >
          <Icon size={22} />
        </span>
        <div className="integration-connection-heading">
          <span className="integration-card-kicker">
            {kind === 'carrier'
              ? 'Kargo firması'
              : kind === 'commerce'
                ? 'E-ticaret sitesi'
                : 'Pazaryeri'}
          </span>
          <h2 id={`${provider}-title`}>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="integration-connection-badges">{badges}</div>
      </header>
      {children}
    </section>
  )
}

export function IntegrationAccountCard({
  title,
  facts = [],
  state,
  actions,
  children,
  ...attributes
}: HTMLAttributes<HTMLLIElement> & {
  title: string
  facts?: Array<[string, ReactNode]>
  state?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <li {...attributes} className="integration-connection-account">
      <div className="integration-account-heading">
        <h3>{title}</h3>
        {state}
      </div>
      {facts.length ? (
        <dl className="integration-account-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
      {actions ? (
        <div className="integration-connection-actions">{actions}</div>
      ) : null}
    </li>
  )
}

export function IntegrationFormSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="integration-connection-form">
      <header>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="integration-connection-fields">{children}</div>
    </section>
  )
}

export function IntegrationFormActions({ children }: { children: ReactNode }) {
  return (
    <div className="integration-connection-actions integration-form-actions">
      {children}
    </div>
  )
}

export function IntegrationLoading({
  children = 'Yükleniyor…',
}: {
  children?: ReactNode
}) {
  return (
    <div className="integration-connection-loading" role="status">
      <span>{children}</span>
      <div className="ui-skeleton-list" aria-hidden="true">
        <i />
        <i />
      </div>
    </div>
  )
}
