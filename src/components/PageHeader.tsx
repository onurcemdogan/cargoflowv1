import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description: string
  actions?: ReactNode
  /**
   * Ürün turu hedef kimliği (`data-tour`). Açık, kararlı bir ÜRÜN
   * SÖZLEŞMESİDİR; tur metin/sınıf sırasıyla hedef ARAMAZ.
   */
  tourId?: string
}

export function PageHeader({ title, description, actions, tourId }: PageHeaderProps) {
  return (
    <header className="page-header" data-tour={tourId}>
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}
