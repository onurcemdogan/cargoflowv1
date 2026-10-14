// HEPSIBURADA HESAPLARI — İÇ TEST (INTERNAL_TEST), YALNIZ OKUMA.
//
// ═══ DÜRÜST YAYIN DURUMU ═════════════════════════════════════════════════
//
// Güvenli GET yalnız bu hesabın kimliğini doğrular ve kanonik sipariş
// okumasını açar. Kargo/etiket ve pazaryeri yazmaları ayrı kapıda kalır.
//
// ═══ UYDURMA YOL YOK ═════════════════════════════════════════════════════
//
// Resmî sözleşme uç nokta YOLLARINI kanıtlamadığı için yol alanları
// kullanıcıdan gelir; boşsa sunucu isteği KURMAZ (ENDPOINT_CONFIG_REQUIRED).
//
// ═══ SIR GERİ GÖSTERİLMEZ ════════════════════════════════════════════════
//
// Parola kaydedildikten sonra HİÇBİR ZAMAN geri okunmaz; yalnız "kayıtlı"
// bilgisi gösterilir. Düzenlemede parola/kullanıcı adı boş bırakılırsa
// kayıtlı değer korunur.
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
import { AccountReadStatus } from './AccountReadStatus'

export const HEPSIBURADA_ACCOUNTS_ENDPOINT = '/api/integrations/hepsiburada/accounts'
export const HEPSIBURADA_DISCONNECT_ENDPOINT = '/api/integrations/hepsiburada/accounts/disconnect'
export const HEPSIBURADA_TEST_ENDPOINT = '/api/integrations/hepsiburada/accounts/test'
export const HEPSIBURADA_SYNC_ENDPOINT = '/api/integrations/hepsiburada/accounts/sync'

export interface HepsiburadaAccountRow {
  marketplaceAccountId: string
  merchantId: string
  displayName: string | null
  isActive: boolean
  config: {
    merchantId: string
    usernameMasked: string
    hasPassword: boolean
    host: string
    environment: 'SIT' | 'PRODUCTION'
    ordersPath: string | null
    packagesPath: string | null
    listField: string | null
  } | null
  health: { state: string; reasonCode: string | null; lastSuccessfulSyncAt: string | null; lastAttemptAt?: string | null }
  healthLabel?: string
  verificationStatus?: string
  ordersActive?: boolean
}

interface FormFields {
  merchantId: string
  username: string
  password: string
  host: string
  packagesPath: string
  ordersPath: string
  listField: string
}

const EMPTY_FORM: FormFields = {
  merchantId: '',
  username: '',
  password: '',
  host: '',
  packagesPath: '',
  ordersPath: '',
  listField: '',
}

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

