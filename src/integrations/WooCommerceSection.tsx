// WOOCOMMERCE MAĞAZALARI — BAĞLANTI SİHİRBAZI (İÇ TEST).
//
// ═══ ÖNERİLEN YOL: RESMÎ YETKİLENDİRME ═══════════════════════════════════
//
// Mağaza adresi → bağlan → WooCommerce onay ekranı (yetkilendirme) → mağaza
// anahtarları sunucuya gönderir (geri çağrı) → izin kontrolü → örnek okuma
// doğrulaması → sağlık. Kullanıcı anahtar kopyalamaz; CargoFlow yalnız
// OKUMA izni ister.
//
// ═══ GELİŞMİŞ: ELLE ANAHTAR ══════════════════════════════════════════════
//
// Yalnız yedek yoldur (ör. HTTPS uygulama adresi olmayan ortam). Aynı
// doğrulama uygulanır: başarısız bağlantı listeye GİRMEZ.
//
// ═══ ÇOK MAĞAZA / SIR GERİ GÖSTERİLMEZ ═══════════════════════════════════
//
// Her mağaza bağımsızdır. `consumer_secret` ve webhook secret kaydedildikten
// sonra HİÇBİR ZAMAN okunmaz; yalnız VARLIĞI bildirilir.
import { Alert, Badge, Field } from '../ui/primitives'
import {
  IntegrationConnectionCard,
  type IntegrationDisclosureProps,
  IntegrationAccountCard,
  IntegrationFormSection,
  IntegrationFormActions,
  IntegrationLoading,
} from './IntegrationConnection'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'
import { formatDisplayDate } from '../utils/formatters'
import { clearWooAuthReturn, readWooAuthReturn, redirectToStore } from './wooAuthReturn'

export const WOO_STORES_ENDPOINT = '/api/integrations/woocommerce/stores'
export const WOO_DISCONNECT_ENDPOINT =
  '/api/integrations/woocommerce/stores/disconnect'
export const WOO_AUTHORIZATIONS_ENDPOINT = '/api/integrations/woocommerce/authorizations'

export interface WooStoreRow {
  marketplaceAccountId: string
  providerAccountId: string
  displayName: string | null
  isActive: boolean
  storeUrl: string | null
  consumerKeyMasked: string | null
  hasConsumerSecret: boolean
  hasWebhookSecret: boolean
  verificationStatus?: string
  lastVerifiedAt?: string | null
}

type FormState = 'idle' | 'testing' | 'saved' | 'error'

const STEPS = [
  { key: 'store', label: 'Mağaza adresi' },
  { key: 'authorization', label: 'Yetkilendirme' },
  { key: 'callback', label: 'Anahtar teslimi' },
  { key: 'permission', label: 'İzin kontrolü' },
  { key: 'verification', label: 'Okuma doğrulaması' },
  { key: 'health', label: 'Bağlantı sağlığı' },
] as const
type StepKey = (typeof STEPS)[number]['key']

interface WizardState {
  /** Şu an üzerinde durulan adım. */
  step: StepKey
  status: 'active' | 'failed' | 'done'
  message: string | null
}

interface CompleteBody {
  ok?: boolean
  outcome?: string
  step?: StepKey
  message?: string
}

const POLL_ATTEMPTS = 5
const POLL_DELAY_MS = 1500

function stepState(index: number, wizard: WizardState): 'done' | 'current' | 'failed' | 'todo' {
  const current = STEPS.findIndex((step) => step.key === wizard.step)
  if (wizard.status === 'done') return 'done'
  if (index < current) return 'done'
  if (index === current) return wizard.status === 'failed' ? 'failed' : 'current'
  return 'todo'
}

function verificationLabel(store: WooStoreRow): string {
  if (!store.isActive) return 'Bağlı değil'
  if (store.verificationStatus === 'verified') {
    return store.lastVerifiedAt ? `Okuma doğrulandı · ${formatDisplayDate(store.lastVerifiedAt)}` : 'Okuma doğrulandı'
  }
  return 'Doğrulanmadı'
}

