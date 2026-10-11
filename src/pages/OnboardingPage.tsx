// Organization ilk giriş onboarding akışı. Mevcut entegrasyon (save/test) ve
// sync (fetchProducts/fetchOrders) servis metodlarını YENİDEN KULLANIR; ikinci
// bir credential/sync sistemi yazılmaz. Tamamlanma ve adım durumu SUNUCUDADIR;
// tarayıcıda SAKLANMAZ. Sürat create ÇAĞRILMAZ.
//
// ONBOARDING-001:
//   · Adımlar anlamsaldır (pazaryeri / taşıyıcı / ilk senkron); pazaryeri
//     adımı SUNUCUNUN uygun bulduğu sağlayıcıları gösterir, ad sunucudan gelir.
//   · Açılışta kurulum SUNUCUNUN söylediği ilk eksik adımdan SÜRER.
//   · "Kayıtlı" ile "doğrulandı" ayrıdır: kimlik varlığı doğrulama DEĞİLDİR.
//   · Adıma gitmek HİÇBİR ağ işlemi başlatmaz; senkron/test yalnız tıklamayla.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IntegrationConfig, IntegrationTestResult } from '../types/cargoflow'
import {
  integrationConfigService,
  workflowService,
} from '../services/appServices'
import {
  completeOnboarding,
  fetchOnboardingStatus,
  ONBOARDING_STEP_ORDER,
  type OnboardingBootstrapResource,
  type OnboardingMarketplaceView,
  type OnboardingStatus,
  type OnboardingStepKey,
} from '../services/onboardingService'
import { useAuth } from '../auth/useAuth'

const BLOCKER_LABELS: Record<string, string> = {
  NO_ELIGIBLE_MARKETPLACE: 'Şu anda kurulabilir bir pazaryeri bağlantısı yok',
  MARKETPLACE_NOT_CONFIGURED: 'Pazaryeri bağlantısı kaydedilmeli',
  MARKETPLACE_NOT_VERIFIED: 'Pazaryeri kimlik bilgileri reddedildi; bilgileri kontrol edin',
  FIRST_SYNC_REQUIRED: 'En az bir başarılı ilk senkron gerekli',
  CARRIER_NOT_CONFIGURED: 'Kargo bağlantısı kaydedilmeli',
}

const RESOURCE_LABELS: Record<OnboardingBootstrapResource, { idle: string; busy: string }> = {
  products: { idle: 'Ürünleri Senkronize Et', busy: 'Ürünler senkronize ediliyor…' },
  orders: { idle: 'Siparişleri Senkronize Et', busy: 'Siparişler senkronize ediliyor…' },
}

/**
 * Sağlayıcıya özel MEVCUT senkron aksiyonları. Yeni bir sağlayıcı için sahte
 * genel form/aksiyon ÜRETİLMEZ: burada yoksa buton gösterilmez.
 */
const SYNC_ACTIONS: Record<
  string,
  Partial<Record<OnboardingBootstrapResource, (config: IntegrationConfig) => Promise<string>>>
> = {
  trendyol: {
    products: async (config) => (await workflowService.fetchProducts(config)).result.message,
    orders: async (config) => (await workflowService.fetchOrders(config)).result.message,
  },
}

function stepLabel(key: OnboardingStepKey, status: OnboardingStatus): string {
  switch (key) {
    case 'WELCOME':
      return 'Hoş Geldiniz'
    case 'MARKETPLACE':
      return status.marketplaces.length === 1
        ? `${status.marketplaces[0].displayName} Bağlantısı`
        : 'Pazaryeri Bağlantısı'
    case 'CARRIER':
      return `${status.carrier.displayName} Bağlantısı`
    case 'FIRST_SYNC':
      return 'İlk Senkronizasyon'
    case 'READY':
      return 'Hazır'
  }
}

