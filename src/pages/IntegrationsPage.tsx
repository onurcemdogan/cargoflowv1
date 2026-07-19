import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileText,
  Globe2,
  KeyRound,
  PackageSearch,
  Plug,
  RefreshCcw,
  Save,
  Settings2,
  ShoppingBag,
  Store,
  TestTube2,
  Truck,
} from 'lucide-react'
import { useState } from 'react'
import { ActionResult } from '../components/ActionResult'
import { PageHeader } from '../components/PageHeader'
import { routeFromServiceMode } from '../services/integrationConfigService'
import type {
  IntegrationConfig,
  IntegrationTestResult,
  WorkflowResult,
} from '../types/cargoflow'
import { formatDisplayDate, maskSecret } from '../utils/formatters'
import {
  integrationCategoryTabs,
  suratDetailTabs,
  trendyolDetailTabs,
  type IntegrationCategory,
  type SuratDetailTab,
  type TrendyolDetailTab,
} from '../utils/integrationWorkspace'

interface IntegrationsPageProps {
  config: IntegrationConfig
  result?: WorkflowResult
  busy: boolean
  trendyolTest?: IntegrationTestResult
  suratTest?: IntegrationTestResult
  onSave: (config: IntegrationConfig) => void
  onTestTrendyol: (config: IntegrationConfig) => void
  onTestSurat: (config: IntegrationConfig) => void
  onFetchOrders: (config: IntegrationConfig) => void
  onFetchProducts: (config: IntegrationConfig) => void
}

const emptyCategoryMessages: Record<
  Exclude<IntegrationCategory, 'marketplaces' | 'carriers'>,
  { title: string; description: string }
> = {
  commerceSites: {
    title: 'E-Ticaret sitesi henüz eklenmedi.',
    description: 'Bağlı bir e-ticaret sitesi bulunmuyor.',
  },
  invoiceIntegrators: {
    title: 'Fatura entegratörü bulunamadı.',
    description: 'Bu alanda henüz aktif bir fatura entegrasyonu yok.',
  },
  otherServices: {
    title: 'Diğer servis bulunamadı.',
    description: 'Ek bir servis bağlantısı henüz tanımlanmadı.',
  },
  systemSettings: {
    title: 'Sistem ayarı bulunamadı.',
    description: 'Bu kategori ileride kullanılmak üzere hazır tutuluyor.',
  },
}

