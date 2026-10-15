// N11 HESAPLARI — İÇ TEST (INTERNAL_TEST), YALNIZ OKUMA.
//
// ═══ DÜRÜST YAYIN DURUMU ═════════════════════════════════════════════════
//
// Güvenli GET yalnız bu hesabın kimliğini doğrular ve kanonik sipariş
// okumasını açar. Kargo/etiket ve pazaryeri yazmaları ayrı kapıda kalır.
//
// ═══ YAPILANDIRMA ═══════════════════════════════════════════════════════
//
// Uç nokta ve host resmî olarak kanıtlıdır; kullanıcıdan YALNIZ n11 API
// bilgileri (appKey + appSecret) istenir.
//
// ═══ SIR GERİ GÖSTERİLMEZ ════════════════════════════════════════════════
//
// appSecret ve tam appKey kaydedildikten sonra HİÇBİR ZAMAN geri okunmaz;
// yalnız maskeli appKey sonu ve "şifre kayıtlı" bilgisi gösterilir.
// Düzenlemede alanlar boş bırakılırsa kayıtlı değerler korunur.
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
import { AccountReadStatus } from './AccountReadStatus'

export const N11_ACCOUNTS_ENDPOINT = '/api/integrations/n11/accounts'
export const N11_DISCONNECT_ENDPOINT = '/api/integrations/n11/accounts/disconnect'
export const N11_TEST_ENDPOINT = '/api/integrations/n11/accounts/test'
export const N11_SYNC_ENDPOINT = '/api/integrations/n11/accounts/sync'

export interface N11AccountRow {
  marketplaceAccountId: string
  displayName: string | null
  isActive: boolean
  config: { appKeyMasked: string; hasAppSecret: boolean; sellerId: string | null } | null
  health: { state: string; reasonCode: string | null; lastSuccessfulSyncAt: string | null; lastAttemptAt?: string | null }
  healthLabel?: string
  verificationStatus?: string
  ordersActive?: boolean
}

interface FormFields {
  appKey: string
  appSecret: string
}

const EMPTY_FORM: FormFields = { appKey: '', appSecret: '' }

type FormState = 'idle' | 'saving' | 'saved' | 'error'

interface ActionResult {
  ok: boolean
  message: string
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return '—'
  return new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms))
}

