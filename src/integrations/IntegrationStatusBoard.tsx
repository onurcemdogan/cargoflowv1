// ENTEGRASYON DURUM PANOSU — yayın durumuna göre gruplanmış sağlayıcılar.
//
// Yayın durumu ÜRÜN gerçeğidir, bağlantı durumu değildir:
//   • Canlı           → yalnız Trendyol ve Sürat Kargo.
//   • İç test         → WooCommerce, ikas, Aras Kargo (yalnız iç test hesapları).
//   • Geliştiriliyor  → Hepsiburada, n11, Ticimax (bağlantı açılmaz).
// Canlı sağlayıcılarda bağlantı rozeti yalnız kayıtlı yapılandırmadan türetilir;
// "kayıtlı" bilgisi doğrulandı ANLAMINA GELMEZ. Bu bileşen ağ isteği yapmaz.
//
// Not: kutucuklarda sağlayıcı adı başlık (heading) DEĞİLDİR — ayrıntı
// kartlarındaki başlıklar sayfada tekil kalır.
import { ChevronRight } from 'lucide-react'
import type { Tone } from '../ui/primitives'

export type IntegrationBoardKey = 'trendyol' | 'surat' | 'woocommerce' | 'ikas' | 'aras'

interface BoardItem {
  key: string
  name: string
  kind: string
  description: string
  status: string
  tone: Tone
  openKey?: IntegrationBoardKey
}

interface BoardGroup {
  key: 'live' | 'internal' | 'development'
  title: string
  caption: string
  items: BoardItem[]
}

export function IntegrationStatusBoard({
  trendyolConfigured,
  suratConfigured,
  onOpen,
}: {
  trendyolConfigured: boolean
  suratConfigured: boolean
  onOpen: (key: IntegrationBoardKey) => void
}) {
  const groups: BoardGroup[] = [
    {
      key: 'live',
      title: 'Canlı',
      caption: 'Üretimde kullanılabilir',
      items: [
        {
          key: 'trendyol',
          name: 'Trendyol',
          kind: 'Pazaryeri',
          description: 'Sipariş ve ürün senkronu',
          status: trendyolConfigured ? 'Bilgiler kayıtlı' : 'Kurulum gerekli',
          tone: trendyolConfigured ? 'success' : 'warning',
          openKey: 'trendyol',
        },
        {
          key: 'surat',
          name: 'Sürat Kargo',
          kind: 'Kargo',
          description: 'Gönderi, barkod ve takip',
          status: suratConfigured ? 'Bilgiler kayıtlı' : 'Kurulum gerekli',
          tone: suratConfigured ? 'success' : 'warning',
          openKey: 'surat',
        },
      ],
    },
    {
      key: 'internal',
      title: 'İç test',
      caption: 'Yalnız iç test hesaplarında açık',
      items: [
        {
          key: 'woocommerce',
          name: 'WooCommerce',
          kind: 'E-ticaret sitesi',
          description: 'Mağaza siparişleri',
          status: 'İç test',
          tone: 'info',
          openKey: 'woocommerce',
        },
        {
          key: 'ikas',
          name: 'ikas',
          kind: 'E-ticaret sitesi',
          description: 'Mağaza siparişleri',
          status: 'İç test',
          tone: 'info',
          openKey: 'ikas',
        },
        {
          key: 'aras',
          name: 'Aras Kargo',
          kind: 'Kargo',
          description: 'Test uç noktası; canlı gönderi kapalı',
          status: 'İç test',
          tone: 'info',
          openKey: 'aras',
        },
      ],
    },
    {
      key: 'development',
      title: 'Geliştiriliyor',
      caption: 'Henüz bağlanamaz',
      items: [
        {
          key: 'hepsiburada',
          name: 'Hepsiburada',
          kind: 'Pazaryeri',
          description: 'Geliştirme aşamasında',
          status: 'Geliştiriliyor',
          tone: 'neutral',
        },
        {
          key: 'n11',
          name: 'n11',
          kind: 'Pazaryeri',
          description: 'Geliştirme aşamasında',
          status: 'Geliştiriliyor',
          tone: 'neutral',
        },
        {
          key: 'ticimax',
          name: 'Ticimax',
          kind: 'E-ticaret sitesi',
          description: 'Geliştirme aşamasında',
          status: 'Geliştiriliyor',
          tone: 'neutral',
        },
      ],
    },
  ]

  return (
    <section className="integration-board" aria-label="Entegrasyon durumu">
      {groups.map((group) => (
        <div key={group.key} className={`integration-board-group is-${group.key}`}>
          <div className="integration-board-group-head">
            <span className="integration-board-group-title">{group.title}</span>
            <small>{group.caption}</small>
          </div>
          <ul>
            {group.items.map((item) => {
              const body = (
                <>
                  <span className="integration-board-mark" aria-hidden="true">
                    {item.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="integration-board-copy">
                    <b>{item.name}</b>
                    <small>
                      {item.kind} · {item.description}
                    </small>
                  </span>
                  <span className={`ui-badge tone-${item.tone} has-dot`}>{item.status}</span>
                  {item.openKey ? (
                    <ChevronRight size={16} className="integration-board-chevron" aria-hidden="true" />
                  ) : null}
                </>
              )
              return (
                <li key={item.key}>
                  {item.openKey ? (
                    <button
                      type="button"
                      className="integration-board-item"
                      onClick={() => onOpen(item.openKey as IntegrationBoardKey)}
                    >
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
      ))}
    </section>
  )
}