export function HepsiburadaSection() {
  const [accounts, setAccounts] = useState<HepsiburadaAccountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormFields>(EMPTY_FORM)
  const [editing, setEditing] = useState<string | null>(null)
  const [formState, setFormState] = useState<FormState>('idle')
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [busyAccount, setBusyAccount] = useState<string | null>(null)
  const [verifyingAccount, setVerifyingAccount] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, ActionResult>>({})

  const load = useCallback(async (): Promise<HepsiburadaAccountRow[] | null> => {
    try {
      const response = await authenticatedApiRequest(HEPSIBURADA_ACCOUNTS_ENDPOINT)
      const body = (await response.json()) as { ok?: boolean; accounts?: HepsiburadaAccountRow[] }
      if (!response.ok || !body?.ok) return null
      return Array.isArray(body.accounts) ? body.accounts : []
    } catch {
      return null
    }
  }, [])

  const applyLoad = useCallback((rows: HepsiburadaAccountRow[] | null) => {
    if (rows === null) {
      setLoadError('Hepsiburada hesapları okunamadı.')
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

  function startEdit(account: HepsiburadaAccountRow) {
    setResults((current) => { const next = { ...current }; delete next[account.marketplaceAccountId]; return next })
    setEditing(account.marketplaceAccountId)
    setFormState('idle')
    setFormMessage(null)
    setForm({
      merchantId: account.merchantId,
      // Kullanıcı adı ve parola GERİ DOLDURULMAZ; boş bırakılırsa korunur.
      username: '',
      password: '',
      host: account.config?.host ?? '',
      packagesPath: account.config?.packagesPath ?? '',
      ordersPath: account.config?.ordersPath ?? '',
      listField: account.config?.listField ?? '',
    })
  }

  async function save() {
    if (formState === 'saving' || busyAccount) return
    setFormState('saving')
    setFormMessage(null)
    try {
      const response = await authenticatedApiRequest(HEPSIBURADA_ACCOUNTS_ENDPOINT, { method: 'POST', json: editing ? { ...form, marketplaceAccountId: editing } : form })
      const body = (await response.json()) as { ok?: boolean; message?: string }
      if (!response.ok || !body?.ok) {
        setFormState('error')
        setFormMessage(body?.message ?? 'Yapılandırma kaydedilemedi.')
        return
      }
      setFormState('saved')
      setFormMessage(body.message ?? 'Yapılandırma kaydedildi.')
      // SIR EKRANDA BIRAKILMAZ.
      setForm((current) => ({ ...current, password: '' }))
      setEditing(null)
      applyLoad(await load())
    } catch {
      setFormState('error')
      setFormMessage('Yapılandırma kaydedilemedi.')
    }
  }

  async function runAction(marketplaceAccountId: string, endpoint: string, summarize: (body: Record<string, unknown>) => string) {
    if (busyAccount) return
    setBusyAccount(marketplaceAccountId)
    setVerifyingAccount(endpoint === HEPSIBURADA_TEST_ENDPOINT ? marketplaceAccountId : null)
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
    runAction(id, HEPSIBURADA_TEST_ENDPOINT, (body) => `Okuma isteği yanıt verdi (${Number(body.recordsRead ?? 0)} kayıt). ${String(body.message ?? '')}`.trim())
  const syncAccount = (id: string) =>
    runAction(id, HEPSIBURADA_SYNC_ENDPOINT, (body) =>
      `${Number(body.fetched ?? 0)} kayıt okundu. ${String(body.note ?? body.message ?? '')}`.trim())

  async function disconnect(marketplaceAccountId: string) {
    try {
      const response = await authenticatedApiRequest(HEPSIBURADA_DISCONNECT_ENDPOINT, { method: 'POST', json: { marketplaceAccountId } })
      const body = (await response.json()) as { ok?: boolean }
      if (!response.ok || !body?.ok) return
      applyLoad(await load())
    } catch {
      // Sessiz başarı YOK: liste değişmez.
    }
  }

  return (
    <IntegrationConnectionCard
      provider="hepsiburada"
      title="Hepsiburada"
      kind="marketplace"
      testId="hepsiburada-section"
      description="API bilgilerinizi kaydedin; hesabınız güvenli bir okuma isteğiyle doğrulanır. Doğrulanan hesabın siparişleri sisteme alınabilir."
      badges={
        <>
          <span
            className="ui-badge tone-info"
            data-testid="hepsiburada-rollout-badge"
          >
            SİPARİŞ OKUMA
          </span>
          <Badge tone="warning">İç test · salt okunur</Badge>
        </>
      }
    >
      <p className="integration-connection-note">
        Uç nokta yolları resmî dokümanda doğrulanmadığı için
        Hepsiburada&apos;nın size verdiği yolları girin; yol girilmezse istek
        gönderilmez. Paket penceresi en fazla 24 saattir. Kargo, etiket ve
        pazaryeri yazmaları kapalıdır.
      </p>
      {loading ? <IntegrationLoading /> : null}
      {loadError ? (
        <Alert tone="danger" role="alert">
          {loadError}
        </Alert>
      ) : null}
      <ul
        className="integration-connection-accounts"
        aria-label="Hepsiburada hesapları"
      >
        {accounts.map((account) => (
          <IntegrationAccountCard
            key={account.marketplaceAccountId}
            data-hepsiburada-account={account.marketplaceAccountId}
            title={account.displayName ?? `Hepsiburada • ${account.merchantId}`}
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
              ['Merchant ID', account.merchantId],
              [
                'Ortam / host',
                account.config
                  ? `${account.config.host} (${account.config.environment === 'SIT' ? 'Test ortamı' : 'Üretim'})`
                  : 'Kimlik yok',
              ],
              [
                'API kullanıcı adı',
                account.config?.usernameMasked
                  ? `Kullanıcı: ${account.config.usernameMasked}`
                  : 'Kullanıcı yok',
              ],
              [
                'Parola',
                account.config?.hasPassword ? 'Parola kayıtlı' : 'Parola yok',
              ],
              [
                'Paket uç noktası',
                account.config?.packagesPath
                  ? `Paket yolu: ${account.config.packagesPath}`
                  : 'Paket yolu yok',
              ],
              [
                'Sipariş uç noktası',
                account.config?.ordersPath
                  ? `Sipariş yolu: ${account.config.ordersPath}`
                  : 'Sipariş yolu yok',
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
                  editing === account.marketplaceAccountId)
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
        <p className="integration-connection-empty">
          Bağlı Hepsiburada hesabı yok.
        </p>
      ) : null}
      <IntegrationFormSection
        title={editing ? 'Hesabı düzenle' : 'Yeni hesap bağla'}
        description="Kayıtlı kullanıcı adı ve parola geri gösterilmez. Düzenlerken boş bıraktığınız değerler korunur."
      >
        <Field label="Merchant ID" htmlFor="hb-merchant-id">
          <input
            id="hb-merchant-id"
            type="text"
            value={form.merchantId}
            autoComplete="off"
            readOnly={editing !== null}
            onChange={update('merchantId')}
          />
        </Field>
        <Field label="API kullanıcı adı" htmlFor="hb-username">
          <input
            id="hb-username"
            type="text"
            value={form.username}
            autoComplete="off"
            placeholder={editing ? 'Değiştirmek için girin' : ''}
            onChange={update('username')}
          />
        </Field>
        <Field label="API parolası" htmlFor="hb-password">
          <input
            id="hb-password"
            type="password"
            value={form.password}
            autoComplete="new-password"
            placeholder={editing ? 'Değiştirmek için girin' : ''}
            onChange={update('password')}
          />
        </Field>
      </IntegrationFormSection>
      <details
        className="integration-connection-advanced"
        open={editing !== null}
      >
        <summary>Gelişmiş: ortam ve uç nokta yolları</summary>
        <IntegrationFormSection
          title="Hepsiburada uç noktaları"
          description="Hepsiburada'nın hesabınız için verdiği host ve yolları kullanın. Yol boşsa sunucu istek göndermez; SIT ve üretim hostları ayrı değerlendirilir."
        >
          <Field label="API host" htmlFor="hb-host">
            <input
              id="hb-host"
              type="text"
              value={form.host}
              autoComplete="off"
              placeholder="…-sit.hepsiburada.com"
              onChange={update('host')}
            />
          </Field>
          <Field label="Paket listesi yolu" htmlFor="hb-packages-path">
            <input
              id="hb-packages-path"
              type="text"
              value={form.packagesPath}
              autoComplete="off"
              placeholder="/… ({merchantId} kullanılabilir)"
              onChange={update('packagesPath')}
            />
          </Field>
          <Field label="Sipariş listesi yolu" htmlFor="hb-orders-path">
            <input
              id="hb-orders-path"
              type="text"
              value={form.ordersPath}
              autoComplete="off"
              placeholder="/… ({merchantId} kullanılabilir)"
              onChange={update('ordersPath')}
            />
          </Field>
          <Field label="Liste alanı (yanıt nesne ise)" htmlFor="hb-list-field">
            <input
              id="hb-list-field"
              type="text"
              value={form.listField}
              autoComplete="off"
              onChange={update('listField')}
            />
          </Field>
        </IntegrationFormSection>
      </details>
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