export function OnboardingPage({
  initialStatus,
  onCompleted,
}: {
  initialStatus: OnboardingStatus
  onCompleted: () => void
}) {
  const auth = useAuth()
  // SÜRDÜRME: sunucunun hesapladığı ilk eksik adımdan açılır. Gezinme durumu
  // yalnız bu oturumdadır (geçicidir); tamamlanma gerçeği değildir.
  const [stepIndex, setStepIndex] = useState(() =>
    Math.max(0, ONBOARDING_STEP_ORDER.indexOf(initialStatus.resumeStep)),
  )
  const [status, setStatus] = useState<OnboardingStatus>(initialStatus)
  const [config, setConfig] = useState<IntegrationConfig>(() =>
    integrationConfigService.loadIntegrationConfig(),
  )
  const [marketplaceTest, setMarketplaceTest] = useState<IntegrationTestResult | null>(null)
  const [carrierTest, setCarrierTest] = useState<IntegrationTestResult | null>(null)
  const [syncMessages, setSyncMessages] = useState<Record<string, string>>({})
  const [completeError, setCompleteError] = useState<string[] | null>(null)
  // Eşzamanlı/çift tıklama koruması: her aksiyon için ayrı meşguliyet bayrağı.
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const inFlight = useRef<Set<string>>(new Set())
  const mounted = useRef(true)

  // Onboarding yalnız auth modda görünür; sync'in sunucu credential'ını
  // kullanması için servis auth moduna alınır. Bu YEREL bir ayardır; ağ
  // üzerinden senkron/test BAŞLATMAZ.
  useEffect(() => {
    mounted.current = true
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

  const withBusy = useCallback(async (key: string, fn: () => Promise<void>) => {
    // Çift tıklama: aynı aksiyon eşzamanlı TEKRAR başlatılmaz (ref, render
    // beklemeden kilitler).
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    setBusy((current) => ({ ...current, [key]: true }))
    try {
      await fn()
    } catch {
      // Ham hata metni kullanıcıya TAŞINMAZ; durum sunucudan yenilenir.
      if (mounted.current) {
        setSyncMessages((current) => ({ ...current, [key]: 'İşlem tamamlanamadı; lütfen tekrar deneyin.' }))
      }
    } finally {
      inFlight.current.delete(key)
      if (mounted.current) {
        setBusy((current) => ({ ...current, [key]: false }))
      }
    }
  }, [])

  const saveAndTestMarketplace = () =>
    withBusy('marketplace', async () => {
      await integrationConfigService.persistIntegrationConfig(config)
      const result = await workflowService.testTrendyolConnection(config)
      if (!mounted.current) return
      setMarketplaceTest(result)
      await refreshStatus()
    })

  const saveCarrier = () =>
    withBusy('carrierSave', async () => {
      await integrationConfigService.persistIntegrationConfig(config)
      await refreshStatus()
    })

  const testCarrier = () =>
    withBusy('carrierTest', async () => {
      // Yalnız güvenli bağlantı/credential doğrulaması; gönderi OLUŞTURMAZ.
      const result = await workflowService.testSuratConnection(config)
      if (!mounted.current) return
      setCarrierTest(result)
    })

  const runSync = (providerKey: string, resource: OnboardingBootstrapResource) => {
    const action = SYNC_ACTIONS[providerKey]?.[resource]
    if (!action) return
    const key = `sync:${providerKey}:${resource}`
    void withBusy(key, async () => {
      const message = await action(config)
      if (!mounted.current) return
      setSyncMessages((current) => ({ ...current, [key]: message }))
      await refreshStatus()
    })
  }

  const finish = () =>
    withBusy('complete', async () => {
      setCompleteError(null)
      const result = await completeOnboarding()
      if (!mounted.current) return
      if (result.ok) {
        onCompleted()
        return
      }
      if (result.status) setStatus(result.status)
      setCompleteError(result.blockers)
    })

  const stepKey = ONBOARDING_STEP_ORDER[stepIndex]
  const requiredSteps = status.steps.filter((step) => step.required)

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
          {ONBOARDING_STEP_ORDER.map((key, index) => {
            const view = status.steps.find((step) => step.key === key)
            const done = Boolean(view?.required && view.done)
            return (
              <li
                key={key}
                data-step={key}
                className={index === stepIndex ? 'is-active' : done ? 'is-done' : ''}
                aria-current={index === stepIndex ? 'step' : undefined}
              >
                <span className="onboarding-step-index">{done ? '✓' : index + 1}</span>
                <span>{stepLabel(key, status)}</span>
              </li>
            )
          })}
        </ol>

        <section className="onboarding-body">
          {stepKey === 'WELCOME' && (
            <div className="onboarding-card">
              <h2>Hoş Geldiniz</h2>
              <p>
                Bu kısa kurulumda satış kanalınızı ve {status.carrier.displayName}
                {' '}bağlantınızı kaydeder, ilk senkronu başlatır ve panele
                geçersiniz. Bilgileriniz yalnız bu organizasyona aittir.
              </p>
            </div>
          )}

          {stepKey === 'MARKETPLACE' && (
            <div className="onboarding-card">
              <h2>{stepLabel('MARKETPLACE', status)}</h2>
              {status.marketplaces.length === 0 && (
                <p className="onboarding-warn">{BLOCKER_LABELS.NO_ELIGIBLE_MARKETPLACE}.</p>
              )}
              {status.marketplaces.map((marketplace) => (
                <div key={marketplace.providerKey} data-provider={marketplace.providerKey}>
                  <MarketplaceChips marketplace={marketplace} />
                  {marketplace.providerKey === 'trendyol' && (
                    <>
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
                      <button
                        type="button"
                        disabled={busy.marketplace}
                        onClick={() => void saveAndTestMarketplace()}
                      >
                        {busy.marketplace ? 'Test ediliyor…' : 'Kaydet ve Bağlantıyı Test Et'}
                      </button>
                      <SessionTestResult result={marketplaceTest} />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {stepKey === 'CARRIER' && (
            <div className="onboarding-card">
              <h2>{stepLabel('CARRIER', status)}</h2>
              <div className="onboarding-chips">
                <Chip on={status.carrier.configured}>
                  {status.carrier.configured ? 'Kayıtlı' : 'Kayıt yok'}
                </Chip>
                {status.carrier.configured && (
                  <Chip on={false}>Kalıcı doğrulama kaydı yok</Chip>
                )}
              </div>
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
                <button type="button" disabled={busy.carrierSave} onClick={() => void saveCarrier()}>
                  {busy.carrierSave ? 'Kaydediliyor…' : 'Kaydet'}
                </button>
                <button type="button" disabled={busy.carrierTest} onClick={() => void testCarrier()}>
                  {busy.carrierTest ? 'Test ediliyor…' : 'Bağlantıyı Test Et'}
                </button>
              </div>
              <SessionTestResult result={carrierTest} />
              <p className="onboarding-note">
                Bağlantı testi gönderi oluşturmaz. Sonucu yalnız bu oturumda
                gösterilir; kalıcı doğrulama olarak saklanmaz.
              </p>
            </div>
          )}

          {stepKey === 'FIRST_SYNC' && (
            <div className="onboarding-card">
              <h2>İlk Senkronizasyon</h2>
              {status.marketplaces.map((marketplace) => (
                <div key={marketplace.providerKey} data-provider={marketplace.providerKey}>
                  <p className={marketplace.bootstrapReady ? 'onboarding-ok' : 'onboarding-info'}>
                    {marketplace.bootstrapReady
                      ? `${marketplace.displayName}: ilk senkron başarılı.`
                      : `${marketplace.displayName}: henüz başarılı bir ilk senkron yok.`}
                  </p>
                  <div className="onboarding-actions">
                    {marketplace.bootstrapResources
                      .filter((resource) => SYNC_ACTIONS[marketplace.providerKey]?.[resource])
                      .map((resource) => {
                        const key = `sync:${marketplace.providerKey}:${resource}`
                        return (
                          <button
                            key={resource}
                            type="button"
                            disabled={busy[key] || !marketplace.configured}
                            onClick={() => runSync(marketplace.providerKey, resource)}
                          >
                            {busy[key] ? RESOURCE_LABELS[resource].busy : RESOURCE_LABELS[resource].idle}
                          </button>
                        )
                      })}
                  </div>
                  {!marketplace.configured && (
                    <p className="onboarding-note">Senkron için önce bağlantıyı kaydedin.</p>
                  )}
                  {marketplace.bootstrapResources.map((resource) => {
                    const message = syncMessages[`sync:${marketplace.providerKey}:${resource}`]
                    return message ? (
                      <p key={resource} className="onboarding-info">{message}</p>
                    ) : null
                  })}
                </div>
              ))}
              <ul className="onboarding-counts">
                <li>Ürünler: {status.counts.products}</li>
                <li>Siparişler: {status.counts.orders}</li>
              </ul>
              <p className="onboarding-note">
                Sıfır kayıt dönen başarılı bir senkron da geçerlidir.
              </p>
            </div>
          )}

          {stepKey === 'READY' && (
            <div className="onboarding-card">
              <h2>Hazır</h2>
              <p>Kurulum adımları tamamlandığında panele geçebilirsiniz.</p>
              <ul className="onboarding-summary" aria-label="Kurulum kontrol listesi">
                {requiredSteps.map((step) => (
                  <li key={step.key} data-done={step.done ? 'true' : 'false'}>
                    {step.done ? '✓' : '•'} {stepLabel(step.key, status)}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy.complete || !status.eligibleToComplete}
                onClick={() => void finish()}
              >
                {busy.complete ? 'Tamamlanıyor…' : 'Kurulumu Tamamla ve Panele Geç'}
              </button>
              {!status.eligibleToComplete && status.blockers.length > 0 && (
                <ul className="onboarding-warn" aria-label="Eksik adımlar">
                  {status.blockers.map((code) => (
                    <li key={code}>{BLOCKER_LABELS[code] ?? code}</li>
                  ))}
                </ul>
              )}
              {completeError && completeError.length > 0 && (
                <p className="onboarding-warn">Kurulum tamamlanamadı; eksik adımları tamamlayın.</p>
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
          {stepIndex < ONBOARDING_STEP_ORDER.length - 1 && (
            <button
              type="button"
              onClick={() =>
                setStepIndex((index) => Math.min(ONBOARDING_STEP_ORDER.length - 1, index + 1))
              }
            >
              İleri
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function Chip({ on, warn = false, children }: { on: boolean; warn?: boolean; children: string }) {
  return (
    <span className={on ? 'onboarding-chip is-on' : warn ? 'onboarding-chip is-warn' : 'onboarding-chip'}>
      {children}
    </span>
  )
}

/**
 * "Kayıtlı" ile "doğrulandı" AYRIDIR. Doğrulama yalnız kimlik doğrulanmış
 * GERÇEK bir okuma (başarılı ilk senkron) kaydı varsa söylenir.
 */
function MarketplaceChips({ marketplace }: { marketplace: OnboardingMarketplaceView }) {
  return (
    <div className="onboarding-chips">
      <Chip on={marketplace.configured}>{marketplace.configured ? 'Kayıtlı' : 'Kayıt yok'}</Chip>
      {marketplace.bootstrapReady ? (
        <Chip on>Bağlantı doğrulandı</Chip>
      ) : marketplace.credentialsRejected ? (
        <Chip on={false} warn>Kimlik bilgileri reddedildi</Chip>
      ) : (
        <Chip on={false}>Henüz doğrulanmadı</Chip>
      )}
    </div>
  )
}

/** Bu oturumdaki etkileşimli testin sonucu — KALICI doğrulama değildir. */
function SessionTestResult({ result }: { result: IntegrationTestResult | null }) {
  if (!result) return null
  return (
    <p className={result.ok ? 'onboarding-ok' : 'onboarding-warn'} role="status">
      {result.ok
        ? 'Bağlantı testi sonucu bu oturumda başarılı.'
        : 'Bağlantı testi başarısız.'}
      {result.message ? ` ${result.message}` : ''}
    </p>
  )
}
