// IKAS MAĞAZALARI — İÇ TEST (INTERNAL_TEST) ÜRÜN YÜZEYİ.
//
// ═══ DÜRÜST YAYIN DURUMU ═════════════════════════════════════════════════
//
// ikas `internal_test`tir: bağlantı ve sipariş OKUMA test edilebilir, ama
// okunan siparişler canlı sipariş/kargo/etiket akışına YAZILMAZ. Yüzey bunu
// açıkça söyler.
//
// ═══ SIR GERİ GÖSTERİLMEZ ════════════════════════════════════════════════
//
// Client Secret kaydedildikten sonra HİÇBİR ZAMAN geri okunmaz; yalnız
// "kayıtlı" rozeti gösterilir ve alan boşaltılır.
import { useCallback, useEffect, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'

export const IKAS_STORES_ENDPOINT = '/api/integrations/ikas/stores'
export const IKAS_DISCONNECT_ENDPOINT = '/api/integrations/ikas/stores/disconnect'
export const IKAS_ORDERS_TEST_ENDPOINT = '/api/integrations/ikas/stores/orders-read-test'

export interface IkasStoreRow {
  marketplaceAccountId: string
  providerAccountId: string
  displayName: string | null
  isActive: boolean
  storeName: string | null
  clientIdMasked: string | null
  hasClientSecret: boolean
}

type FormState = 'idle' | 'testing' | 'saved' | 'error'

interface ReadTestResult {
  ok: boolean
  message: string
}

export function IkasSection() {
  const [stores, setStores] = useState<IkasStoreRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formState, setFormState] = useState<FormState>('idle')
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [storeName, setStoreName] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busyAccount, setBusyAccount] = useState<string | null>(null)
  const [readResults, setReadResults] = useState<Record<string, ReadTestResult>>({})

  const load = useCallback(async (): Promise<IkasStoreRow[] | null> => {
    try {
      const response = await authenticatedApiRequest(IKAS_STORES_ENDPOINT)
      const body = (await response.json()) as { ok?: boolean; stores?: IkasStoreRow[] }
      if (!response.ok || !body?.ok) return null
      return Array.isArray(body.stores) ? body.stores : []
    } catch {
      return null
    }
  }, [])

  const applyLoad = useCallback((rows: IkasStoreRow[] | null) => {
    if (rows === null) {
      setLoadError('ikas mağazaları okunamadı.')
      setStores([])
      return
    }
    setLoadError(null)
    setStores(rows)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows = await load()
      if (cancelled) return
      applyLoad(rows)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [load, applyLoad])

  async function connect() {
    if (formState === 'testing') return
    setFormState('testing')
    setFormMessage(null)
    try {
      const response = await authenticatedApiRequest(IKAS_STORES_ENDPOINT, {
        method: 'POST',
        json: { storeName, clientId, clientSecret },
      })
      const body = (await response.json()) as { ok?: boolean; message?: string }
      if (!response.ok || !body?.ok) {
        // İYİMSER YAZMA YOK: başarısız bağlantı listeye GİRMEZ.
        setFormState('error')
        setFormMessage(body?.message ?? 'Bağlantı kurulamadı.')
        return
      }
      setFormState('saved')
      setFormMessage(body.message ?? 'Bağlantı doğrulandı ve kaydedildi.')
      // SIR EKRANDA BIRAKILMAZ.
      setClientSecret('')
      applyLoad(await load())
    } catch {
      setFormState('error')
      setFormMessage('Bağlantı kurulamadı.')
    }
  }

  async function readTest(marketplaceAccountId: string) {
    if (busyAccount) return
    setBusyAccount(marketplaceAccountId)
    try {
      const response = await authenticatedApiRequest(IKAS_ORDERS_TEST_ENDPOINT, {
        method: 'POST',
        json: { marketplaceAccountId },
      })
      const body = (await response.json()) as {
        ok?: boolean
        message?: string
        ordersRead?: number
      }
      setReadResults((current) => ({
        ...current,
        [marketplaceAccountId]: {
          ok: Boolean(response.ok && body?.ok),
          message:
            response.ok && body?.ok
              ? `${body.ordersRead ?? 0} sipariş okundu. ${body.message ?? ''}`.trim()
              : (body?.message ?? 'Sipariş okuma testi tamamlanamadı.'),
        },
      }))
    } catch {
      setReadResults((current) => ({
        ...current,
        [marketplaceAccountId]: { ok: false, message: 'Sipariş okuma testi tamamlanamadı.' },
      }))
    } finally {
      setBusyAccount(null)
    }
  }

  async function disconnect(marketplaceAccountId: string) {
    try {
      const response = await authenticatedApiRequest(IKAS_DISCONNECT_ENDPOINT, {
        method: 'POST',
        json: { marketplaceAccountId },
      })
      const body = (await response.json()) as { ok?: boolean }
      if (!response.ok || !body?.ok) return
      applyLoad(await load())
    } catch {
      // Sessiz başarı YOK: liste değişmez.
    }
  }

  return (
    <section aria-labelledby="ikas-title" data-testid="ikas-section">
      <h3 id="ikas-title">
        ikas <span data-testid="ikas-rollout-badge">İÇ TEST</span>
      </h3>
      <p>
        ikas bağlantısı iç test aşamasındadır: bağlantı ve sipariş okuma denenebilir, ancak
        okunan siparişler canlı sipariş, kargo ve etiket akışına aktarılmaz.
      </p>

      {loading ? <p role="status">Yükleniyor…</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}

      <ul>
        {stores.map((store) => (
          <li key={store.marketplaceAccountId} data-ikas-store={store.marketplaceAccountId}>
            <span>{store.displayName ?? store.storeName ?? store.providerAccountId}</span>
            <span>{store.storeName ? `${store.storeName}.myikas.com` : 'Mağaza adı yok'}</span>
            <span>
              {store.clientIdMasked ? `Client ID: ${store.clientIdMasked}` : 'Client ID yok'}
            </span>
            {/* SIR DEĞERİ DEĞİL, YALNIZ VARLIĞI. */}
            <span>{store.hasClientSecret ? 'Client Secret kayıtlı' : 'Client Secret yok'}</span>
            <span>{store.isActive ? 'Bağlı' : 'Bağlı değil'}</span>
            <button
              type="button"
              disabled={busyAccount !== null || !store.isActive}
              onClick={() => void readTest(store.marketplaceAccountId)}
            >
              {busyAccount === store.marketplaceAccountId
                ? 'Okunuyor…'
                : 'Sipariş Okumasını Test Et'}
            </button>
            <button type="button" onClick={() => void disconnect(store.marketplaceAccountId)}>
              Bağlantıyı Kaldır
            </button>
            {readResults[store.marketplaceAccountId] ? (
              <span role={readResults[store.marketplaceAccountId].ok ? 'status' : 'alert'}>
                {readResults[store.marketplaceAccountId].message}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {!loading && stores.length === 0 && !loadError ? <p>Bağlı ikas mağazası yok.</p> : null}

      <div>
        <label htmlFor="ikas-store-name">ikas mağaza adı</label>
        <input
          id="ikas-store-name"
          type="text"
          value={storeName}
          placeholder="magazam"
          autoComplete="off"
          onChange={(event) => setStoreName(event.target.value)}
        />
        <label htmlFor="ikas-client-id">Client ID</label>
        <input
          id="ikas-client-id"
          type="text"
          value={clientId}
          autoComplete="off"
          onChange={(event) => setClientId(event.target.value)}
        />
        <label htmlFor="ikas-client-secret">Client Secret</label>
        <input
          id="ikas-client-secret"
          type="password"
          value={clientSecret}
          autoComplete="new-password"
          onChange={(event) => setClientSecret(event.target.value)}
        />
        <button type="button" disabled={formState === 'testing'} onClick={() => void connect()}>
          Bağlantıyı Test Et ve Bağla
        </button>
        {formState === 'testing' ? <span role="status">Test ediliyor…</span> : null}
        {formState === 'saved' && formMessage ? <span role="status">{formMessage}</span> : null}
        {formState === 'error' && formMessage ? <span role="alert">{formMessage}</span> : null}
      </div>
    </section>
  )
}
