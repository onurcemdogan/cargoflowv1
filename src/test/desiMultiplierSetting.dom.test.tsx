import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { IntegrationsPage } from '../pages/IntegrationsPage'
import { defaultIntegrationConfig } from '../services/integrationConfigService'
import type { IntegrationConfig } from '../types/cargoflow'

// GERÇEK DOM + GERÇEK KULLANICI TIKLAMASI (jsdom + user-event).
//
// Gönderi varsayılanları (varsayılan desi + "Ürün adedine göre desiyi çarp")
// SAĞLAYICIDAN BAĞIMSIZ ortak bölümdedir: hiçbir kargo kartının veya kargo
// firması sekmesinin çocuğu DEĞİLDİR. Bu dosya o konumu sabitler.
// Tüm veriler SENTETİKTİR (secret/PII yok).

const SHARED_SECTION = 'Kargo ve Etiket Varsayılanları'
const TOGGLE_NAME = /Ürün adedine göre desiyi çarp/

function makeConfig(over: Partial<NonNullable<IntegrationConfig['desi']>> = {}) {
  return {
    ...defaultIntegrationConfig,
    desi: { ...defaultIntegrationConfig.desi!, defaultUnitDesi: 2, ...over },
  } as IntegrationConfig
}

// Sürat hesabı HİÇ tanımlı değil (müşteri kodu, şifre, firma yok).
function makeConfigWithoutCarrierAccount() {
  const config = makeConfig()
  return {
    ...config,
    surat: {
      ...config.surat,
      kullaniciAdi: '',
      sifre: '',
      webPassword: '',
      firmaId: '',
    },
  } as IntegrationConfig
}

function renderPage(config: IntegrationConfig, busy = false) {
  const onSave = vi.fn()
  render(
    <IntegrationsPage
      config={config}
      busy={busy}
      onSave={onSave}
      onTestTrendyol={vi.fn()}
      onTestSurat={vi.fn()}
      onFetchOrders={vi.fn()}
      onFetchProducts={vi.fn()}
    />,
  )
  return { onSave }
}

function sharedSection() {
  return screen.getByRole('region', { name: SHARED_SECTION })
}
function toggle() {
  return screen.getByRole('switch', { name: TOGGLE_NAME }) as HTMLInputElement
}
function saveDefaults() {
  return screen.getByRole('button', { name: 'Varsayılanları Kaydet' })
}

// ── 1-2: konum ve sağlayıcı bağımsızlığı ───────────────────────────────────

test('UI-1: anahtar Sürat ayar panelinin İÇİNDE DEĞİLDİR', async () => {
  const user = userEvent.setup()
  renderPage(makeConfig())
  await user.click(screen.getByRole('button', { name: /Kargo Firmaları/ }))
  await user.click(screen.getByRole('button', { name: 'Ayarlar' }))

  const carrierPanel = screen.getByRole('region', {
    name: 'Sürat Kargo ayarları',
  })
  expect(within(carrierPanel).queryByRole('switch', { name: TOGGLE_NAME })).toBe(
    null,
  )
  // Sürat paneli açıkken bile anahtar sayfada mevcuttur (ortak bölümde).
  expect(sharedSection().contains(toggle())).toBe(true)
  expect(carrierPanel.contains(toggle())).toBe(false)
})

test('UI-2: en yakın bölüm başlığında sağlayıcı adı YOKTUR', () => {
  renderPage(makeConfig())
  const section = toggle().closest('section')
  expect(section).not.toBe(null)
  const heading = within(section as HTMLElement).getByRole('heading', {
    level: 3,
  })
  expect(heading.textContent).toBe(SHARED_SECTION)
  expect(/sürat|surat|zebra|yurtiçi|aras|mng/i.test(heading.textContent ?? '')).toBe(
    false,
  )
})

// ── 3-5: erişilebilirlik ve ortak yerleşim ─────────────────────────────────

test('UI-3: Sürat hesabı tanımlı OLMAYAN yapılandırmada anahtar görünür', () => {
  renderPage(makeConfigWithoutCarrierAccount())
  expect(toggle().checked).toBe(true)
  expect(saveDefaults()).toBeTruthy()
})

test('UI-4: başka sağlayıcı (Trendyol) sekmesi seçiliyken anahtar KAYBOLMAZ', async () => {
  const user = userEvent.setup()
  renderPage(makeConfig())
  await user.click(screen.getByRole('button', { name: /Pazaryerleri/ }))
  await user.click(screen.getByRole('button', { name: 'Ayarlar' }))
  expect(
    screen.getByRole('region', { name: 'Trendyol ayarları' }),
  ).toBeTruthy()
  expect(sharedSection().contains(toggle())).toBe(true)

  // Kargo firmaları dışındaki boş kategoride de görünür.
  await user.click(screen.getByRole('button', { name: /Fatura Entegratörleri/ }))
  expect(sharedSection().contains(toggle())).toBe(true)
})

test('UI-5: varsayılan desi ile AYNI ortak bölümde yer alır', () => {
  renderPage(makeConfig())
  const section = sharedSection()
  const desiInput = within(section).getByLabelText(/Varsayılan Gönderi Desisi/)
  expect((desiInput as HTMLInputElement).value).toBe('2')
  expect(section.contains(toggle())).toBe(true)
})

// ── 6-8: kaydetme davranışı ────────────────────────────────────────────────

test('UI-6: false değeri kaydedilir', async () => {
  const user = userEvent.setup()
  const { onSave } = renderPage(makeConfig())
  await user.click(toggle())
  expect(toggle().checked).toBe(false)
  await user.click(saveDefaults())
  expect(onSave).toHaveBeenCalledTimes(1)
  const saved = onSave.mock.calls[0][0] as IntegrationConfig
  expect(saved.desi?.multiplyByItemQuantity).toBe(false)
})

