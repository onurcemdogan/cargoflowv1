import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { IntegrationsPage } from '../pages/IntegrationsPage'
import { defaultIntegrationConfig } from '../services/integrationConfigService'
import type { IntegrationConfig } from '../types/cargoflow'

// GERÇEK DOM + GERÇEK KULLANICI TIKLAMASI (jsdom + user-event).
// "Ürün adedine göre desiyi çarp" organizasyon ayarının Ayarlar ekranındaki
// davranışını sabitler. Tüm veriler SENTETİKTİR (secret/PII yok).

function makeConfig(over: Partial<IntegrationConfig['desi']> = {}) {
  return {
    ...defaultIntegrationConfig,
    desi: { ...defaultIntegrationConfig.desi!, defaultUnitDesi: 2, ...over },
  } as IntegrationConfig
}

async function openLabelTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Kargo Firmaları/ }))
  // Kargo firmaları kategorisinde tek kart (Sürat) vardır; "Ayarlar" o kartın
  // ayrıntı panelini açar.
  await user.click(screen.getByRole('button', { name: 'Ayarlar' }))
  await user.click(screen.getByRole('button', { name: 'Etiket' }))
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

test('DOM-DM-1: anahtar Etiket sekmesinde görünür ve varsayılan AÇIKTIR', async () => {
  const user = userEvent.setup()
  renderPage(makeConfig())
  await openLabelTab(user)
  const toggle = screen.getByRole('switch', {
    name: /Ürün adedine göre desiyi çarp/,
  })
  expect(toggle).toBeTruthy()
  expect((toggle as HTMLInputElement).checked).toBe(true)
})

test('DOM-DM-2: ayar hiç kaydedilmemişse (alan yok) anahtar yine AÇIK görünür', async () => {
  const user = userEvent.setup()
  const config = makeConfig()
  delete (config.desi as unknown as Record<string, unknown>)
    .multiplyByItemQuantity
  renderPage(config)
  await openLabelTab(user)
  const toggle = screen.getByRole('switch', {
    name: /Ürün adedine göre desiyi çarp/,
  }) as HTMLInputElement
  expect(toggle.checked).toBe(true)
})

test('DOM-DM-3: kayıtlı false değeri KAPALI olarak gösterilir', async () => {
  const user = userEvent.setup()
  renderPage(makeConfig({ multiplyByItemQuantity: false }))
  await openLabelTab(user)
  const toggle = screen.getByRole('switch', {
    name: /Ürün adedine göre desiyi çarp/,
  }) as HTMLInputElement
  expect(toggle.checked).toBe(false)
})

test('DOM-DM-4: tıklama anahtarı kapatır ve Kaydet ayarı false gönderir', async () => {
  const user = userEvent.setup()
  const { onSave } = renderPage(makeConfig())
  await openLabelTab(user)
  const toggle = screen.getByRole('switch', {
    name: /Ürün adedine göre desiyi çarp/,
  }) as HTMLInputElement
  await user.click(toggle)
  expect(toggle.checked).toBe(false)

  await user.click(screen.getByRole('button', { name: 'Kaydet' }))
  expect(onSave).toHaveBeenCalledTimes(1)
  const saved = onSave.mock.calls[0][0] as IntegrationConfig
  expect(saved.desi?.multiplyByItemQuantity).toBe(false)
  // Varsayılan birim desi DEĞİŞMEZ.
  expect(saved.desi?.defaultUnitDesi).toBe(2)
})

test('DOM-DM-5: tekrar tıklama ayarı yeniden AÇAR', async () => {
  const user = userEvent.setup()
  const { onSave } = renderPage(makeConfig({ multiplyByItemQuantity: false }))
  await openLabelTab(user)
  const toggle = screen.getByRole('switch', {
    name: /Ürün adedine göre desiyi çarp/,
  }) as HTMLInputElement
  await user.click(toggle)
  expect(toggle.checked).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Kaydet' }))
  const saved = onSave.mock.calls[0][0] as IntegrationConfig
  expect(saved.desi?.multiplyByItemQuantity).toBe(true)
})

test('DOM-DM-6: kayıt sürerken anahtar devre dışıdır ve tıklama sonucu DEĞİŞTİRMEZ', async () => {
  const user = userEvent.setup()
  renderPage(makeConfig(), true)
  await openLabelTab(user)
  const toggle = screen.getByRole('switch', {
    name: /Ürün adedine göre desiyi çarp/,
  }) as HTMLInputElement
  expect(toggle.disabled).toBe(true)
  await user.click(toggle)
  expect(toggle.checked).toBe(true)
})

test('DOM-DM-7: ekrandaki örnek gerçek hesaptan gelen açık/kapalı değerleri gösterir', async () => {
  const user = userEvent.setup()
  renderPage(makeConfig())
  await openLabelTab(user)
  const example = screen.getByText(/Örnek — varsayılan/)
  // defaultUnitDesi=2, 2 adet: açık 4, kapalı 2 (calculateOrderDesi çıktısı).
  expect(example.textContent).toContain('açık → 4 desi')
  expect(example.textContent).toContain('kapalı → 2 desi')
})