export function WooCommerceSection(disclosure: IntegrationDisclosureProps = {}) {
  const [authReturnIntent] = useState(() => Boolean(readWooAuthReturn()))
  const [stores, setStores] = useState<WooStoreRow[]>([])
  const [authorizationAvailable, setAuthorizationAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [wizard, setWizard] = useState<WizardState>({ step: 'store', status: 'active', message: null })
  const [wizardBusy, setWizardBusy] = useState(false)
  const [wizardStoreUrl, setWizardStoreUrl] = useState('')
  const [formState, setFormState] = useState<FormState>('idle')
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [storeUrl, setStoreUrl] = useState('')
  const [consumerKey, setConsumerKey] = useState('')
  const [consumerSecret, setConsumerSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const mounted = useRef(true)

  // IO DURUMDAN AYRI: `load` yalnız veri getirir, setState YAPMAZ.
  const load = useCallback(async (): Promise<{ stores: WooStoreRow[]; authorizationAvailable: boolean } | null> => {
    try {
      const response = await authenticatedApiRequest(WOO_STORES_ENDPOINT)
      const body = (await response.json()) as { ok?: boolean; stores?: WooStoreRow[]; authorizationAvailable?: boolean }
      if (!response.ok || !body?.ok) return null
      return {
        stores: Array.isArray(body.stores) ? body.stores : [],
        authorizationAvailable: body.authorizationAvailable === true,
      }
    } catch {
      return null
    }
  }, [])

  const applyLoad = useCallback((result: { stores: WooStoreRow[]; authorizationAvailable: boolean } | null) => {
    if (result === null) {
      setLoadError('WooCommerce mağazaları okunamadı.')
      setStores([])
      return
    }
    setLoadError(null)
    setStores(result.stores)
    setAuthorizationAvailable(result.authorizationAvailable)
  }, [])

  // Mağaza onay ekranından DÖNÜŞ: geri çağrının sonucu sunucudan okunur ve
  // örnek okuma doğrulaması tamamlanır. Geri çağrı dönüşten önce gelir; yine
  // de kısa bir süre beklenir (yarış durumu).
  const completeReturn = useCallback(async () => {
    const pending = readWooAuthReturn()
    if (!pending) return
    clearWooAuthReturn()
    setWizard({ step: 'callback', status: 'active', message: 'Mağazadan onay okunuyor…' })
    setWizardBusy(true)
    try {
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        const response = await authenticatedApiRequest(
          `${WOO_AUTHORIZATIONS_ENDPOINT}/${pending.authorizationId}/complete`,
          { method: 'POST', json: { denied: pending.denied } },
        )
        const body = (await response.json().catch(() => null)) as CompleteBody | null
        if (!mounted.current) return
        const outcome = body?.outcome ?? 'FAILED'
        if (outcome === 'CONNECTED') {
          setWizard({ step: 'health', status: 'done', message: body?.message ?? 'Mağaza bağlandı.' })
          return
        }
        if (outcome === 'WAITING_FOR_CALLBACK' || outcome === 'VERIFYING') {
          setWizard({ step: body?.step ?? 'callback', status: 'active', message: body?.message ?? null })
          if (attempt < POLL_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS))
            continue
          }
          setWizard({
            step: body?.step ?? 'callback',
            status: 'failed',
            message: 'Mağazadan anahtar teslimi alınamadı. Bağlantıyı yeniden başlatın.',
          })
          return
        }
        setWizard({ step: body?.step ?? 'authorization', status: 'failed', message: body?.message ?? 'Bağlantı tamamlanamadı.' })
        return
      }
    } catch {
      if (mounted.current) setWizard({ step: 'verification', status: 'failed', message: 'Bağlantı tamamlanamadı.' })
    } finally {
      if (mounted.current) {
        setWizardBusy(false)
        applyLoad(await load())
      }
    }
  }, [applyLoad, load])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    async function run() {
      const result = await load()
      if (cancelled) return
      applyLoad(result)
      setLoading(false)
      await completeReturn()
    }
    void run()
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [load, applyLoad, completeReturn])

  async function startAuthorization() {
    if (wizardBusy) return
    setWizardBusy(true)
    setWizard({ step: 'store', status: 'active', message: null })
    try {
      const response = await authenticatedApiRequest(WOO_AUTHORIZATIONS_ENDPOINT, {
        method: 'POST',
        json: { storeUrl: wizardStoreUrl },
      })
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; authorizeUrl?: string; message?: string }
        | null
      const target = String(body?.authorizeUrl ?? '')
      if (!response.ok || !body?.ok || !target.startsWith('https://')) {
        setWizard({ step: 'store', status: 'failed', message: body?.message ?? 'Bağlantı başlatılamadı.' })
        setWizardBusy(false)
        return
      }
      setWizard({ step: 'authorization', status: 'active', message: 'WooCommerce onay ekranına yönlendiriliyorsunuz…' })
      redirectToStore(target)
    } catch {
      setWizard({ step: 'store', status: 'failed', message: 'Bağlantı başlatılamadı.' })
      setWizardBusy(false)
    }
  }

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
      <IntegrationConnectionCard {...disclosure}
        defaultExpanded={authReturnIntent}
        summary={<IntegrationLoading>Mağazalar yükleniyor…</IntegrationLoading>}
        provider="woocommerce"
        title="WooCommerce"
        kind="commerce"
        description="Mağaza yetkilendirmesi ve okuma bağlantısı"
        badges={<Badge tone="warning">İç test</Badge>}
      >
        <IntegrationLoading />
      </IntegrationConnectionCard>
    )
  }
  return (
    <IntegrationConnectionCard {...disclosure}
      summary={<>{loadError ? <Alert tone="danger" role="alert">{loadError}</Alert> : <p>{loading ? 'Mağazalar yükleniyor…' : stores.length ? stores.length + ' mağaza kayıtlı' : 'Bağlı mağaza yok'}</p>}{stores.map((store) => <div key={store.marketplaceAccountId} className="integration-summary-account"><strong>{store.displayName ?? store.providerAccountId}</strong><span>{verificationLabel(store)}</span><small>{store.storeUrl || '—'}</small></div>)}</>}
      defaultExpanded={authReturnIntent}
      provider="woocommerce"
      title="WooCommerce"
      kind="commerce"
      description="Mağazanızı WooCommerce'in kendi onay ekranıyla bağlayın. CargoFlow yalnız okuma izni ister; birden çok mağaza bağlayabilirsiniz."
      badges={
        <>
          <Badge tone="warning">İç test</Badge>
          <Badge tone="neutral">Salt okunur</Badge>
        </>
      }
    >
      {loadError ? (
        <Alert tone="danger" role="alert">
          {loadError}
        </Alert>
      ) : null}
      <ul
        className="integration-connection-accounts"
        aria-label="Bağlı WooCommerce mağazaları"
      >
        {stores.map((store) => (
          <IntegrationAccountCard
            key={store.marketplaceAccountId}
            title={store.displayName ?? store.providerAccountId}
            state={
              <span
                className={`ui-badge tone-${store.isActive && store.verificationStatus === 'verified' ? 'success' : 'neutral'}`}
                data-verification={store.verificationStatus ?? 'unverified'}
              >
                {verificationLabel(store)}
              </span>
            }
            facts={[
              ['Mağaza adresi', store.storeUrl ?? store.providerAccountId],
              [
                'Consumer Key',
                store.consumerKeyMasked
                  ? `Anahtar: ${store.consumerKeyMasked}`
                  : 'Anahtar yok',
              ],
              [
                'Consumer Secret',
                store.hasConsumerSecret ? 'Sır kayıtlı' : 'Sır yok',
              ],
              [
                'Webhook',
                store.hasWebhookSecret
                  ? 'Webhook sırrı kayıtlı'
                  : 'Webhook sırrı yok',
              ],
            ]}
            actions={
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => void disconnect(store.marketplaceAccountId)}
              >
                Bağlantıyı Kaldır
              </button>
            }
          />
        ))}
      </ul>
      {stores.length === 0 && !loadError ? (
        <p className="integration-connection-empty">Bağlı mağaza yok.</p>
      ) : null}
      <ol className="woo-steps" aria-label="Bağlantı adımları">
        {STEPS.map((step, index) => {
          const state = stepState(index, wizard)
          return (
            <li
              key={step.key}
              className={`is-${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span aria-hidden="true">{index + 1}</span>
              {step.label}
            </li>
          )
        })}
      </ol>
      {wizard.message ? (
        <Alert
          tone={wizard.status === 'failed' ? 'danger' : 'info'}
          role={wizard.status === 'failed' ? 'alert' : 'status'}
        >
          {wizard.message}
        </Alert>
      ) : null}
      {authorizationAvailable ? (
        <>
          <IntegrationFormSection
            title="WooCommerce ile yetkilendir"
            description="Önerilen bağlantı: mağaza adresini girin, mağazanızın onay ekranında okuma erişimi verin."
          >
            <Field label="Mağaza adresi" htmlFor="woo-wizard-store-url">
              <input
                id="woo-wizard-store-url"
                type="url"
                value={wizardStoreUrl}
                placeholder="https://magaza.example.com"
                onChange={(event) => setWizardStoreUrl(event.target.value)}
              />
            </Field>
          </IntegrationFormSection>
          <IntegrationFormActions>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={wizardBusy || wizardStoreUrl.trim() === ''}
              onClick={() => void startAuthorization()}
            >
              Mağazaya bağlan
            </button>
          </IntegrationFormActions>
        </>
      ) : (
        <p className="integration-connection-note">
          Otomatik bağlantı bu ortamda kapalı (HTTPS uygulama adresi gerekli).
          Gelişmiş bölümden REST anahtarıyla bağlanabilirsiniz.
        </p>
      )}
      <details className="integration-connection-advanced">
        <summary>Gelişmiş: REST anahtarıyla bağlan</summary>
        <IntegrationFormSection
          title="REST anahtarı"
          description="Yedek bağlantı yöntemi. Bağlantı doğrulanmadan mağaza eklenmez; kayıtlı sırlar geri gösterilmez."
        >
          <Field label="Mağaza Adresi" htmlFor="woo-store-url">
            <input
              id="woo-store-url"
              type="url"
              value={storeUrl}
              placeholder="https://magaza.example.com"
              onChange={(event) => setStoreUrl(event.target.value)}
            />
          </Field>
          <Field label="Consumer Key" htmlFor="woo-consumer-key">
            <input
              id="woo-consumer-key"
              type="text"
              value={consumerKey}
              onChange={(event) => setConsumerKey(event.target.value)}
            />
          </Field>
          <Field label="Consumer Secret" htmlFor="woo-consumer-secret">
            <input
              id="woo-consumer-secret"
              type="password"
              autoComplete="off"
              value={consumerSecret}
              onChange={(event) => setConsumerSecret(event.target.value)}
            />
          </Field>
          <Field
            label="Webhook Secret (opsiyonel)"
            htmlFor="woo-webhook-secret"
          >
            <input
              id="woo-webhook-secret"
              type="password"
              autoComplete="off"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
            />
          </Field>
        </IntegrationFormSection>
        <IntegrationFormActions>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={formState === 'testing'}
            onClick={() => void testAndSave()}
          >
            Bağlantıyı Test Et ve Kaydet
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
      </details>
    </IntegrationConnectionCard>
  )
}
