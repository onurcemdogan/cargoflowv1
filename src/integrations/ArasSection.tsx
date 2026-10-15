// ARAS KARGO — İÇ TEST taşıyıcı kimlik yüzeyi (UserName/Password; sır geri okunmaz).
import { Alert, Badge, Field } from '../ui/primitives'
import {
  IntegrationConnectionCard,
  type IntegrationDisclosureProps,
  IntegrationAccountCard,
  IntegrationFormSection,
  IntegrationFormActions,
  IntegrationLoading,
} from './IntegrationConnection'
import { useCallback, useEffect, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'

export const ARAS_STORES_ENDPOINT = '/api/integrations/aras/stores'
export const ARAS_DISCONNECT_ENDPOINT = '/api/integrations/aras/stores/disconnect'

interface ArasStoreRow {
  marketplaceAccountId: string
  displayName: string | null
  isActive: boolean
  configured?: boolean
  verificationStatus?: string
  lastVerifiedAt?: string | null
}

// Aras kimlik doğrulama yanıtının resmî anlam tablosu yok: kayıtlı hesap
// "doğrulandı" GÖSTERİLMEZ; ön kontrol doğrulanmamış hesapla gönderi açmaz.
function verificationText(store: ArasStoreRow): string {
  if (!store.isActive) return 'Pasif'
  if (store.verificationStatus === 'verified') return 'Doğrulandı'
  return 'Kayıtlı, doğrulanmadı'
}

export function ArasSection(disclosure: IntegrationDisclosureProps = {}) {
  const [stores, setStores] = useState<ArasStoreRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [userName, setUserName] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const response = await authenticatedApiRequest(ARAS_STORES_ENDPOINT)
    const body = (await response.json()) as { ok?: boolean; stores?: ArasStoreRow[] }
    if (!response.ok || !body?.ok) {
      setStores([])
      setLoadError('Aras hesapları yüklenemedi.')
      return
    }
    setLoadError(null)
    setStores(Array.isArray(body.stores) ? body.stores : [])
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await load()
      } catch {
        if (!cancelled) setLoadError('Aras hesapları yüklenemedi.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  async function connect() {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const response = await authenticatedApiRequest(ARAS_STORES_ENDPOINT, {
        method: 'POST',
        json: { userName, password, displayName },
      })
      const body = (await response.json()) as { ok?: boolean; message?: string }
      if (!response.ok || !body?.ok) {
        setMessage(body?.message ?? 'Kayıt başarısız.')
        return
      }
      setMessage(body.message ?? 'Kaydedildi. Aras Kargo iç testtedir.')
      setPassword('')
      await load()
    } catch {
      setMessage('Kayıt başarısız.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <IntegrationConnectionCard {...disclosure}
        summary={<IntegrationLoading>Aras hesapları yükleniyor…</IntegrationLoading>}
        provider="aras"
        title="Aras Kargo"
        kind="carrier"
        description="Aras test hesabı yapılandırması"
        badges={<Badge tone="warning">İç test</Badge>}
      >
        <IntegrationLoading>Aras hesapları yükleniyor…</IntegrationLoading>
      </IntegrationConnectionCard>
    )
  }
  return (
    <IntegrationConnectionCard {...disclosure}
      summary={<>{loadError ? <Alert tone="danger" role="alert">{loadError}</Alert> : <p>{stores.length ? stores.length + ' hesap kayıtlı' : 'Bağlı Aras hesabı yok.'}</p>}{stores.map((store) => <div key={store.marketplaceAccountId} className="integration-summary-account"><strong>{store.displayName ?? 'Aras hesabı'}</strong><span>{verificationText(store)}</span></div>)}</>}
      provider="aras"
      title="Aras Kargo"
      kind="carrier"
      description="Bağlantı Aras test servisine yapılır; canlı gönderi ve etiket kapalıdır. Kimlik bilgileri doğrulanana kadar Aras ile gönderi oluşturulmaz."
      badges={
        <>
          <Badge tone="warning">İç test</Badge>
          <Badge tone="neutral">Canlı gönderi kapalı</Badge>
        </>
      }
    >
      <ul
        className="integration-connection-accounts"
        aria-label="Aras hesapları"
      >
        {stores.map((s) => (
          <IntegrationAccountCard
            key={s.marketplaceAccountId}
            title={s.displayName ?? 'Aras Kargo'}
            state={
              <span
                className={`ui-badge tone-${s.isActive && s.verificationStatus === 'verified' ? 'info' : 'neutral'}`}
                data-verification={s.verificationStatus ?? 'unverified'}
              >
                {verificationText(s)}
              </span>
            }
            facts={[
              ['Canlı gönderi / etiket', 'Kullanılamaz — iç test'],
              ...(s.lastVerifiedAt
                ? [['Son doğrulama', s.lastVerifiedAt] as [string, string]]
                : []),
            ]}
          />
        ))}
      </ul>
      {loadError ? <Alert tone="danger" role="alert">{loadError}</Alert> : null}
      {!loadError && stores.length === 0 ? (
        <p className="integration-connection-empty">Bağlı Aras hesabı yok.</p>
      ) : null}
      <IntegrationFormSection
        title="Aras test hesabını kaydet"
        description="Kayıt, hesabın üretimde gönderi oluşturabileceği anlamına gelmez. Kayıtlı şifre geri gösterilmez."
      >
        <Field label="Görünen ad" htmlFor="aras-display-name">
          <input
            id="aras-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label="Kullanıcı adı" htmlFor="aras-user-name">
          <input
            id="aras-user-name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Şifre" htmlFor="aras-password">
          <input
            id="aras-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
      </IntegrationFormSection>
      <IntegrationFormActions>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={busy}
          onClick={() => void connect()}
        >
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </IntegrationFormActions>
      {message ? (
        <Alert tone="info" role="status">
          {message}
        </Alert>
      ) : null}
    </IntegrationConnectionCard>
  )
}
