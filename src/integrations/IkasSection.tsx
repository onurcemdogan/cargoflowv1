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
import { Alert, Badge, Field } from '../ui/primitives'
import {
  IntegrationConnectionCard,
  IntegrationAccountCard,
  IntegrationFormSection,
  IntegrationFormActions,
  IntegrationLoading,
} from './IntegrationConnection'
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
    <IntegrationConnectionCard
      provider="ikas"
      title="ikas"
      kind="commerce"
      testId="ikas-section"
      description="ikas bağlantısı iç test aşamasındadır: bağlantı ve sipariş okuma denenebilir, ancak okunan siparişler canlı sipariş, kargo ve etiket akışına aktarılmaz."
      badges={
        <>
          <span
            className="ui-badge tone-warning"
            data-testid="ikas-rollout-badge"
          >
            İÇ TEST
          </span>
          <Badge tone="neutral">Okuma testi</Badge>
        </>
      }
    >
      {loading ? <IntegrationLoading /> : null}
      {loadError ? (
        <Alert tone="danger" role="alert">
          {loadError}
        </Alert>
      ) : null}
      <ul
        className="integration-connection-accounts"
        aria-label="ikas mağazaları"
      >
        {stores.map((store) => (
          <IntegrationAccountCard
            key={store.marketplaceAccountId}
            data-ikas-store={store.marketplaceAccountId}
            title={
              store.displayName ?? store.storeName ?? store.providerAccountId
            }
            state={
              <Badge tone="neutral">
                {store.isActive ? 'Bağlı' : 'Bağlı değil'}
              </Badge>
            }
            facts={[
              [
                'Mağaza',
                store.storeName
                  ? `${store.storeName}.myikas.com`
                  : 'Mağaza adı yok',
              ],
              [
                'Client ID',
                store.clientIdMasked
                  ? `Client ID: ${store.clientIdMasked}`
                  : 'Client ID yok',
              ],
              [
                'Client Secret',
                store.hasClientSecret
                  ? 'Client Secret kayıtlı'
                  : 'Client Secret yok',
              ],
            ]}
            actions={
              <>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={busyAccount !== null || !store.isActive}
                  onClick={() => void readTest(store.marketplaceAccountId)}
                >
                  {busyAccount === store.marketplaceAccountId
                    ? 'Okunuyor…'
                    : 'Sipariş Okumasını Test Et'}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  onClick={() => void disconnect(store.marketplaceAccountId)}
                >
                  Bağlantıyı Kaldır
                </button>
              </>
            }
          >
            {readResults[store.marketplaceAccountId] ? (
              <Alert
                tone={
                  readResults[store.marketplaceAccountId].ok ? 'info' : 'danger'
                }
                role={
                  readResults[store.marketplaceAccountId].ok
                    ? 'status'
                    : 'alert'
                }
              >
                {readResults[store.marketplaceAccountId].message}
              </Alert>
            ) : null}
          </IntegrationAccountCard>
        ))}
      </ul>
      {!loading && stores.length === 0 && !loadError ? (
        <p className="integration-connection-empty">Bağlı ikas mağazası yok.</p>
      ) : null}
      <IntegrationFormSection
        title="Yeni mağaza bağla"
        description="Client Secret saklanır ve geri gösterilmez. Okuma testi canlı sipariş akışını açmaz."
      >
        <Field label="ikas mağaza adı" htmlFor="ikas-store-name">
          <input
            id="ikas-store-name"
            type="text"
            value={storeName}
            placeholder="magazam"
            autoComplete="off"
            onChange={(event) => setStoreName(event.target.value)}
          />
        </Field>
        <Field label="Client ID" htmlFor="ikas-client-id">
          <input
            id="ikas-client-id"
            type="text"
            value={clientId}
            autoComplete="off"
            onChange={(event) => setClientId(event.target.value)}
          />
        </Field>
        <Field label="Client Secret" htmlFor="ikas-client-secret">
          <input
            id="ikas-client-secret"
            type="password"
            value={clientSecret}
            autoComplete="new-password"
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </Field>
      </IntegrationFormSection>
      <IntegrationFormActions>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={formState === 'testing'}
          onClick={() => void connect()}
        >
          Bağlantıyı Test Et ve Bağla
        </button>
      </IntegrationFormActions>
      {formState === 'testing' ? (
        <Alert tone="info" role="status">
          Test ediliyor…
        </Alert>
      ) : null}
      {formState === 'saved' && formMessage ? (
        <Alert tone="info" role="status">
          {formMessage}
        </Alert>
      ) : null}
      {formState === 'error' && formMessage ? (
        <Alert tone="danger" role="alert">
          {formMessage}
        </Alert>
      ) : null}
    </IntegrationConnectionCard>
  )
}
