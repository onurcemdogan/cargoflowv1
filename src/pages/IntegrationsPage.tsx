import { PackageSearch, RefreshCcw, Save, TestTube2 } from 'lucide-react'
import { useState } from 'react'
import { ActionResult } from '../components/ActionResult'
import { PageHeader } from '../components/PageHeader'
import type {
  IntegrationConfig,
  IntegrationTestResult,
  WorkflowResult,
} from '../types/cargoflow'
import { routeFromServiceMode } from '../services/integrationConfigService'
import { maskSecret } from '../utils/formatters'

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

  return (
    <>
      <PageHeader
        title="Entegrasyonlar"
        description="Trendyol ve Sürat bağlantılarını canlı API üzerinden test et ve operasyon verisini senkronize et."
      />

      <ActionResult result={result} />

      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault()
          onSave(form)
        }}
      >
        <section className="panel">
          <div className="panel-heading">
            <h2>Trendyol Marketplace</h2>
            <span>sellerId / apiKey / apiSecret</span>
          </div>
          <label>
            <span>sellerId</span>
            <input
              value={form.trendyol.sellerId}
              onChange={(event) =>
                setForm({
                  ...form,
                  trendyol: { ...form.trendyol, sellerId: event.target.value },
                })
              }
              placeholder="123456"
            />
          </label>
          <label>
            <span>apiKey</span>
            <input
              type="password"
              value={form.trendyol.apiKey}
              onChange={(event) =>
                setForm({
                  ...form,
                  trendyol: { ...form.trendyol, apiKey: event.target.value },
                })
              }
              placeholder="Trendyol API key"
            />
          </label>
          <label>
            <span>apiSecret</span>
            <input
              type="password"
              value={form.trendyol.apiSecret}
              onChange={(event) =>
                setForm({
                  ...form,
                  trendyol: { ...form.trendyol, apiSecret: event.target.value },
                })
              }
              placeholder="Trendyol API secret"
            />
          </label>
          <label>
            <span>Ortam</span>
            <select
              value={form.trendyol.environment}
              onChange={(event) =>
                setForm({
                  ...form,
                  trendyol: {
                    ...form.trendyol,
                    environment: event.target.value as 'prod' | 'stage',
                  },
                })
              }
            >
              <option value="prod">prod - https://apigw.trendyol.com</option>
              <option value="stage">stage - https://stageapigw.trendyol.com</option>
            </select>
          </label>
          <label>
            <span>User-Agent / Entegratör adı</span>
            <input
              value={form.trendyol.userAgentName}
              onChange={(event) =>
                setForm({
                  ...form,
                  trendyol: {
                    ...form.trendyol,
                    userAgentName: event.target.value,
                  },
                })
              }
              placeholder="CargoFlow veya sellerId - CargoFlow"
            />
          </label>
          <p className="field-note">
            Kayıt önizlemesi: sellerId {form.trendyol.sellerId || 'boş'}, key{' '}
            {maskSecret(form.trendyol.apiKey)}. Trendyol isteğinde User-Agent
            otomatik olarak sellerId - entegratör adı formatına çevrilir.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => onTestTrendyol(form)}
              disabled={busy}
            >
              <TestTube2 size={18} />
              Bağlantıyı Test Et
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onFetchOrders(form)}
              disabled={busy}
            >
              <RefreshCcw size={18} />
              Siparişleri Çek
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onFetchProducts(form)}
              disabled={busy}
            >
              <PackageSearch size={18} />
              Ürünleri Çek
            </button>
          </div>
          <IntegrationResult result={trendyolTest} />
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h2>Sürat Kargo</h2>
            <span>Cari kodu / şifre gerçek SOAP servisinde test edilir</span>
          </div>
          <label>
            <span>Cari Kodu / Kullanıcı Adı</span>
            <input
              value={form.surat.kullaniciAdi}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: { ...form.surat, kullaniciAdi: event.target.value },
                })
              }
              placeholder="Sürat cari kodu"
            />
          </label>
          <label>
            <span>Şifre</span>
            <input
              type="password"
              value={form.surat.sifre}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: { ...form.surat, sifre: event.target.value },
                })
              }
              placeholder="Sürat web servis şifresi"
            />
          </label>
          <label>
            <span>firmaId</span>
            <input
              value={form.surat.firmaId}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: { ...form.surat, firmaId: event.target.value },
                })
              }
              placeholder="REST/V2 için firmaId"
            />
          </label>
          <label>
            <span>WebPassword / Sorgulama Sifresi</span>
            <input
              type="password"
              value={form.surat.webPassword ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    webPassword: event.target.value,
                  },
                })
              }
              placeholder="KargoBarkoduSiparis icin e-Surat WebPassword"
            />
          </label>
          <p className="field-note">
            Yukarıdaki mevcut bilgiler, Satıcı Öder hesabı için varsayılan olarak
            kullanılmaya devam eder. Farklı hesap varsa aşağıdaki alanlarla açıkça
            ayırabilirsiniz.
          </p>
          <label>
            <span>Satıcı Öder Cari Kodu</span>
            <input
              value={form.surat.sellerPaysKullaniciAdi ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    sellerPaysKullaniciAdi: event.target.value,
                  },
                })
              }
              placeholder="Boşsa mevcut cari kodu kullanılır"
            />
          </label>
          <label>
            <span>Satıcı Öder WebPassword</span>
            <input
              type="password"
              value={form.surat.sellerPaysWebPassword ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    sellerPaysWebPassword: event.target.value,
                  },
                })
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
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    sellerPaysSifre: event.target.value,
                  },
                })
              }
              placeholder="Boşsa mevcut Sürat şifresi kullanılır"
            />
          </label>
          <label>
            <span>Kapıda Ödeme Cari Kodu</span>
            <input
              value={form.surat.codKullaniciAdi ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    codKullaniciAdi: event.target.value,
                  },
                })
              }
              placeholder="Yalnız kapıda ödeme siparişlerinde kullanılır"
            />
          </label>
          <label>
            <span>Kapıda Ödeme WebPassword</span>
            <input
              type="password"
              value={form.surat.codWebPassword ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    codWebPassword: event.target.value,
                  },
                })
              }
              placeholder="Kapıda ödeme hesabının sorgulama şifresi"
            />
          </label>
          <label>
            <span>Kapıda Ödeme Şifre</span>
            <input
              type="password"
              value={form.surat.codSifre ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    codSifre: event.target.value,
                  },
                })
              }
              placeholder="Kapıda ödeme hesabının servis şifresi"
            />
          </label>
          {form.surat.serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP' ? (
            <>
              <label>
                <span>Sürat Entegrasyon Sözleşme No (opsiyonel)</span>
                <input
                  value={form.surat.entegrasyonSozlesme ?? ''}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      surat: {
                        ...form.surat,
                        entegrasyonSozlesme: event.target.value,
                      },
                    })
                  }
                  placeholder="Sürat tarafından verilen iç sözleşme numarası"
                />
              </label>
              <label>
                <span>WhoPays</span>
                <input
                  value={form.surat.whoPays ?? ''}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      surat: { ...form.surat, whoPays: event.target.value },
                    })
                  }
                  placeholder="Sürat hesabınıza tanımlı değer; bilinmiyorsa boş bırakın"
                />
              </label>
              <p className="field-note">
                WSDL bu XML alanını ister ancak pozitif bir numarayı zorunlu
                kılmaz. Numara bilinmiyorsa CargoFlow şemaya uygun olarak 0
                gönderir; hayali değer üretmez. WhoPays de yalnız Sürat hesabınıza
                tanımlı değer biliniyorsa doldurulmalıdır.
              </p>
            </>
          ) : null}
          <label>
            <span>ortam</span>
            <select
              value={form.surat.ortam}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    ortam: event.target.value as 'test' | 'live',
                  },
                })
              }
            >
              <option value="test">test - https://api02.suratkargo.com.tr</option>
              <option value="live">live - https://api01.suratkargo.com.tr</option>
            </select>
          </label>
          <label>
            <span>Servis tipi</span>
            <select
              value={form.surat.serviceMode}
              onChange={(event) => {
                const serviceMode = event.target
                  .value as IntegrationConfig['surat']['serviceMode']
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    serviceMode,
                    ...routeFromServiceMode(serviceMode),
                  },
                })
              }}
            >
              <option value="ORTAK_BARKOD_SOAP">
                Gerçek Sürat kaydı + ortak etiket (önerilen)
              </option>
              <option value="KARGO_BARKODU_SIPARIS_SOAP">
                KargoBarkoduSiparis SOAP (PDF barkod / onerilen)
              </option>
              <option value="PRE_REGISTRATION_REST">
                GonderiyiKargoyaGonder REST (Trendyol / önerilen)
              </option>
              <option value="GONDERI_YENI_SOAP">
                GonderiyiKargoyaGonderYeni SOAP (kontrollü deney)
              </option>
              <option value="GONDERI_OLUSTUR_V2_EXPERIMENTAL">
                GonderiOlusturV2 (deneysel / endpoint doğrulanmadı)
              </option>
            </select>
          </label>
          <label>
            <span>Gönderi endpointi</span>
            <select
              value={form.surat.createShipmentPath}
              disabled
            >
              <option value="/api/OrtakBarkodOlustur">
                /api/OrtakBarkodOlustur
              </option>
              <option value="/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur">
                /api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur
              </option>
              <option value="/api/KargoBarkoduSiparis">
                /api/KargoBarkoduSiparis
              </option>
              <option value="/api/GonderiyiKargoyaGonderYeni">
                /api/GonderiyiKargoyaGonderYeni
              </option>
              <option value="/api/Gonderi/GonderiOlustur">
                /api/Gonderi/GonderiOlustur
              </option>
              <option value="/api/GonderiyiKargoyaGonder">
                /api/GonderiyiKargoyaGonder
              </option>
            </select>
          </label>
          <label>
            <span>Takip servis tipi</span>
            <select
              value={form.surat.trackingServiceType}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    trackingServiceType: event.target
                      .value as IntegrationConfig['surat']['trackingServiceType'],
                  },
                })
              }
            >
              <option value="KargoTakipHareketDetayiSoap">
                SOAP - KargoTakipHareketDetayi
              </option>
              <option value="KargoTakipHareketDetayiRest">
                REST - KargoTakipHareketDetayi (doküman gerekli)
              </option>
            </select>
          </label>
          <label>
            <span>Sürat takip no response alanı</span>
            <select
              value={form.surat.trackingCodeField}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    trackingCodeField: event.target.value,
                  },
                })
              }
            >
              <option value="auto">Otomatik: KargoTakipNo / trackingNumber / TakipNo</option>
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
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    barcodeCodeField: event.target.value,
                  },
                })
              }
            >
              <option value="auto">Otomatik: BarkodNo / barcode / Barkod / Barcode</option>
              <option value="BarkodNo">BarkodNo</option>
              <option value="barcode">barcode</option>
              <option value="Barkod">Barkod</option>
              <option value="Barcode">Barcode (ZPL içindeki Code128)</option>
            </select>
          </label>
          <label>
            <span>Etiketteki T.No response alanı</span>
            <select
              value={form.surat.tNoCodeField}
              onChange={(event) =>
                setForm({
                  ...form,
                  surat: {
                    ...form.surat,
                    tNoCodeField: event.target.value,
                  },
                })
              }
            >
              <option value="auto">Otomatik: TNo / T.No</option>
              <option value="TNo">TNo</option>
              <option value="KargoTakipNo">KargoTakipNo</option>
              <option value="TakipNo">TakipNo</option>
            </select>
          </label>
          <p className="field-note">
            Bu seçimler yalnızca Sürat API response alanlarını eşler. Sipariş no
            veya yerel üretilen değer barkod/takip no olarak kullanılamaz.
          </p>
          {form.surat.serviceMode === 'PRE_REGISTRATION_REST' ? (
            <p className="field-note">
              Bu servis sadece ön kayıt oluşturur, takip no hemen dönmeyebilir.
            </p>
          ) : null}
          {form.surat.serviceMode === 'GONDERI_OLUSTUR_V2_EXPERIMENTAL' ? (
            <p className="drawer-error">
              Sürat GonderiOlusturV2 / Ortak Barkod REST API dokümanı eksik veya
              seçili endpoint doğrulanamadı. Canlı kullanım öncesi Sürat’ten güncel
              doküman ve yetki alınmalıdır.
            </p>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => onTestSurat(form)}
              disabled={busy}
            >
              <TestTube2 size={18} />
              Bağlantıyı Test Et
            </button>
          </div>
          <IntegrationResult result={suratTest} />
        </section>

        <div className="form-footer">
          <button type="submit" className="primary-button" disabled={busy}>
            <Save size={18} />
            Entegrasyonları Kaydet
          </button>
        </div>
      </form>
    </>
  )
}

function IntegrationResult({ result }: { result?: IntegrationTestResult }) {
  if (!result) return null

  return (
    <div className={result.ok ? 'integration-result ok' : 'integration-result fail'}>
      <strong>{result.ok ? 'Bağlantı başarılı' : 'Bağlantı hatalı'}</strong>
      <span>{result.message}</span>
      <span>Kaynak: {result.source === 'local' ? 'Yerel kayıt' : 'Gerçek API'}</span>
      {result.rawPreview ? (
        <details>
          <summary>Detayları göster</summary>
          <pre>{JSON.stringify(result.rawPreview, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  )
}