test('UI-7: true değeri kaydedilir', async () => {
  const user = userEvent.setup()
  const { onSave } = renderPage(makeConfig({ multiplyByItemQuantity: false }))
  expect(toggle().checked).toBe(false)
  await user.click(toggle())
  expect(toggle().checked).toBe(true)
  await user.click(saveDefaults())
  const saved = onSave.mock.calls[0][0] as IntegrationConfig
  expect(saved.desi?.multiplyByItemQuantity).toBe(true)
})

test('UI-8: kayıt payload şekli DEĞİŞMEZ (yalnız desi.multiplyByItemQuantity)', async () => {
  const user = userEvent.setup()
  const config = makeConfig()
  const { onSave } = renderPage(config)
  await user.click(toggle())
  await user.click(saveDefaults())
  const saved = onSave.mock.calls[0][0] as IntegrationConfig

  expect(Object.keys(saved).sort()).toEqual(Object.keys(config).sort())
  expect(saved.trendyol).toEqual(config.trendyol)
  expect(saved.desi?.defaultUnitDesi).toBe(2)
  expect(saved.desi?.categoryDefaults).toEqual(config.desi?.categoryDefaults)
  expect(saved.desi?.productOverrides).toEqual(config.desi?.productOverrides)
  expect(saved.desi?.variantOverrides).toEqual(config.desi?.variantOverrides)
  // Sürat bloğu bu bölümden DOKUNULMAZ (serviceMode/rota alanları hariç
  // sayfanın kendi normalizasyonu; kimlik alanları aynen kalır).
  expect(saved.surat.kullaniciAdi).toBe(config.surat.kullaniciAdi)
  expect(saved.surat.firmaId).toBe(config.surat.firmaId)
})

// ── 9-12: metin, klavye, busy, sağlayıcı adı ───────────────────────────────

test('UI-9: klavye ile (Tab + Space) çalışır', async () => {
  const user = userEvent.setup()
  const { onSave } = renderPage(makeConfig())
  toggle().focus()
  expect(document.activeElement).toBe(toggle())
  await user.keyboard(' ')
  expect(toggle().checked).toBe(false)
  // GÜNCELLENDİ (gerekçe): ortak bölüme "Kargo Etiketi Şablonu" seçimi
  // eklendiği için anahtar ile Kaydet arasında artık bir radyo grubu (tek
  // sekme durağı) vardır. Test ZAYIFLATILMADI: hâlâ YALNIZ klavyeyle Kaydet'e
  // ulaşılıp Enter ile kaydedildiği doğrulanır; sabit tek Tab varsayımı yerine
  // gerçek odak sırası izlenir.
  for (let step = 0; step < 6; step += 1) {
    if (document.activeElement === saveDefaults()) break
    await user.tab()
  }
  expect(document.activeElement).toBe(saveDefaults())
  await user.keyboard('{Enter}')
  const saved = onSave.mock.calls[0]?.[0] as IntegrationConfig | undefined
  expect(saved?.desi?.multiplyByItemQuantity).toBe(false)
})

test('UI-10: busy sırasında anahtar ve kaydet devre dışıdır', async () => {
  const user = userEvent.setup()
  const { onSave } = renderPage(makeConfig(), true)
  expect(toggle().disabled).toBe(true)
  expect((saveDefaults() as HTMLButtonElement).disabled).toBe(true)
  await user.click(toggle())
  expect(toggle().checked).toBe(true)
  expect(onSave).not.toHaveBeenCalled()
})

test('UI-11: desi ayarı ve bölüm başlığı sağlayıcı adı İÇERMEZ', () => {
  renderPage(makeConfig())
  const section = sharedSection()
  const text = section.textContent ?? ''
  // GÜNCELLENDİ (gerekçe): bölüm artık "Kargo Etiketi Şablonu" seçimini de
  // barındırıyor ve seçeneklerden BİRİNİN adı gereği "Resmî Sürat Etiket
  // Şablonu"dur — bu, sağlayıcıya bağımlılık değil, seçeneğin KENDİ adıdır.
  // Kural ZAYIFLATILMADI, DARALTILDI: bölüm başlığı ve desi ayarı hâlâ
  // sağlayıcıdan bağımsızdır ve "Sürat" YALNIZ şablon seçeneği içinde geçebilir.
  expect(section.getAttribute('aria-label')).toBe(SHARED_SECTION)
  expect(/sürat|surat/i.test(SHARED_SECTION)).toBe(false)
  const templateGroup = within(section).getByRole('group', {
    name: 'Kargo Etiketi Şablonu',
  })
  const withoutTemplateGroup = text.replace(
    templateGroup.textContent ?? '',
    '',
  )
  expect(/sürat|surat/i.test(withoutTemplateGroup)).toBe(false)
  expect(text).toContain('Ürün adedine göre desiyi çarp')
  expect(text).toContain(
    'Açık olduğunda varsayılan gönderi desisi siparişteki toplam ürün adediyle çarpılır.',
  )
  expect(text).toContain(
    'Kapalı olduğunda paket için varsayılan desi yalnız bir kez kullanılır.',
  )
})

test('UI-12: örnek metin gerçek helper çıktısını gösterir', () => {
  renderPage(makeConfig())
  const example = within(sharedSection()).getByText(/Örnek — varsayılan/)
  // defaultUnitDesi=2, 2 adet: açık 4, kapalı 2 (calculateOrderDesi çıktısı).
  expect(example.textContent).toContain('açık → 4 desi')
  expect(example.textContent).toContain('kapalı → 2 desi')
})