export function IntegrationsPage({
  config,
  result,
  busy,
  trendyolTest,
  suratTest,
  onSave,
  onTestTrendyol,
  onTestSurat,
  onFetchOrders,
  onFetchProducts,
}: IntegrationsPageProps) {
  const initialSuratServiceMode =
    config.surat.serviceMode ?? 'ORTAK_BARKOD_SOAP'
  const [form, setForm] = useState<IntegrationConfig>({
    ...config,
    trendyol: {
      ...config.trendyol,
      environment: config.trendyol.environment ?? 'prod',
      userAgentName: config.trendyol.userAgentName ?? '',
    },
    surat: {
      ...config.surat,
      serviceMode: initialSuratServiceMode,
      ...routeFromServiceMode(initialSuratServiceMode),
      trackingServiceType: 'KargoTakipHareketDetayiSoap',
    },
  })
  const [activeCategory, setActiveCategory] =
    useState<IntegrationCategory>('marketplaces')
  const [activeIntegration, setActiveIntegration] = useState<
    'trendyol' | 'surat' | null
  >(null)
  const [activeTrendyolTab, setActiveTrendyolTab] =
    useState<TrendyolDetailTab>('general')
  const [activeSuratTab, setActiveSuratTab] =
    useState<SuratDetailTab>('general')

  const trendyolConfigured = Boolean(
    form.trendyol.sellerId && form.trendyol.apiKey && form.trendyol.apiSecret,
  )
  const suratConfigured = Boolean(
    form.surat.kullaniciAdi && form.surat.sifre && form.surat.firmaId,
  )

  function selectCategory(category: IntegrationCategory) {
    setActiveCategory(category)
    setActiveIntegration(null)
  }

  return (
    <div className="integrations-workspace">
      <PageHeader
        title="Entegrasyonlar / Ayarlar"
        description="Pazaryeri ve kargo bağlantılarını tek ekrandan yönetin."
      />

      <ActionResult result={result} />

      <nav className="integration-category-tabs" aria-label="Entegrasyon kategorileri">
        {integrationCategoryTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={activeCategory === tab.key ? 'active' : ''}
            aria-pressed={activeCategory === tab.key}
            onClick={() => selectCategory(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <form
        className="integration-settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          onSave(form)
        }}
      >
        {activeCategory === 'marketplaces' ? (
          <IntegrationCard
            type="marketplace"
            title="Trendyol"
            description="Pazaryeri sipariş ve ürün entegrasyonu"
            configured={trendyolConfigured}
            test={trendyolTest}
            facts={[
              ['Mağaza', form.trendyol.sellerId || '-'],
              [
                'Ortam',
                form.trendyol.environment === 'prod' ? 'Canlı' : 'Test',
              ],
              ['API', trendyolConfigured ? 'Yapılandırıldı' : 'Eksik'],
              ['Son kontrol', formatTestDate(trendyolTest)],
            ]}
            busy={busy}
            primaryAction={{
              label: 'Senkronize Et',
              icon: <RefreshCcw size={16} />,
              onClick: () => onFetchOrders(form),
            }}
            onSettings={() => {
              setActiveIntegration('trendyol')
              setActiveTrendyolTab('general')
            }}
          />
        ) : null}

        {activeCategory === 'carriers' ? (
          <IntegrationCard
            type="carrier"
            title="Sürat Kargo"
            description="Gönderi, ortak barkod ve takip entegrasyonu"
            configured={suratConfigured}
            test={suratTest}
            facts={[
              ['Müşteri Kodu', form.surat.kullaniciAdi || '-'],
              ['Ortam', form.surat.ortam === 'live' ? 'Canlı' : 'Test'],
              ['Anlaşmalı', suratConfigured ? 'Evet' : 'Kurulum gerekli'],
              ['Son bağlantı', formatTestDate(suratTest)],
            ]}
            busy={busy}
            primaryAction={{
              label: 'Test Et',
              icon: <TestTube2 size={16} />,
              onClick: () => onTestSurat(form),
            }}
            onSettings={() => {
              setActiveIntegration('surat')
              setActiveSuratTab('general')
            }}
          />
        ) : null}

        {activeCategory !== 'marketplaces' &&
        activeCategory !== 'carriers' ? (
          <EmptyIntegrationCategory
            {...emptyCategoryMessages[activeCategory]}
          />
        ) : null}

        {activeCategory === 'marketplaces' &&
        activeIntegration === 'trendyol' ? (
          <TrendyolSettingsPanel
            form={form}
            setForm={setForm}
            activeTab={activeTrendyolTab}
            setActiveTab={setActiveTrendyolTab}
            busy={busy}
            test={trendyolTest}
            onSave={onSave}
            onTest={onTestTrendyol}
            onFetchOrders={onFetchOrders}
            onFetchProducts={onFetchProducts}
          />
        ) : null}

        {activeCategory === 'carriers' && activeIntegration === 'surat' ? (
          <SuratSettingsPanel
            form={form}
            setForm={setForm}
            activeTab={activeSuratTab}
            setActiveTab={setActiveSuratTab}
            busy={busy}
            test={suratTest}
            onSave={onSave}
            onTest={onTestSurat}
          />
        ) : null}
      </form>
    </div>
  )
}

interface IntegrationCardProps {
  type: 'marketplace' | 'carrier'
  title: string
  description: string
  configured: boolean
  test?: IntegrationTestResult
  facts: Array<[string, string]>
  busy: boolean
  primaryAction: {
    label: string
    icon: React.ReactNode
    onClick: () => void
  }
  onSettings: () => void
}

function IntegrationCard({
  type,
  title,
  description,
  configured,
  test,
  facts,
  busy,
  primaryAction,
  onSettings,
}: IntegrationCardProps) {
  const Icon = type === 'marketplace' ? ShoppingBag : Truck
  const statusOk = test ? test.ok : configured

  return (
    <section className="integration-provider-card">
      <div className={`integration-provider-icon ${type}`}>
        <Icon size={24} />
      </div>
      <div className="integration-provider-main">
        <div className="integration-provider-heading">
          <div>
            <span className="integration-card-kicker">
              {type === 'marketplace' ? 'Pazaryeri' : 'Kargo firması'}
            </span>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <span
            className={`integration-status-badge ${statusOk ? 'active' : 'waiting'}`}
          >
            {statusOk ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
            {test ? (test.ok ? 'Bağlı' : 'Kontrol gerekli') : configured ? 'Aktif' : 'Kurulum gerekli'}
          </span>
        </div>

        <div className="integration-card-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>

        <div className="integration-card-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onSettings}
          >
            <Settings2 size={16} />
            Ayarlar
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={primaryAction.onClick}
            disabled={busy}
          >
            {primaryAction.icon}
            {primaryAction.label}
          </button>
        </div>
      </div>
    </section>
  )
}

function EmptyIntegrationCategory({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <section className="integration-empty-state">
      <div>
        <Plug size={24} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  )
}

interface TrendyolSettingsPanelProps {
  form: IntegrationConfig
  setForm: React.Dispatch<React.SetStateAction<IntegrationConfig>>
  activeTab: TrendyolDetailTab
  setActiveTab: (tab: TrendyolDetailTab) => void
  busy: boolean
  test?: IntegrationTestResult
  onSave: (config: IntegrationConfig) => void
  onTest: (config: IntegrationConfig) => void
  onFetchOrders: (config: IntegrationConfig) => void
  onFetchProducts: (config: IntegrationConfig) => void
}

function TrendyolSettingsPanel({
  form,
  setForm,
  activeTab,
  setActiveTab,
  busy,
  test,
  onSave,
  onTest,
  onFetchOrders,
  onFetchProducts,
}: TrendyolSettingsPanelProps) {
  function updateTrendyol(
    patch: Partial<IntegrationConfig['trendyol']>,
  ) {
    setForm((current) => ({
      ...current,
      trendyol: { ...current.trendyol, ...patch },
    }))
  }

  return (
    <section className="integration-detail-panel" aria-label="Trendyol ayarları">
      <div className="integration-detail-heading">
        <div className="integration-provider-icon marketplace">
          <ShoppingBag size={22} />
        </div>
        <div>
          <span>Pazaryeri entegrasyonu</span>
          <h2>Trendyol Ayarları</h2>
        </div>
      </div>

      <DetailTabs
        tabs={trendyolDetailTabs}
        activeTab={activeTab}
        onChange={setActiveTab}
        label="Trendyol ayar bölümleri"
      />

      <div className="integration-detail-content">
        {activeTab === 'general' ? (
          <>
            <DetailSectionHeader
              icon={<Settings2 size={18} />}
              title="Genel Ayarlar"
              description="Bağlantının mevcut yapılandırma özetini görüntüleyin."
            />
            <ReadOnlyIntegrationGrid
              values={[
                ['Durum', form.trendyol.sellerId ? 'Yapılandırıldı' : 'Kurulum gerekli'],
                ['Ortam', form.trendyol.environment === 'prod' ? 'Canlı' : 'Test'],
                ['Seller ID', form.trendyol.sellerId || '-'],
                ['User-Agent', form.trendyol.userAgentName || '-'],
              ]}
            />
          </>
        ) : null}

        {activeTab === 'api' ? (
          <>
            <DetailSectionHeader
              icon={<KeyRound size={18} />}
              title="API Bilgileri"
              description="Mevcut Trendyol API bağlantı bilgileri."
            />
            <div className="integration-field-grid">
              <label>
                <span>sellerId</span>
                <input
                  aria-label="Trendyol sellerId"
                  value={form.trendyol.sellerId}
                  onChange={(event) =>
                    updateTrendyol({ sellerId: event.target.value })
                  }
                  placeholder="123456"
                />
              </label>
              <label>
                <span>Ortam</span>
                <select
                  aria-label="Trendyol ortam"
                  value={form.trendyol.environment}
                  onChange={(event) =>
                    updateTrendyol({
                      environment: event.target.value as 'prod' | 'stage',
                    })
                  }
                >
                  <option value="prod">prod - apigw.trendyol.com</option>
                  <option value="stage">stage - stageapigw.trendyol.com</option>
                </select>
              </label>
              <label>
                <span>apiKey</span>
                <input
                  aria-label="Trendyol apiKey"
                  type="password"
                  value={form.trendyol.apiKey}
                  onChange={(event) =>
                    updateTrendyol({ apiKey: event.target.value })
                  }
                  placeholder="Trendyol API key"
                />
              </label>
              <label>
                <span>apiSecret</span>
                <input
                  aria-label="Trendyol apiSecret"
                  type="password"
                  value={form.trendyol.apiSecret}
                  onChange={(event) =>
                    updateTrendyol({ apiSecret: event.target.value })
                  }
                  placeholder="Trendyol API secret"
                />
              </label>
              <label className="wide">
                <span>User-Agent / Entegratör adı</span>
                <input
                  aria-label="Trendyol User-Agent"
                  value={form.trendyol.userAgentName}
                  onChange={(event) =>
                    updateTrendyol({ userAgentName: event.target.value })
                  }
                  placeholder="CargoFlow veya sellerId - CargoFlow"
                />
              </label>
            </div>
            <p className="integration-field-note">
              Kayıt önizlemesi: sellerId {form.trendyol.sellerId || 'boş'}, key{' '}
              {maskSecret(form.trendyol.apiKey)}. Mevcut User-Agent biçimlendirmesi
              korunur.
            </p>
            <div className="integration-detail-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => onTest(form)}
                disabled={busy}
              >
                <TestTube2 size={17} />
                Bağlantıyı Test Et
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => onFetchOrders(form)}
                disabled={busy}
              >
                <RefreshCcw size={17} />
                Siparişleri Çek
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => onFetchProducts(form)}
                disabled={busy}
              >
                <PackageSearch size={17} />
                Ürünleri Çek
              </button>
            </div>
          </>
        ) : null}

        {activeTab === 'store' ? (
          <SimpleDetailContent
            icon={<Store size={18} />}
            title="Mağaza"
            description="Bağlı Trendyol mağazasının mevcut hesap bilgileri."
            values={[
              ['Seller ID', form.trendyol.sellerId || '-'],
              ['API ortamı', form.trendyol.environment],
            ]}
          />
        ) : null}

        {activeTab === 'orders' ? (
          <EmptyDetailSection
            icon={<ShoppingBag size={18} />}
            title="Sipariş Ayarları"
            message="Mevcut sipariş akışı varsayılan ayarlarla çalışıyor."
          />
        ) : null}

        {activeTab === 'products' ? (
          <EmptyDetailSection
            icon={<PackageSearch size={18} />}
            title="Ürün Ayarları"
            message="Mevcut ürün senkronizasyonu varsayılan ayarlarla çalışıyor."
          />
        ) : null}

        {activeTab === 'stock' ? (
          <EmptyDetailSection
            icon={<Globe2 size={18} />}
            title="Stok Ayarları"
            message="Bu entegrasyon için ek stok ayarı bulunmuyor."
          />
        ) : null}

        {activeTab === 'logs' ? (
          <>
            <DetailSectionHeader
              icon={<FileText size={18} />}
              title="Loglar"
              description="Son bağlantı testi sonucu."
            />
            <IntegrationResult result={test} emptyText="Henüz Trendyol bağlantı testi yapılmadı." />
          </>
        ) : null}
      </div>

      <div className="integration-detail-footer">
        <button
          type="button"
          className="primary-button"
          onClick={() => onSave(form)}
          disabled={busy}
        >
          <Save size={17} />
          Kaydet
        </button>
      </div>
    </section>
  )
}

