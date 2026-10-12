// ARAS KARGO — İÇ TEST taşıyıcı kimlik yüzeyi (UserName/Password; sır geri okunmaz).
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

export function ArasSection() {
  const [stores, setStores] = useState<ArasStoreRow[]>([])
  const [loading, setLoading] = useState(true)
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
      return
    }
    setStores(Array.isArray(body.stores) ? body.stores : [])
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await load()
      if (!cancelled) setLoading(false)
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
      setMessage(body.message ?? 'Kaydedildi (internal_test).')
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
      <section className="integration-section" aria-labelledby="aras-title">
        <h3 id="aras-title">Aras Kargo</h3>
        <p role="status">Aras hesapları yükleniyor…</p>
      </section>
    )
  }

  return (
    <section className="integration-section" aria-labelledby="aras-title">
      <h3 id="aras-title">
        Aras Kargo <span className="ui-badge tone-info">İç test</span>
      </h3>
      <p>
        Bağlantı Aras test servisine yapılır; canlı gönderi ve etiket kapalıdır. Kimlik bilgileri
        doğrulanana kadar Aras ile gönderi oluşturulmaz.
      </p>
      {stores.length > 0 ? (
        <ul aria-label="Aras hesapları">
          {stores.map((s) => (
            <li key={s.marketplaceAccountId}>
              <span>{s.displayName ?? 'Aras Kargo'}</span>
              <span data-verification={s.verificationStatus ?? 'unverified'}>{verificationText(s)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <label htmlFor="aras-display-name">Görünen ad</label>
        <input id="aras-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <label htmlFor="aras-user-name">Kullanıcı adı</label>
        <input id="aras-user-name" value={userName} onChange={(e) => setUserName(e.target.value)} autoComplete="off" />
        <label htmlFor="aras-password">Şifre</label>
        <input
          id="aras-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        <button type="button" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
        {message ? <span role="status">{message}</span> : null}
      </div>
    </section>
  )
}
