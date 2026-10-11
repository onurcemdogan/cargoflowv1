// WOOCOMMERCE MAĞAZALARI — GERÇEK ÜRÜN YÜZEYİ.
//
// ═══ ÇOK MAĞAZA ══════════════════════════════════════════════════════════
//
// Bir organizasyon AYNI ANDA birden çok Woo mağazası bağlar. Her mağaza
// BAĞIMSIZ render edilir; birini kaldırmak diğerlerini ETKİLEMEZ.
//
// ═══ SIR GERİ GÖSTERİLMEZ ════════════════════════════════════════════════
//
// `consumer_secret` ve webhook secret kaydedildikten sonra HİÇBİR ZAMAN
// okunmaz. Mevcut değer yalnız "kayıtlı" rozetiyle bildirilir; alanlar boş
// kalır ve boş bırakılırsa mevcut değer KORUNUR.
import { useCallback, useEffect, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'

export const WOO_STORES_ENDPOINT = '/api/integrations/woocommerce/stores'
export const WOO_DISCONNECT_ENDPOINT =
  '/api/integrations/woocommerce/stores/disconnect'

export interface WooStoreRow {
  marketplaceAccountId: string
  providerAccountId: string
  displayName: string | null
  isActive: boolean
  storeUrl: string | null
  consumerKeyMasked: string | null
  hasConsumerSecret: boolean
  hasWebhookSecret: boolean
}

type FormState = 'idle' | 'testing' | 'saved' | 'error'

export function WooCommerceSection() {
  const [stores, setStores] = useState<WooStoreRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formState, setFormState] = useState<FormState>('idle')
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [storeUrl, setStoreUrl] = useState('')
  const [consumerKey, setConsumerKey] = useState('')
  const [consumerSecret, setConsumerSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')

  // IO DURUMDAN AYRI: `load` yalnız veri getirir, setState YAPMAZ.
  const load = useCallback(async (): Promise<WooStoreRow[] | null> => {
    try {
      const response = await authenticatedApiRequest(WOO_STORES_ENDPOINT)
      const body = (await response.json()) as { ok?: boolean; stores?: WooStoreRow[] }
      if (!response.ok || !body?.ok) return null
      return Array.isArray(body.stores) ? body.stores : []
    } catch {
      return null
    }
  }, [])

  const applyLoad = useCallback((rows: WooStoreRow[] | null) => {
    if (rows === null) {
      setLoadError('WooCommerce mağazaları okunamadı.')
      setStores([])
      return
    }
    setLoadError(null)
    setStores(rows)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      const rows = await load()
      if (cancelled) return
      applyLoad(rows)
      setLoading(false)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [load, applyLoad])

  async function testAndSave() {
    setFormState('testing')
    setFormMessage(null)
    try {
      const response = await authenticatedApiRequest(WOO_STORES_ENDPOINT, {
        method: 'POST',
        json: { storeUrl, consumerKey, consumerSecret, webhookSecret },
      })
      const body = (await response.json()) as { ok?: boolean; message?: string }
      if (!response.ok || !body?.ok) {
        // İYİMSER YAZMA YOK: başarısız bağlantı mağaza listesine GİRMEZ.
        setFormState('error')
        setFormMessage(body?.message ?? 'Bağlantı kurulamadı.')
        return
      }
      setFormState('saved')
      setFormMessage('Bağlantı doğrulandı ve kaydedildi.')
      // SIR EKRANDA BIRAKILMAZ.
      setConsumerSecret('')
      setWebhookSecret('')
      applyLoad(await load())
    } catch {
      setFormState('error')
      setFormMessage('Bağlantı kurulamadı.')
    }
  }

  async function disconnect(marketplaceAccountId: string) {
    try {
      const response = await authenticatedApiRequest(WOO_DISCONNECT_ENDPOINT, {
        method: 'POST',
        json: { marketplaceAccountId },
      })
      const body = (await response.json()) as { ok?: boolean }
      if (!response.ok || !body?.ok) return
      applyLoad(await load())
    } catch {
      // Sessiz başarı YOK: liste yeniden okunmaz, durum değişmez.
    }
  }

  if (loading) {
    return (
      <section aria-labelledby="woocommerce-title">
        <h3 id="woocommerce-title">WooCommerce</h3>
        <p role="status">Yükleniyor…</p>
      </section>
    )
  }

  return (
    <section aria-labelledby="woocommerce-title">
      <h3 id="woocommerce-title">WooCommerce</h3>
      <p>
        Birden çok WooCommerce mağazası bağlayabilirsiniz. Her mağaza bağımsızdır.
      </p>

      {loadError ? <p role="alert">{loadError}</p> : null}

      <ul>
        {stores.map((store) => (
          <li key={store.marketplaceAccountId}>
            <span>{store.displayName ?? store.providerAccountId}</span>
            <span>{store.storeUrl ?? store.providerAccountId}</span>
            <span>
              {store.consumerKeyMasked
                ? `Anahtar: ${store.consumerKeyMasked}`
                : 'Anahtar yok'}
            </span>
            {/* SIR DEĞERİ DEĞİL, YALNIZ VARLIĞI. */}
            <span>{store.hasConsumerSecret ? 'Sır kayıtlı' : 'Sır yok'}</span>
            <span>
              {store.hasWebhookSecret ? 'Webhook sırrı kayıtlı' : 'Webhook sırrı yok'}
            </span>
            <span>{store.isActive ? 'Bağlı' : 'Bağlı değil'}</span>
            <button
              type="button"
              onClick={() => void disconnect(store.marketplaceAccountId)}
            >
              Bağlantıyı Kaldır
            </button>
          </li>
        ))}
      </ul>

      {stores.length === 0 && !loadError ? <p>Bağlı mağaza yok.</p> : null}

      <div>
        <label htmlFor="woo-store-url">Mağaza Adresi</label>
        <input
          id="woo-store-url"
          type="url"
          value={storeUrl}
          placeholder="https://magaza.example.com"
          onChange={(event) => setStoreUrl(event.target.value)}
        />

        <label htmlFor="woo-consumer-key">Consumer Key</label>
        <input
          id="woo-consumer-key"
          type="text"
          value={consumerKey}
          onChange={(event) => setConsumerKey(event.target.value)}
        />

        <label htmlFor="woo-consumer-secret">Consumer Secret</label>
        <input
          id="woo-consumer-secret"
          type="password"
          value={consumerSecret}
          onChange={(event) => setConsumerSecret(event.target.value)}
        />

        <label htmlFor="woo-webhook-secret">Webhook Secret (opsiyonel)</label>
        <input
          id="woo-webhook-secret"
          type="password"
          value={webhookSecret}
          onChange={(event) => setWebhookSecret(event.target.value)}
        />

        <button
          type="button"
          disabled={formState === 'testing'}
          onClick={() => void testAndSave()}
        >
          Bağlantıyı Test Et ve Kaydet
        </button>

        {formState === 'testing' ? <span role="status">Test ediliyor…</span> : null}
        {formState === 'saved' && formMessage ? (
          <span role="status">{formMessage}</span>
        ) : null}
        {formState === 'error' && formMessage ? (
          <span role="alert">{formMessage}</span>
        ) : null}
      </div>
    </section>
  )
}