interface SuratSettingsPanelProps {
  form: IntegrationConfig
  setForm: React.Dispatch<React.SetStateAction<IntegrationConfig>>
  activeTab: SuratDetailTab
  setActiveTab: (tab: SuratDetailTab) => void
  busy: boolean
  test?: IntegrationTestResult
  onSave: (config: IntegrationConfig) => void
  onTest: (config: IntegrationConfig) => void
}

function SuratSettingsPanel({
  form,
  setForm,
  activeTab,
  setActiveTab,
  busy,
  test,
  onSave,
  onTest,
}: SuratSettingsPanelProps) {
  function updateSurat(patch: Partial<IntegrationConfig['surat']>) {
    setForm((current) => ({
      ...current,
      surat: { ...current.surat, ...patch },
    }))
  }

  return (
    <section className="integration-detail-panel" aria-label="Sürat Kargo ayarları">
      <div className="integration-detail-heading">
        <div className="integration-provider-icon carrier">
          <Truck size={22} />
        </div>
        <div>
          <span>Kargo entegrasyonu</span>
          <h2>Sürat Kargo Ayarları</h2>
        </div>
      </div>

      <DetailTabs
        tabs={suratDetailTabs}
        activeTab={activeTab}
        onChange={setActiveTab}
        label="Sürat Kargo ayar bölümleri"
      />

      <div className="integration-detail-content">
        {activeTab === 'general' ? (
          <>
            <DetailSectionHeader
              icon={<Settings2 size={18} />}
              title="Genel"
              description="Sürat bağlantısının mevcut çalışma ortamı."
            />
            <div className="integration-field-grid">
              <label>
                <span>Ortam</span>
                <select
                  aria-label="Sürat ortam"
                  value={form.surat.ortam}
                  onChange={(event) =>
                    updateSurat({
                      ortam: event.target.value as 'test' | 'live',
                    })
                  }
                >
                  <option value="test">test - api02.suratkargo.com.tr</option>
                  <option value="live">live - api01.suratkargo.com.tr</option>
                </select>
              </label>
            </div>
            <ReadOnlyIntegrationGrid
              values={[
                ['Müşteri Kodu', form.surat.kullaniciAdi || '-'],
                ['Firma ID', form.surat.firmaId || '-'],
                ['Ortam', form.surat.ortam === 'live' ? 'Canlı' : 'Test'],
                ['Servis modu', serviceModeLabel(form.surat.serviceMode)],
              ]}
            />
          </>
        ) : null}

        {activeTab === 'account' ? (
          <>
            <DetailSectionHeader
              icon={<KeyRound size={18} />}
              title="Hesap"
              description="Mevcut Sürat cari ve sorgulama bilgileri."
            />
            <div className="integration-field-grid">
              <label>
                <span>Cari Kodu / Kullanıcı Adı</span>
                <input
                  aria-label="Sürat Cari Kodu"
                  value={form.surat.kullaniciAdi}
                  onChange={(event) =>
                    updateSurat({ kullaniciAdi: event.target.value })
                  }
                  placeholder="Sürat cari kodu"
                />
              </label>
              <label>
                <span>Şifre</span>
                <input
                  aria-label="Sürat Şifre"
                  type="password"
                  value={form.surat.sifre}
                  onChange={(event) => updateSurat({ sifre: event.target.value })}
                  placeholder="Sürat web servis şifresi"
                />
              </label>
              <label>
                <span>FirmaId</span>
                <input
                  aria-label="Sürat FirmaId"
                  value={form.surat.firmaId}
                  onChange={(event) => updateSurat({ firmaId: event.target.value })}
                  placeholder="REST/V2 için firmaId"
                />
              </label>
              <label>
                <span>WebPassword / Sorgulama Şifresi</span>
                <input
                  aria-label="Sürat WebPassword"
                  type="password"
                  value={form.surat.webPassword ?? ''}
                  onChange={(event) =>
                    updateSurat({ webPassword: event.target.value })
                  }
                  placeholder="e-Sürat WebPassword"
                />
              </label>
            </div>

            <h3 className="integration-subheading">Satıcı Öder Hesabı</h3>
            <div className="integration-field-grid three-columns">
              <label>
                <span>Satıcı Öder Cari Kodu</span>
                <input
                  value={form.surat.sellerPaysKullaniciAdi ?? ''}
                  onChange={(event) =>
                    updateSurat({ sellerPaysKullaniciAdi: event.target.value })
                  }
                  placeholder="Boşsa mevcut cari kod kullanılır"
                />
              </label>
              <label>
                <span>Satıcı Öder WebPassword</span>
                <input
                  type="password"
                  value={form.surat.sellerPaysWebPassword ?? ''}
                  onChange={(event) =>
                    updateSurat({ sellerPaysWebPassword: event.target.value })
                  }
                  placeholder="Boşsa mevcut WebPassword kullanılır"
                />
              </label>
              <label>
                <span>Satıcı Öder Şifre</span>
                <input
                  type="password"
                  value={form.surat.sellerPaysSifre ?? ''}
                  onChange={(event) =>
                    updateSurat({ sellerPaysSifre: event.target.value })
                  }
                  placeholder="Boşsa mevcut Sürat şifresi kullanılır"
                />
              </label>
            </div>

            <h3 className="integration-subheading">Kapıda Ödeme Hesabı</h3>
            <div className="integration-field-grid three-columns">
              <label>
                <span>Kapıda Ödeme Cari Kodu</span>
                <input
                  value={form.surat.codKullaniciAdi ?? ''}
                  onChange={(event) =>
                    updateSurat({ codKullaniciAdi: event.target.value })
                  }
                  placeholder="Kapıda ödeme cari kodu"
                />
              </label>
              <label>
                <span>Kapıda Ödeme WebPassword</span>
                <input
                  type="password"
                  value={form.surat.codWebPassword ?? ''}
                  onChange={(event) =>
                    updateSurat({ codWebPassword: event.target.value })
                  }
                  placeholder="Kapıda ödeme sorgulama şifresi"
                />
              </label>
              <label>
                <span>Kapıda Ödeme Şifre</span>
                <input
                  type="password"
                  value={form.surat.codSifre ?? ''}
                  onChange={(event) =>
                    updateSurat({ codSifre: event.target.value })
                  }
                  placeholder="Kapıda ödeme servis şifresi"
                />
              </label>
            </div>
          </>
        ) : null}

        {activeTab === 'agreement' ? (
          <>
            <DetailSectionHeader
              icon={<Truck size={18} />}
              title="Anlaşmalı Kargo"
              description="Mevcut gönderi servis yönlendirmesi."
            />
            <div className="integration-field-grid">
              <label>
                <span>Servis tipi</span>
                <select
                  aria-label="Sürat servis tipi"
                  value={form.surat.serviceMode}
                  onChange={(event) => {
                    const serviceMode = event.target
                      .value as IntegrationConfig['surat']['serviceMode']
                    updateSurat({
                      serviceMode,
                      ...routeFromServiceMode(serviceMode),
                    })
                  }}
                >
                  <option value="ORTAK_BARKOD_SOAP">
                    Gerçek Sürat kaydı + ortak etiket
                  </option>
                  <option value="KARGO_BARKODU_SIPARIS_SOAP">
                    KargoBarkoduSiparis SOAP
                  </option>
                  <option value="PRE_REGISTRATION_REST">
                    GonderiyiKargoyaGonder REST
                  </option>
                  <option value="GONDERI_YENI_SOAP">
                    GonderiyiKargoyaGonderYeni SOAP
                  </option>
                  <option value="GONDERI_OLUSTUR_V2_EXPERIMENTAL">
                    GonderiOlusturV2
                  </option>
                </select>
              </label>
              <label>
                <span>Gönderi endpointi</span>
                <select value={form.surat.createShipmentPath} disabled>
                  <option value="/api/OrtakBarkodOlustur">/api/OrtakBarkodOlustur</option>
                  <option value="/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur">
                    /api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur
                  </option>
                  <option value="/api/KargoBarkoduSiparis">/api/KargoBarkoduSiparis</option>
                  <option value="/api/GonderiyiKargoyaGonderYeni">/api/GonderiyiKargoyaGonderYeni</option>
                  <option value="/api/Gonderi/GonderiOlustur">/api/Gonderi/GonderiOlustur</option>
                  <option value="/api/GonderiyiKargoyaGonder">/api/GonderiyiKargoyaGonder</option>
                </select>
              </label>
              {form.surat.serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP' ? (
                <>
                  <label>
                    <span>Sürat Entegrasyon Sözleşme No</span>
                    <input
                      value={form.surat.entegrasyonSozlesme ?? ''}
                      onChange={(event) =>
                        updateSurat({ entegrasyonSozlesme: event.target.value })
                      }
                      placeholder="Sürat tarafından verilen sözleşme numarası"
                    />
                  </label>
                  <label>
                    <span>WhoPays</span>
                    <input
                      value={form.surat.whoPays ?? ''}
                      onChange={(event) =>
                        updateSurat({ whoPays: event.target.value })
                      }
                      placeholder="Hesabınıza tanımlı değer"
                    />
                  </label>
                </>
              ) : null}
            </div>
            {form.surat.serviceMode === 'PRE_REGISTRATION_REST' ? (
              <p className="integration-field-note">
                Bu servis yalnız ön kayıt oluşturur; takip numarası daha sonra
                dönebilir.
              </p>
            ) : null}
            {form.surat.serviceMode === 'GONDERI_OLUSTUR_V2_EXPERIMENTAL' ? (
              <p className="integration-inline-warning">
                Bu endpoint deneysel olarak işaretli mevcut servis seçeneğidir.
              </p>
            ) : null}
          </>
        ) : null}

        {activeTab === 'commonBarcode' ? (
          <>
            <DetailSectionHeader
              icon={<RefreshCcw size={18} />}
              title="Ortak Barkod"
              description="Mevcut takip ve barkod response alan eşleştirmesi."
            />
            <div className="integration-field-grid">
              <label>
                <span>Takip servis tipi</span>
                <select
                  value={form.surat.trackingServiceType}
                  onChange={(event) =>
                    updateSurat({
                      trackingServiceType: event.target
                        .value as IntegrationConfig['surat']['trackingServiceType'],
                    })
                  }
                >
                  <option value="KargoTakipHareketDetayiSoap">
                    SOAP - KargoTakipHareketDetayi
                  </option>
                  <option value="KargoTakipHareketDetayiRest">
                    REST - KargoTakipHareketDetayi
                  </option>
                </select>
              </label>
              <label>
                <span>Sürat takip no response alanı</span>
                <select
                  value={form.surat.trackingCodeField}
                  onChange={(event) =>
                    updateSurat({ trackingCodeField: event.target.value })
                  }
                >
                  <option value="auto">Otomatik</option>
                  <option value="KargoTakipNo">KargoTakipNo</option>
                  <option value="trackingNumber">trackingNumber</option>
                  <option value="TakipNo">TakipNo</option>
                  <option value="GonderiNo">GonderiNo</option>
                  <option value="waybillNo">waybillNo</option>
                  <option value="cargoKey">cargoKey</option>
                </select>
              </label>
              <label>
                <span>Sürat barkod response alanı</span>
                <select
                  value={form.surat.barcodeCodeField}
                  onChange={(event) =>
                    updateSurat({ barcodeCodeField: event.target.value })
                  }
                >
                  <option value="auto">Otomatik</option>
                  <option value="BarkodNo">BarkodNo</option>
                  <option value="barcode">barcode</option>
                  <option value="Barkod">Barkod</option>
                  <option value="Barcode">Barcode</option>
                </select>
              </label>
              <label>
                <span>Etiketteki T.No response alanı</span>
                <select
                  value={form.surat.tNoCodeField}
                  onChange={(event) =>
                    updateSurat({ tNoCodeField: event.target.value })
                  }
                >
                  <option value="auto">Otomatik</option>
                  <option value="TNo">TNo</option>
                  <option value="KargoTakipNo">KargoTakipNo</option>
                  <option value="TakipNo">TakipNo</option>
                </select>
              </label>
            </div>
            <p className="integration-field-note">
              Bu seçimler yalnızca Sürat API response alanlarını eşler; mevcut
              doğrulama kuralları değişmez.
            </p>
          </>
        ) : null}

        {activeTab === 'label' ? (
          <>
            <DetailSectionHeader
              icon={<FileText size={18} />}
              title="Etiket"
              description="Mevcut tenant desi varsayılanı."
            />
            <div className="integration-field-grid">
              <label>
                <span>Varsayılan birim desi</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.desi?.defaultUnitDesi ?? ''}
                  placeholder="Boş = eksik desili sipariş engellenir"
                  onChange={(event) => {
                    const value = Number(event.target.value.replace(',', '.'))
                    setForm((current) => ({
                      ...current,
                      desi: {
                        ...(current.desi ?? {
                          categoryDefaults: {},
                          productOverrides: {},
                          variantOverrides: {},
                        }),
                        defaultUnitDesi:
                          Number.isFinite(value) && value > 0 ? value : null,
                      },
                    }))
                  }}
                />
              </label>
            </div>
            <p className="integration-field-note">
              Mevcut ürün, varyant, kategori ve tenant desi önceliği aynen
              korunur.
            </p>
          </>
        ) : null}

        {activeTab === 'sync' ? (
          <>
            <DetailSectionHeader
              icon={<RefreshCcw size={18} />}
              title="Senkronizasyon"
              description="Mevcut bağlantı testi ve kayıt callback’leri."
            />
            <div className="integration-detail-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => onTest(form)}
                disabled={busy}
              >
                <TestTube2 size={17} />
                Bağlantıyı Test Et
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => onSave(form)}
                disabled={busy}
              >
                <Save size={17} />
                Kaydet
              </button>
            </div>
          </>
        ) : null}

        {activeTab === 'logs' ? (
          <>
            <DetailSectionHeader
              icon={<FileText size={18} />}
              title="Loglar"
              description="Son Sürat bağlantı testi sonucu."
            />
            <IntegrationResult result={test} emptyText="Henüz Sürat bağlantı testi yapılmadı." />
          </>
        ) : null}
      </div>

      <div className="integration-detail-footer">
        <button
          type="button"
          className="secondary-button"
          onClick={() => onTest(form)}
          disabled={busy}
        >
          <TestTube2 size={17} />
          Test Et
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          <Save size={17} />
          Kaydet
        </button>
      </div>
    </section>
  )
}

function DetailTabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  label,
}: {
  tabs: Array<{ key: T; label: string }>
  activeTab: T
  onChange: (tab: T) => void
  label: string
}) {
  return (
    <nav className="integration-detail-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={activeTab === tab.key ? 'active' : ''}
          aria-pressed={activeTab === tab.key}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}

function DetailSectionHeader({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="integration-section-heading">
      <div>{icon}</div>
      <span>
        <h3>{title}</h3>
        <p>{description}</p>
      </span>
    </div>
  )
}

function ReadOnlyIntegrationGrid({
  values,
}: {
  values: Array<[string, string]>
}) {
  return (
    <div className="integration-readonly-grid">
      {values.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}

function SimpleDetailContent({
  icon,
  title,
  description,
  values,
}: {
  icon: React.ReactNode
  title: string
  description: string
  values: Array<[string, string]>
}) {
  return (
    <>
      <DetailSectionHeader icon={icon} title={title} description={description} />
      <ReadOnlyIntegrationGrid values={values} />
    </>
  )
}

function EmptyDetailSection({
  icon,
  title,
  message,
}: {
  icon: React.ReactNode
  title: string
  message: string
}) {
  return (
    <>
      <DetailSectionHeader icon={icon} title={title} description={message} />
      <div className="integration-detail-empty">
        <Clock3 size={20} />
        <span>{message}</span>
      </div>
    </>
  )
}

function IntegrationResult({
  result,
  emptyText,
}: {
  result?: IntegrationTestResult
  emptyText: string
}) {
  if (!result) {
    return <div className="integration-detail-empty">{emptyText}</div>
  }

  return (
    <div className={result.ok ? 'integration-result ok' : 'integration-result fail'}>
      <strong>{result.ok ? 'Bağlantı başarılı' : 'Bağlantı hatalı'}</strong>
      <span>{result.message}</span>
      <span>Kaynak: {result.source === 'local' ? 'Yerel kayıt' : 'Gerçek API'}</span>
      <span>Kontrol: {formatTestDate(result)}</span>
      {result.rawPreview ? (
        <details>
          <summary>Detayları göster</summary>
          <pre>{JSON.stringify(result.rawPreview, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  )
}

function formatTestDate(result?: IntegrationTestResult): string {
  return result?.checkedAt ? formatDisplayDate(result.checkedAt) : '-'
}

function serviceModeLabel(
  mode: IntegrationConfig['surat']['serviceMode'],
): string {
  switch (mode) {
    case 'ORTAK_BARKOD_SOAP':
      return 'Ortak Barkod SOAP'
    case 'KARGO_BARKODU_SIPARIS_SOAP':
      return 'Kargo Barkodu Sipariş SOAP'
    case 'PRE_REGISTRATION_REST':
      return 'Ön Kayıt REST'
    case 'GONDERI_YENI_SOAP':
      return 'Gönderi Yeni SOAP'
    case 'GONDERI_OLUSTUR_V2_EXPERIMENTAL':
      return 'Gönderi Oluştur V2'
    default:
      return mode
  }
}