export function N11Section(disclosure: IntegrationDisclosureProps = {}) {
  const [accounts, setAccounts] = useState<N11AccountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormFields>(EMPTY_FORM)
  const [editing, setEditing] = useState<N11AccountRow | null>(null)
  const [formState, setFormState] = useState<FormState>('idle')
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [busyAccount, setBusyAccount] = useState<string | null>(null)
  const [verifyingAccount, setVerifyingAccount] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, ActionResult>>({})

  const load = useCallback(async (): Promise<N11AccountRow[] | null> => {
    try {
      const response = await authenticatedApiRequest(N11_ACCOUNTS_ENDPOINT)
      const body = (await response.json()) as { ok?: boolean; accounts?: N11AccountRow[] }
      if (!response.ok || !body?.ok) return null
      return Array.isArray(body.accounts) ? body.accounts : []
    } catch {
      return null
    }
  }, [])

  const applyLoad = useCallback((rows: N11AccountRow[] | null) => {
    if (rows === null) {
      setLoadError('n11 hesapları okunamadı.')
      setAccounts([])
      return
    }
    setLoadError(null)
    setAccounts(rows)
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

  const update = (field: keyof FormFields) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [field]: event.target.value }))

  function startEdit(account: N11AccountRow) {
    setResults((current) => { const next = { ...current }; delete next[account.marketplaceAccountId]; return next })
    // appKey ve appSecret GERİ DOLDURULMAZ; boş bırakılırsa kayıtlı değer korunur.
    setEditing(account)
    setFormState('idle')
    setFormMessage(null)
    setForm(EMPTY_FORM)
  }

  async function save() {
    if (formState === 'saving' || busyAccount) return
    setFormState('saving')
    setFormMessage(null)
    try {
      const json = editing ? { ...form, marketplaceAccountId: editing.marketplaceAccountId } : form
      const response = await authenticatedApiRequest(N11_ACCOUNTS_ENDPOINT, { method: 'POST', json })
      const body = (await response.json()) as { ok?: boolean; message?: string }
      if (!response.ok || !body?.ok) {
        setFormState('error')
        setFormMessage(body?.message ?? 'n11 API bilgileri kaydedilemedi.')
        return
      }
      setFormState('saved')
      setFormMessage(body.message ?? 'n11 API bilgileri kaydedildi.')
      // SIR EKRANDA BIRAKILMAZ.
      setForm(EMPTY_FORM)
      setEditing(null)
      applyLoad(await load())
    } catch {
      setFormState('error')
      setFormMessage('n11 API bilgileri kaydedilemedi.')
    }
  }

  async function runAction(marketplaceAccountId: string, endpoint: string, summarize: (body: Record<string, unknown>) => string) {
    if (busyAccount) return
    setBusyAccount(marketplaceAccountId)
    setVerifyingAccount(endpoint === N11_TEST_ENDPOINT ? marketplaceAccountId : null)
    try {
      const response = await authenticatedApiRequest(endpoint, { method: 'POST', json: { marketplaceAccountId } })
      const body = (await response.json()) as Record<string, unknown>
      const ok = Boolean(response.ok && body?.ok)
      setResults((current) => ({
        ...current,
        [marketplaceAccountId]: { ok, message: ok ? summarize(body) : String(body?.message ?? 'İşlem tamamlanamadı.') },
      }))
      applyLoad(await load())
    } catch {
      setResults((current) => ({ ...current, [marketplaceAccountId]: { ok: false, message: 'İşlem tamamlanamadı.' } }))
    } finally {
      setBusyAccount(null)
      setVerifyingAccount(null)
    }
  }

  const testAccount = (id: string) =>
    runAction(id, N11_TEST_ENDPOINT, (body) => `Okuma isteği yanıt verdi (${Number(body.recordsRead ?? 0)} kayıt). ${String(body.message ?? '')}`.trim())
  const syncAccount = (id: string) =>
    runAction(id, N11_SYNC_ENDPOINT, (body) => `${Number(body.fetched ?? 0)} kayıt okundu. ${String(body.message ?? '')}`.trim())

  async function disconnect(marketplaceAccountId: string) {
    try {
      const response = await authenticatedApiRequest(N11_DISCONNECT_ENDPOINT, { method: 'POST', json: { marketplaceAccountId } })
      const body = (await response.json()) as { ok?: boolean }
      if (!response.ok || !body?.ok) return
      applyLoad(await load())
    } catch {
      // Sessiz başarı YOK: liste değişmez.
    }
  }

  return (
    <IntegrationConnectionCard {...disclosure}
      summary={<>{loadError ? <Alert tone="danger" role="alert">{loadError}</Alert> : <p>{loading ? 'Hesaplar yükleniyor…' : accounts.length ? accounts.length + ' hesap kayıtlı' : 'Bağlı hesap yok'}</p>}{accounts.map((account) => <div key={account.marketplaceAccountId} className="integration-summary-account"><strong>{account.displayName ?? 'n11 hesabı'}</strong><AccountReadStatus isActive={account.isActive} configured={Boolean(account.config)} verificationStatus={account.verificationStatus} ordersActive={Boolean(account.ordersActive)} verifying={verifyingAccount === account.marketplaceAccountId || (formState === 'saving' && editing?.marketplaceAccountId === account.marketplaceAccountId)} /><small>Son okuma: {formatDateTime(account.health.lastSuccessfulSyncAt)}</small></div>)}<p className="integration-summary-blocker"><code>N11_EPOCH_SEMANTICS_UNVERIFIED · BLOCKED_EXTERNAL</code><span>Tarih doğrulanana kadar senkronizasyon imleci engelli. Etiket ve yazma kapalı.</span></p></>}
      provider="n11"
      title="n11"
      kind="marketplace"
      testId="n11-section"
      description="API bilgilerinizi kaydedin; hesabınız güvenli bir okuma isteğiyle doğrulanır. Doğrulanan hesabın siparişleri sisteme alınabilir."
      badges={
        <>
          <span className="ui-badge tone-info" data-testid="n11-rollout-badge">
            SİPARİŞ OKUMA
          </span>
          <Badge tone="warning">İç test · salt okunur</Badge>
        </>
      }
    >
      <p className="integration-connection-note">
        Pazaryeri yazmaları (sipariş statüsü güncelleme) kapalıdır. Yalnız n11
        API bilgileriniz istenir. Kargo ve etiket işlemleri açılmaz.
      </p>
      <details className="integration-connection-advanced integration-capability-warning">
        <summary>
          Senkronizasyon imleci engelli · tarih doğrulaması bekleniyor
          <br />
          <code>N11_EPOCH_SEMANTICS_UNVERIFIED · BLOCKED_EXTERNAL</code>
        </summary>
        <Alert tone="warning">
          Hesabın okuma doğrulaması tarih parametrelerinin anlamını kanıtlamaz.
          Tarih semantiği doğrulanana kadar kontrol noktası ilerlemez.
        </Alert>
      </details>
      {loading ? <IntegrationLoading /> : null}
      {loadError ? (
        <Alert tone="danger" role="alert">
          {loadError}
        </Alert>
      ) : null}
      <ul
        className="integration-connection-accounts"
        aria-label="n11 hesapları"
      >
        {accounts.map((account) => (
          <IntegrationAccountCard
            key={account.marketplaceAccountId}
            data-n11-account={account.marketplaceAccountId}
            title={account.displayName ?? 'n11 hesabı'}
            state={
              <Badge tone="neutral">
                {!account.isActive
                  ? 'Pasif'
                  : account.config
                    ? 'Kayıtlı'
                    : 'Kimlik yok'}
              </Badge>
            }
            facts={[
              [
                'API anahtarı',
                account.config
                  ? `API anahtarı: ${account.config.appKeyMasked}`
                  : 'Kimlik yok',
              ],
              [
                'API şifresi',
                account.config?.hasAppSecret
                  ? 'API şifresi kayıtlı'
                  : 'API şifresi yok',
              ],
              [
                'Satıcı',
                account.config?.sellerId
                  ? `Satıcı: ${account.config.sellerId}`
                  : 'Satıcı henüz okunmadı',
              ],
              [
                'Okuma durumu',
                <span data-health-state={account.health.state}>
                  {account.healthLabel ?? account.health.state}
                </span>,
              ],
              [
                'Son okuma denemesi',
                formatDateTime(account.health.lastAttemptAt ?? null),
              ],
              ...(account.health.lastSuccessfulSyncAt
                ? [
                    [
                      'Kayıtlı siparişler',
                      `${formatDateTime(account.health.lastSuccessfulSyncAt)} itibarıyla`,
                    ] as [string, string],
                  ]
                : []),
            ]}
            actions={
              <>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={
                    busyAccount !== null ||
                    formState === 'saving' ||
                    !account.isActive
                  }
                  onClick={() => void testAccount(account.marketplaceAccountId)}
                >
                  {busyAccount === account.marketplaceAccountId
                    ? 'Çalışıyor…'
                    : 'Test Et'}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={
                    busyAccount !== null ||
                    formState === 'saving' ||
                    !account.isActive
                  }
                  onClick={() => void syncAccount(account.marketplaceAccountId)}
                >
                  Senkronize Et
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  disabled={busyAccount !== null || formState === 'saving'}
                  onClick={() => startEdit(account)}
                >
                  Düzenle
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  disabled={busyAccount !== null || formState === 'saving'}
                  onClick={() => void disconnect(account.marketplaceAccountId)}
                >
                  Bağlantıyı Kaldır
                </button>
              </>
            }
          >
            <AccountReadStatus
              isActive={account.isActive}
              configured={Boolean(account.config)}
              verificationStatus={account.verificationStatus}
              ordersActive={account.ordersActive}
              verifying={
                verifyingAccount === account.marketplaceAccountId ||
                (formState === 'saving' &&
                  editing?.marketplaceAccountId ===
                    account.marketplaceAccountId)
              }
            />
            {results[account.marketplaceAccountId] ? (
              <Alert
                tone={
                  results[account.marketplaceAccountId].ok ? 'info' : 'danger'
                }
                role={
                  results[account.marketplaceAccountId].ok ? 'status' : 'alert'
                }
              >
                {results[account.marketplaceAccountId].message}
              </Alert>
            ) : null}
          </IntegrationAccountCard>
        ))}
      </ul>
      {!loading && accounts.length === 0 && !loadError ? (
        <p className="integration-connection-empty">Bağlı n11 hesabı yok.</p>
      ) : null}
      <IntegrationFormSection
        title={editing ? 'Hesabı düzenle' : 'Yeni hesap bağla'}
        description="Kayıtlı anahtar ve şifre geri gösterilmez. Düzenlerken boş bıraktığınız değerler korunur."
      >
        <Field label="API anahtarı (appKey)" htmlFor="n11-app-key">
          <input
            id="n11-app-key"
            type="text"
            value={form.appKey}
            autoComplete="off"
            placeholder={
              editing?.config
                ? `Kayıtlı: ${editing.config.appKeyMasked} — değiştirmek için yeni hesap bağlayın`
                : ''
            }
            onChange={update('appKey')}
          />
        </Field>
        <Field label="API şifresi (appSecret)" htmlFor="n11-app-secret">
          <input
            id="n11-app-secret"
            type="password"
            value={form.appSecret}
            autoComplete="new-password"
            placeholder={editing ? 'Değiştirmek için girin' : ''}
            onChange={update('appSecret')}
          />
        </Field>
      </IntegrationFormSection>
      <IntegrationFormActions>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={formState === 'saving' || busyAccount !== null}
          onClick={() => void save()}
        >
          {editing ? 'Değişiklikleri Kaydet' : 'Kaydet ve Bağla'}
        </button>
        {editing ? (
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => {
              setEditing(null)
              setForm(EMPTY_FORM)
            }}
          >
            Vazgeç
          </button>
        ) : null}
      </IntegrationFormActions>
      {formState === 'saving' ? (
        <Alert tone="info" role="status">
          Doğrulanıyor…
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
