// Organization ilk giriş onboarding akışı (5 adım). Mevcut entegrasyon
// (save/test) ve sync (fetchProducts/fetchOrders) servis metodlarını YENİDEN
// KULLANIR; ikinci bir credential/sync sistemi yazılmaz. onboardingCompleted
// kaynak-of-truth backend'tir; frontend'te SAKLANMAZ. Sürat create ÇAĞRILMAZ.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IntegrationConfig, IntegrationTestResult } from '../types/cargoflow'
import {
  integrationConfigService,
  workflowService,
} from '../services/appServices'
import {
  completeOnboarding,
  fetchOnboardingStatus,
  type OnboardingStatus,
} from '../services/onboardingService'
import { useAuth } from '../auth/useAuth'

const STEPS = [
  { key: 'welcome', label: 'Hoş Geldiniz' },
  { key: 'trendyol', label: 'Trendyol Bağlantısı' },
  { key: 'surat', label: 'Sürat Kargo Bağlantısı' },
  { key: 'sync', label: 'İlk Senkronizasyon' },
  { key: 'ready', label: 'Hazır' },
] as const

const MISSING_LABELS: Record<string, string> = {
  trendyolConfigured: 'Trendyol bağlantısı kurulmalı',
  firstSyncCompleted: 'En az bir başarılı ürün veya sipariş senkronu gerekli',
  suratConfigured: 'Sürat Kargo bağlantısı kurulmalı',
}

