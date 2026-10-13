// N11 HESAPLARI — İÇ TEST (INTERNAL_TEST), YALNIZ OKUMA.
//
// ═══ DÜRÜST YAYIN DURUMU ═════════════════════════════════════════════════
//
// n11 bağlayıcısı iç testtir: bağlantı ve paket OKUMA denenebilir, ama okunan
// kayıtlar canlı sipariş/kargo/etiket akışına YAZILMAZ. Canlı doğrulama
// yapılmadı; pazaryeri yazmaları (statü güncelleme vb.) kapalıdır.
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
import { useCallback, useEffect, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'

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

export function N11Section() {
  const [accounts, setAccounts] = useState<N11AccountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormFields>(EMPTY_FORM)
  const [editing, setEditing] = useState<N11AccountRow | null>(null)
  const [formState, setFormState] = useState<FormState>('idle')
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [busyAccount, setBusyAccount] = useState<string | null>(null)
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
    // appKey ve appSecret GERİ DOLDURULMAZ; boş bırakılırsa kayıtlı değer korunur.
    setEditing(account)
    setFormState('idle')
    setFormMessage(null)
    setForm(EMPTY_FORM)
  }

  async function save() {
    if (formState === 'saving') return
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
    <section className="integration-section" aria-labelledby="n11-title" data-testid="n11-section">
      <h3 id="n11-title">
        n11 <span className="ui-badge tone-info" data-testid="n11-rollout-badge">İÇ TEST</span>
      </h3>
      <p>
        n11 bağlantısı iç test aşamasındadır: paket okuma denenebilir, ancak okunan kayıtlar canlı sipariş,
        kargo ve etiket akışına aktarılmaz. Canlı doğrulama henüz yapılmadı.
      </p>
      <p>Pazaryeri yazmaları (sipariş statüsü güncelleme) kapalıdır. Yalnız n11 API bilgileriniz istenir.</p>

      {loading ? <p role="status">Yükleniyor…</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}

      <ul>
        {accounts.map((account) => (
          <li key={account.marketplaceAccountId} data-n11-account={account.marketplaceAccountId}>
            <span>{account.displayName ?? 'n11 hesabı'}</span>
            <span>{account.config ? `API anahtarı: ${account.config.appKeyMasked}` : 'Kimlik yok'}</span>
            {/* SIR DEĞERİ DEĞİL, YALNIZ VARLIĞI. */}
            <span>{account.config?.hasAppSecret ? 'API şifresi kayıtlı' : 'API şifresi yok'}</span>
            <span>{account.config?.sellerId ? `Satıcı: ${account.config.sellerId}` : 'Satıcı henüz okunmadı'}</span>
            <span data-health-state={account.health.state}>{account.healthLabel ?? account.health.state}</span>
            <span>Son okuma denemesi: {formatDateTime(account.health.lastAttemptAt ?? null)}</span>
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

      {!loading && accounts.length === 0 && !loadError ? <p>Bağlı n11 hesabı yok.</p> : null}

      <div>
        <label htmlFor="n11-app-key">API anahtarı (appKey)</label>
        <input
          id="n11-app-key"
          type="text"
          value={form.appKey}
          autoComplete="off"
          placeholder={editing?.config ? `Kayıtlı: ${editing.config.appKeyMasked} — değiştirmek için yeni hesap bağlayın` : ''}
          onChange={update('appKey')}
        />
        <label htmlFor="n11-app-secret">API şifresi (appSecret)</label>
        <input
          id="n11-app-secret"
          type="password"
          value={form.appSecret}
          autoComplete="new-password"
          placeholder={editing ? 'Değiştirmek için girin' : ''}
          onChange={update('appSecret')}
        />
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
