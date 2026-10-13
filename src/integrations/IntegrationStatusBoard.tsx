// ENTEGRASYON DURUM PANOSU — sunucu kataloğundan beslenir (PHASE2-E).
//
// Üç kavram ayrı tutulur ve birbirine dönüştürülmez:
//   • Grup ("Canlı / İç test / Geliştiriliyor") sunucunun uygulama + yayın
//     aşamasından türettiği `availability` alanıdır. Bileşen bunu YENİDEN
//     hesaplamaz; "Canlı" yalnız sunucu öyle dediğinde görünür.
//   • Rozet yalnız bu çalışma alanındaki bağlantı sağlığıdır.
//   • Yayın aşaması `hidden` olan sağlayıcı listelenmez.
// Uç okunamazsa sabit bir durum UYDURULMAZ; panoda yalnız bilgi notu kalır.
//
// Not: kutucuklarda sağlayıcı adı başlık (heading) DEĞİLDİR — ayrıntı
// kartlarındaki başlıklar sayfada tekil kalır.
import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Tone } from '../ui/primitives'
import { formatDisplayDate } from '../utils/formatters'
import {
  fetchIntegrationStatus,
  type Availability,
  type ConnectionHealthState,
  type IntegrationStatusEntry,
  type ProviderKind,
} from '../services/integrationStatusClient'

export type IntegrationBoardKey = 'trendyol' | 'surat' | 'woocommerce' | 'ikas' | 'aras' | 'hepsiburada' | 'n11'

const OPENABLE: ReadonlySet<string> = new Set<IntegrationBoardKey>(['trendyol', 'surat', 'woocommerce', 'ikas', 'aras', 'hepsiburada', 'n11'])

const GROUPS: ReadonlyArray<{ key: Exclude<Availability, 'hidden'>; className: string; title: string; caption: string }> = [
  { key: 'live', className: 'is-live', title: 'Canlı', caption: 'Üretimde kullanılabilir' },
  { key: 'internal_test', className: 'is-internal', title: 'İç test', caption: 'Yalnız iç test hesaplarında açık' },
  { key: 'in_development', className: 'is-development', title: 'Geliştiriliyor', caption: 'Henüz bağlanamaz' },
]

const KIND_LABEL: Record<ProviderKind, string> = {
  marketplace: 'Pazaryeri',
  commerce_platform: 'E-ticaret sitesi',
  shipping: 'Kargo',
}

/** Bağlantı sağlığı — sade Türkçe. "Kayıtlı" ASLA "doğrulandı" demek değildir. */
const HEALTH_PRESENTATION: Record<ConnectionHealthState, { label: string; tone: Tone }> = {
  not_configured: { label: 'Kurulum gerekli', tone: 'warning' },
  configured: { label: 'Kayıtlı, doğrulanmadı', tone: 'warning' },
  verified: { label: 'Bağlantı doğrulandı', tone: 'success' },
  auth_error: { label: 'Giriş bilgileri reddedildi', tone: 'danger' },
  permission_error: { label: 'Yetki eksik', tone: 'danger' },
  provider_unavailable: { label: 'Servis yanıt vermiyor', tone: 'warning' },
  rate_limited: { label: 'İstek sınırına takıldı', tone: 'warning' },
  disabled: { label: 'Devre dışı', tone: 'neutral' },
  not_available: { label: 'Bağlantı açılmaz', tone: 'neutral' },
}

function detailOf(entry: IntegrationStatusEntry): string {
  const kind = KIND_LABEL[entry.kind] ?? entry.kind
  if (entry.availability === 'in_development') return `${kind} · Geliştirme aşamasında`
  if (entry.health.lastSuccessfulSyncAt) return `${kind} · Son senkron ${formatDisplayDate(entry.health.lastSuccessfulSyncAt)}`
  if (entry.health.lastVerifiedAt) return `${kind} · Son doğrulama ${formatDisplayDate(entry.health.lastVerifiedAt)}`
  return kind
}

export function IntegrationStatusBoard({
  onOpen,
  refreshKey,
  load = fetchIntegrationStatus,
}: {
  onOpen: (key: IntegrationBoardKey) => void
  /** Değiştiğinde durum yeniden okunur (ör. kayıt / bağlantı testi sonrası). */
  refreshKey?: string
  load?: () => Promise<IntegrationStatusEntry[]>
}) {
  const [entries, setEntries] = useState<IntegrationStatusEntry[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    load()
      .then((providers) => {
        if (cancelled) return
        setEntries(providers)
        setUnavailable(false)
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true)
      })
    return () => {
      cancelled = true
    }
  }, [load, refreshKey])

  if (unavailable && !entries) {
    return (
      <section className="integration-board is-unavailable" aria-label="Entegrasyon durumu">
        <p className="integration-board-note" role="status">
          Bağlantı durumu şu an okunamıyor. Bağlantıları aşağıdan yönetebilirsiniz.
        </p>
      </section>
    )
  }
  if (!entries) {
    return <section className="integration-board is-loading" aria-label="Entegrasyon durumu" aria-busy="true" />
  }

  return (
    <section className="integration-board" aria-label="Entegrasyon durumu">
      {GROUPS.map((group) => {
        const items = entries.filter((entry) => entry.availability === group.key)
        if (items.length === 0) return null
        return (
          <div key={group.key} className={`integration-board-group ${group.className}`}>
            <div className="integration-board-group-head">
              <span className="integration-board-group-title">{group.title}</span>
              <small>{group.caption}</small>
            </div>
            <ul>
              {items.map((entry) => {
                const health = HEALTH_PRESENTATION[entry.health.state] ?? HEALTH_PRESENTATION.not_available
                const openKey = entry.availability !== 'in_development' && OPENABLE.has(entry.providerKey)
                  ? (entry.providerKey as IntegrationBoardKey)
                  : null
                const body = (
                  <>
                    <span className="integration-board-mark" aria-hidden="true">
                      {entry.displayName.charAt(0).toUpperCase()}
                    </span>
                    <span className="integration-board-copy">
                      <b>{entry.displayName}</b>
                      <small>{detailOf(entry)}</small>
                    </span>
                    <span
                      className={`ui-badge tone-${health.tone} has-dot`}
                      data-health={entry.health.state}
                    >
                      {health.label}
                    </span>
                    {openKey ? <ChevronRight size={16} className="integration-board-chevron" aria-hidden="true" /> : null}
                  </>
                )
                return (
                  <li key={entry.providerKey} data-provider={entry.providerKey}>
                    {openKey ? (
                      <button type="button" className="integration-board-item" onClick={() => onOpen(openKey)}>
                        {body}
                      </button>
                    ) : (
                      <div className="integration-board-item is-disabled" aria-disabled="true">
                        {body}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