export function OnboardingPage({
  initialStatus,
  onCompleted,
}: {
  initialStatus: OnboardingStatus
  onCompleted: () => void
}) {
  const auth = useAuth()
  const [stepIndex, setStepIndex] = useState(0)
  const [status, setStatus] = useState<OnboardingStatus>(initialStatus)
  const [config, setConfig] = useState<IntegrationConfig>(() =>
    integrationConfigService.loadIntegrationConfig(),
  )
  const [trendyolTest, setTrendyolTest] = useState<IntegrationTestResult | null>(null)
  const [suratTest, setSuratTest] = useState<IntegrationTestResult | null>(null)
  const [productsSyncMessage, setProductsSyncMessage] = useState<string | null>(null)
  const [ordersSyncMessage, setOrdersSyncMessage] = useState<string | null>(null)
  const [completeError, setCompleteError] = useState<string[] | null>(null)
  // Eşzamanlı/çift tıklama koruması: her aksiyon için ayrı meşguliyet bayrağı.
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const mounted = useRef(true)

  // Onboarding yalnız auth modda görünür; sync'in sunucu credential'ını
  // kullanması için servis auth moduna alınır.
  useEffect(() => {
    workflowService.setAuthMode(true)
    void integrationConfigService.hydrateIntegrationConfig().catch(() => undefined)
    return () => {
      mounted.current = false
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchOnboardingStatus()
      if (next && mounted.current) {
        setStatus(next)
        if (next.completed) onCompleted()
      }
    } catch {
      // status yenileme best-effort; adım göstergeleri bir sonraki eylemde güncellenir
    }
  }, [onCompleted])

  const withBusy = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      if (busy[key]) return // çift tıklama: aynı aksiyon eşzamanlı tekrar başlatılmaz
      setBusy((current) => ({ ...current, [key]: true }))
      try {
        await fn()
      } finally {
        if (mounted.current) {
          setBusy((current) => ({ ...current, [key]: false }))
        }
      }
    },
    [busy],
  )

  const saveAndTestTrendyol = () =>
    withBusy('trendyol', async () => {
      await integrationConfigService.persistIntegrationConfig(config)
      const result = await workflowService.testTrendyolConnection(config)
      if (!mounted.current) return
      setTrendyolTest(result)
      await refreshStatus()
    })

  const saveSurat = () =>
    withBusy('suratSave', async () => {
      await integrationConfigService.persistIntegrationConfig(config)
      await refreshStatus()
    })

  const testSurat = () =>
    withBusy('suratTest', async () => {
      // Yalnız güvenli bağlantı/credential doğrulaması; gönderi OLUŞTURMAZ.
      const result = await workflowService.testSuratConnection(config)
      if (!mounted.current) return
      setSuratTest(result)
    })

  const syncProducts = () =>
    withBusy('syncProducts', async () => {
      const { result } = await workflowService.fetchProducts(config)
      if (!mounted.current) return
      setProductsSyncMessage(result.message)
      await refreshStatus()
    })

  const syncOrders = () =>
    withBusy('syncOrders', async () => {
      const { result } = await workflowService.fetchOrders(config)
      if (!mounted.current) return
      setOrdersSyncMessage(result.message)
      await refreshStatus()
    })

  const finish = () =>
    withBusy('complete', async () => {
      setCompleteError(null)
      const result = await completeOnboarding()
      if (!mounted.current) return
      if (result.ok) {
        onCompleted()
        return
      }
      setCompleteError(result.missing ?? [])
      await refreshStatus()
    })

  const canComplete = useMemo(
    () =>
      status.steps.trendyolConfigured &&
      status.steps.suratConfigured &&
      (status.steps.productsSynced || status.steps.ordersSynced),
    [status],
  )

  const step = STEPS[stepIndex]

  return (
    <div className="onboarding-screen">
      <div className="onboarding-shell">
        <header className="onboarding-header">
          <div className="auth-brand-mark">CF</div>
          <div>
            <h1>CargoFlow Kurulumu</h1>
            <p>{auth.user?.username ? `${auth.user.username} · ` : ''}Organizasyon ilk kurulumu</p>
          </div>
          <button
            type="button"
            className="onboarding-logout"
            onClick={() => void auth.signOut()}
          >
            Çıkış Yap
          </button>
        </header>

        <ol className="onboarding-steps" aria-label="Kurulum adımları">
          {STEPS.map((item, index) => (
            <li
              key={item.key}
              className={
                index === stepIndex
                  ? 'is-active'
                  : index < stepIndex
                    ? 'is-done'
                    : ''
              }
            >
              <span className="onboarding-step-index">{index + 1}</span>
              <span>{item.label}</span>
            </li>
          ))}
        </ol>

        <section className="onboarding-body">
          {step.key === 'welcome' && (
            <div className="onboarding-card">
              <h2>Hoş Geldiniz</h2>
              <p>
                Bu kısa kurulumda Trendyol ve Sürat Kargo bağlantılarını kurar,
                ilk ürün ve sipariş senkronunu başlatır ve panele geçersiniz.
                Bilgileriniz yalnız bu organizasyona aittir.
              </p>
            </div>
          )}

          {step.key === 'trendyol' && (
            <div className="onboarding-card">
              <h2>Trendyol Bağlantısı</h2>
              <StatusChip
                configured={status.steps.trendyolConfigured}
                verified={status.steps.trendyolConnectionVerified}
              />
              <label>
                Satıcı ID (sellerId)
                <input
                  value={config.trendyol.sellerId}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      trendyol: { ...current.trendyol, sellerId: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                API Key
                <input
                  value={config.trendyol.apiKey}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      trendyol: { ...current.trendyol, apiKey: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                API Secret
                <input
                  type="password"
                  value={config.trendyol.apiSecret}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      trendyol: { ...current.trendyol, apiSecret: event.target.value },
                    }))
                  }
                />
              </label>
              <button type="button" disabled={busy.trendyol} onClick={saveAndTestTrendyol}>
                {busy.trendyol ? 'Test ediliyor…' : 'Kaydet ve Bağlantıyı Test Et'}
              </button>
              {trendyolTest && (
                <p className={trendyolTest.ok ? 'onboarding-ok' : 'onboarding-warn'}>
                  {trendyolTest.message}
                </p>
              )}
            </div>
          )}

          {step.key === 'surat' && (
            <div className="onboarding-card">
              <h2>Sürat Kargo Bağlantısı</h2>
              <StatusChip
                configured={status.steps.suratConfigured}
                verified={status.steps.suratConnectionVerified}
              />
              <label>
                Kullanıcı Adı
                <input
                  value={config.surat.kullaniciAdi}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      surat: { ...current.surat, kullaniciAdi: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                Şifre
                <input
                  type="password"
                  value={config.surat.sifre}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      surat: { ...current.surat, sifre: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                Web Şifresi
                <input
                  type="password"
                  value={config.surat.webPassword ?? ''}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      surat: { ...current.surat, webPassword: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                Firma ID
                <input
                  value={config.surat.firmaId}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      surat: { ...current.surat, firmaId: event.target.value },
                    }))
                  }
                />
              </label>
              <div className="onboarding-actions">
                <button type="button" disabled={busy.suratSave} onClick={saveSurat}>
                  {busy.suratSave ? 'Kaydediliyor…' : 'Kaydet'}
                </button>
                <button type="button" disabled={busy.suratTest} onClick={testSurat}>
                  {busy.suratTest ? 'Test ediliyor…' : 'Bağlantıyı Test Et'}
                </button>
              </div>
              {suratTest && (
                <p className={suratTest.ok ? 'onboarding-ok' : 'onboarding-warn'}>
                  {suratTest.message}
                </p>
              )}
              <p className="onboarding-note">
                {status.suratVerificationNote ??
                  'Sürat bağlantı testi gönderi oluşturmaz; yalnız kimlik doğrulaması yapılır.'}
              </p>
            </div>
          )}

          {step.key === 'sync' && (
            <div className="onboarding-card">
              <h2>İlk Senkronizasyon</h2>
              <div className="onboarding-actions">
                <button type="button" disabled={busy.syncProducts} onClick={syncProducts}>
                  {busy.syncProducts ? 'Ürünler senkronize ediliyor…' : 'Ürünleri Senkronize Et'}
                </button>
                <button type="button" disabled={busy.syncOrders} onClick={syncOrders}>
                  {busy.syncOrders ? 'Siparişler senkronize ediliyor…' : 'Siparişleri Senkronize Et'}
                </button>
              </div>
              <ul className="onboarding-counts">
                <li>
                  Ürünler: {status.counts.products}{' '}
                  {status.steps.productsSynced ? '✓' : ''}
                </li>
                <li>
                  Siparişler: {status.counts.orders}{' '}
                  {status.steps.ordersSynced ? '✓' : ''}
                </li>
              </ul>
              {productsSyncMessage && <p className="onboarding-info">{productsSyncMessage}</p>}
              {ordersSyncMessage && <p className="onboarding-info">{ordersSyncMessage}</p>}
            </div>
          )}

          {step.key === 'ready' && (
            <div className="onboarding-card">
              <h2>Hazır</h2>
              <p>Kurulum adımları tamamlandığında panele geçebilirsiniz.</p>
              <ul className="onboarding-summary">
                <li>{status.steps.trendyolConfigured ? '✓' : '•'} Trendyol bağlantısı</li>
                <li>{status.steps.suratConfigured ? '✓' : '•'} Sürat Kargo bağlantısı</li>
                <li>
                  {status.steps.productsSynced || status.steps.ordersSynced ? '✓' : '•'} İlk
                  senkronizasyon
                </li>
              </ul>
              <button type="button" disabled={busy.complete || !canComplete} onClick={finish}>
                {busy.complete ? 'Tamamlanıyor…' : 'Kurulumu Tamamla ve Panele Geç'}
              </button>
              {!canComplete && (
                <p className="onboarding-note">
                  Tamamlamak için Trendyol ve Sürat bağlantısı ile en az bir başarılı
                  senkron gerekir.
                </p>
              )}
              {completeError && completeError.length > 0 && (
                <ul className="onboarding-warn">
                  {completeError.map((code) => (
                    <li key={code}>{MISSING_LABELS[code] ?? code}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <footer className="onboarding-footer">
          <button
            type="button"
            disabled={stepIndex === 0}
            onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
          >
            Geri
          </button>
          {stepIndex < STEPS.length - 1 && (
            <button
              type="button"
              onClick={() => setStepIndex((index) => Math.min(STEPS.length - 1, index + 1))}
            >
              İleri
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function StatusChip({
  configured,
  verified,
}: {
  configured: boolean
  verified: boolean
}) {
  return (
    <div className="onboarding-chips">
      <span className={configured ? 'onboarding-chip is-on' : 'onboarding-chip'}>
        {configured ? 'Kayıtlı' : 'Kayıt yok'}
      </span>
      <span className={verified ? 'onboarding-chip is-on' : 'onboarding-chip'}>
        {verified ? 'Doğrulandı' : 'Doğrulanmadı'}
      </span>
    </div>
  )
}
