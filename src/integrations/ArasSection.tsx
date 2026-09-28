// ARAS KARGO — İÇ TEST taşıyıcı kimlik yüzeyi (UserName/Password; sır geri okunmaz).
import { useCallback, useEffect, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'

export const ARAS_STORES_ENDPOINT = '/api/integrations/aras/stores'
export const ARAS_DISCONNECT_ENDPOINT = '/api/integrations/aras/stores/disconnect'

interface ArasStoreRow {
  marketplaceAccountId: string
  displayName: string | null
  isActive: boolean
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

  if (loading) return <p className="text-sm text-muted">Aras hesapları yükleniyor…</p>

  return (
    <section className="rounded-lg border p-4 space-y-3">
      <p className="text-sm font-medium">Aras Kargo — INTERNAL TEST</p>
      <p className="text-xs text-muted">
        Test uç noktası yalnızca yapılandırma içindir; canlı gönderi/etiket yan etkisi yoktur.
      </p>
      <label className="block text-sm">
        Görünen ad
        <input className="mt-1 w-full border rounded px-2 py-1" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="block text-sm">
        UserName
        <input className="mt-1 w-full border rounded px-2 py-1" value={userName} onChange={(e) => setUserName(e.target.value)} autoComplete="off" />
      </label>
      <label className="block text-sm">
        Password
        <input type="password" className="mt-1 w-full border rounded px-2 py-1" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void connect()}>
        {busy ? 'Kaydediliyor…' : 'Bağla'}
      </button>
      {message ? <p className="text-sm">{message}</p> : null}
      {stores.length > 0 ? (
        <ul className="text-sm space-y-1">
          {stores.map((s) => (
            <li key={s.marketplaceAccountId}>
              {s.displayName ?? s.marketplaceAccountId} — {s.isActive ? 'aktif' : 'pasif'}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
