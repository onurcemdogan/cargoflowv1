// HEPSIBURADA HESAPLARI — İÇ TEST (INTERNAL_TEST), YALNIZ OKUMA.
//
// ═══ DÜRÜST YAYIN DURUMU ═════════════════════════════════════════════════
//
// Hepsiburada bağlayıcısı iç testtir: bağlantı ve sipariş/paket OKUMA
// denenebilir, ama okunan kayıtlar canlı sipariş/kargo/etiket akışına
// YAZILMAZ. Yüzey "canlı" demez; canlı doğrulama ayrı bir adımdır.
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
import { useCallback, useEffect, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'

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
    if (formState === 'saving') return
    setFormState('saving')
    setFormMessage(null)
    try {
      const response = await authenticatedApiRequest(HEPSIBURADA_ACCOUNTS_ENDPOINT, { method: 'POST', json: form })
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
    <section className="integration-section" aria-labelledby="hepsiburada-title" data-testid="hepsiburada-section">
      <h3 id="hepsiburada-title">
        Hepsiburada <span className="ui-badge tone-info" data-testid="hepsiburada-rollout-badge">İÇ TEST</span>
      </h3>
      <p>
        Hepsiburada bağlantısı iç test aşamasındadır: sipariş/paket okuma denenebilir, ancak okunan kayıtlar
        canlı sipariş, kargo ve etiket akışına aktarılmaz. Canlı doğrulama ayrıca yapılır.
      </p>
      <p>
        Uç nokta yolları resmî dokümanda doğrulanmadığı için Hepsiburada&apos;nın size verdiği yolları girin; yol
        girilmezse istek gönderilmez. Paket penceresi en fazla 24 saattir.
      </p>

      {loading ? <p role="status">Yükleniyor…</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}

      <ul>
        {accounts.map((account) => (
          <li key={account.marketplaceAccountId} data-hepsiburada-account={account.marketplaceAccountId}>
            <span>{account.displayName ?? `Hepsiburada • ${account.merchantId}`}</span>
            <span>{account.config ? `${account.config.host} (${account.config.environment === 'SIT' ? 'Test ortamı' : 'Üretim'})` : 'Kimlik yok'}</span>
            <span>{account.config?.usernameMasked ? `Kullanıcı: ${account.config.usernameMasked}` : 'Kullanıcı yok'}</span>
            {/* SIR DEĞERİ DEĞİL, YALNIZ VARLIĞI. */}
            <span>{account.config?.hasPassword ? 'Parola kayıtlı' : 'Parola yok'}</span>
            <span>{account.config?.packagesPath ? `Paket yolu: ${account.config.packagesPath}` : 'Paket yolu yok'}</span>
            <span>{account.config?.ordersPath ? `Sipariş yolu: ${account.config.ordersPath}` : 'Sipariş yolu yok'}</span>
            <span data-health-state={account.health.state}>{account.healthLabel ?? account.health.state}</span>
            <span>Son okuma denemesi: {formatDateTime(account.health.lastAttemptAt ?? null)}</span>
            {/* İmleç yalnız kayıtlar sisteme YAZILINCA ilerler (iç testte ilerlemez). */}
            {account.health.lastSuccessfulSyncAt ? (
              <span>Kayıtlı siparişler: {formatDateTime(account.health.lastSuccessfulSyncAt)} itibarıyla</span>
            ) : null}
            <span>{account.isActive ? 'Bağlı' : 'Bağlı değil'}</span>
            <span className="integration-account-actions">
              <button type="button" disabled={busyAccount !== null || !account.isActive} onClick={() => void testAccount(account.marketplaceAccountId)}>
                {busyAccount === account.marketplaceAccountId ? 'Çalışıyor…' : 'Test Et'}
              </button>
              <button type="button" disabled={busyAccount !== null || !account.isActive} onClick={() => void syncAccount(account.marketplaceAccountId)}>
                Senkronize Et
              </button>
              <button type="button" onClick={() => startEdit(account)}>Düzenle</button>
              <button type="button" onClick={() => void disconnect(account.marketplaceAccountId)}>Bağlantıyı Kaldır</button>
            </span>
            {results[account.marketplaceAccountId] ? (
              <span role={results[account.marketplaceAccountId].ok ? 'status' : 'alert'}>{results[account.marketplaceAccountId].message}</span>
            ) : null}
          </li>
        ))}
      </ul>

      {!loading && accounts.length === 0 && !loadError ? <p>Bağlı Hepsiburada hesabı yok.</p> : null}

      <div>
        <label htmlFor="hb-merchant-id">Merchant ID</label>
        <input id="hb-merchant-id" type="text" value={form.merchantId} autoComplete="off" readOnly={editing !== null} onChange={update('merchantId')} />
        <label htmlFor="hb-username">API kullanıcı adı</label>
        <input id="hb-username" type="text" value={form.username} autoComplete="off" placeholder={editing ? 'Değiştirmek için girin' : ''} onChange={update('username')} />
        <label htmlFor="hb-password">API parolası</label>
        <input id="hb-password" type="password" value={form.password} autoComplete="new-password" placeholder={editing ? 'Değiştirmek için girin' : ''} onChange={update('password')} />
        <label htmlFor="hb-host">API host</label>
        <input id="hb-host" type="text" value={form.host} autoComplete="off" placeholder="…-sit.hepsiburada.com" onChange={update('host')} />
        <label htmlFor="hb-packages-path">Paket listesi yolu</label>
        <input id="hb-packages-path" type="text" value={form.packagesPath} autoComplete="off" placeholder="/… ({merchantId} kullanılabilir)" onChange={update('packagesPath')} />
        <label htmlFor="hb-orders-path">Sipariş listesi yolu</label>
        <input id="hb-orders-path" type="text" value={form.ordersPath} autoComplete="off" placeholder="/… ({merchantId} kullanılabilir)" onChange={update('ordersPath')} />
        <label htmlFor="hb-list-field">Liste alanı (yanıt nesne ise)</label>
        <input id="hb-list-field" type="text" value={form.listField} autoComplete="off" onChange={update('listField')} />
        <button type="button" disabled={formState === 'saving'} onClick={() => void save()}>
          {editing ? 'Değişiklikleri Kaydet' : 'Kaydet ve Bağla'}
        </button>
        {editing ? (
          <button type="button" onClick={() => { setEditing(null); setForm(EMPTY_FORM) }}>Vazgeç</button>
        ) : null}
        {formState === 'saving' ? <span role="status">Kaydediliyor…</span> : null}
        {formState === 'saved' && formMessage ? <span role="status">{formMessage}</span> : null}
        {formState === 'error' && formMessage ? <span role="alert">{formMessage}</span> : null}
      </div>
    </section>
  )
}
