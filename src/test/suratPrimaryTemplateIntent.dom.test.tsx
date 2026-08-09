import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { IntegrationsPage } from '../pages/IntegrationsPage'
import { defaultIntegrationConfig } from '../services/integrationConfigService'
import {
  DEFAULT_LABEL_PRINT_TEMPLATE,
  SURAT_TEMPLATE_FALLBACK_NOTICE,
  describeLabelPrintTemplate,
  resolveLabelPrintTemplateDecision,
} from '../utils/labelPrintTemplateRouting'
import type { CargoOrder, IntegrationConfig } from '../types/cargoflow'

// PRIMARY TEMPLATE INTENT — ÜRETİM HATASININ REGRESYONU.
//
// Üretimde ana "Kargo Etiketi Oluştur ve Yazdır" butonu ESKİ CargoFlow
// şablonunu açıyordu. Kök neden: override verilmediğinde karar organizasyon
// ayarına bırakılıyordu ve kayıtlı `cargoflow_html` tercihi ana butonu
// sessizce eziyordu. `DEFAULT_LABEL_PRINT_TEMPLATE`'i çevirmek TEK BAŞINA
// yetmiyordu — ayar her zaman varsayılanın önüne geçiyordu.
//
// Çözüm: NİYET AYRIMI.
//   intent 'primary'  → organizasyon ayarı OKUNMAZ, resmî Sürat kullanılır
//   intent 'advanced' → yalnız AÇIK seçim, yalnız o çalışma için
//
// Bu paket App.tsx'teki `resolveRunLabelTemplate` sözleşmesini birebir taklit
// eder: override yoksa 'primary', varsa 'advanced'.

/** App.tsx:resolveRunLabelTemplate ile AYNI sözleşme. */
function resolveRunLabelTemplate(
  organizationTemplate: unknown,
  runOrders: CargoOrder[],
  templateOverride?: 'cargoflow_html' | 'surat_official_zpl',
) {
  return resolveLabelPrintTemplateDecision({
    organizationTemplate,
    templateOverride,
    orders: runOrders,
    intent: templateOverride === undefined ? 'primary' : 'advanced',
  })
}

const order = (provider: string, id = 'o1'): CargoOrder =>
  ({ id, orderNumber: '1141234567890', shipment: { provider } }) as unknown as CargoOrder

const suratOrder = (id?: string) => order('surat', id)
const otherOrder = () => order('aras-kargo', 'o2')

describe('PRIMARY: ana aksiyon şablon niyeti', () => {
  test('PRIMARY-1: organizasyon ayarı cargoflow_html iken bile Sürat (ÜRETİM HATASI)', () => {
    const decision = resolveRunLabelTemplate('cargoflow_html', [suratOrder()])
    expect(decision.template).toBe('surat_official_zpl')
    expect(decision.overridden).toBe(false)
    expect(decision.fallbackApplied).toBe(false)
    expect(decision.blockedReason).toBeUndefined()
  })

  test('PRIMARY-2: organizasyon ayarı surat_official_zpl → Sürat', () => {
    expect(
      resolveRunLabelTemplate('surat_official_zpl', [suratOrder()]).template,
    ).toBe('surat_official_zpl')
  })

  test('PRIMARY-3: organizasyon ayarı YOK → Sürat', () => {
    expect(resolveRunLabelTemplate(undefined, [suratOrder()]).template).toBe(
      'surat_official_zpl',
    )
    expect(resolveRunLabelTemplate('bilinmeyen', [suratOrder()]).template).toBe(
      'surat_official_zpl',
    )
    expect(DEFAULT_LABEL_PRINT_TEMPLATE).toBe('surat_official_zpl')
  })

  test('PRIMARY-4: Gelişmiş açık cargoflow_html seçimi UYGULANIR', () => {
    const decision = resolveRunLabelTemplate(
      'surat_official_zpl',
      [suratOrder()],
      'cargoflow_html',
    )
    expect(decision.template).toBe('cargoflow_html')
    expect(decision.overridden).toBe(true)
  })

  test('PRIMARY-5: Gelişmiş CargoFlow baskısından SONRA ana aksiyon yine Sürat', () => {
    // Açık seçim KALICI tercih yazmaz; sonraki primary çağrı etkilenmez.
    const advanced = resolveRunLabelTemplate(
      'cargoflow_html',
      [suratOrder()],
      'cargoflow_html',
    )
    expect(advanced.template).toBe('cargoflow_html')
    const primaryAfter = resolveRunLabelTemplate('cargoflow_html', [suratOrder()])
    expect(primaryAfter.template).toBe('surat_official_zpl')
  })

  test('PRIMARY-6: Sürat DIŞI seçim Sürat şablonuna ZORLANMAZ', () => {
    const mixed = resolveRunLabelTemplate('cargoflow_html', [
      suratOrder(),
      otherOrder(),
    ])
    expect(mixed.template).toBe('cargoflow_html')
    expect(mixed.fallbackApplied).toBe(true)
    expect(mixed.notice).toBe(SURAT_TEMPLATE_FALLBACK_NOTICE)
    expect(mixed.blockedReason).toBeUndefined()

    // AÇIK Sürat seçimi uygulanamıyorsa mevcut BLOCK davranışı korunur.
    const explicit = resolveRunLabelTemplate(
      undefined,
      [suratOrder(), otherOrder()],
      'surat_official_zpl',
    )
    expect(explicit.blockedReason).toBeTruthy()
  })

  test('PRIMARY-7: TEKİL sipariş primary yolu da Sürat', () => {
    // App.tsx tekil akış (printTemplateDecision) AYNI resolveRunLabelTemplate
    // fonksiyonundan geçer; tek siparişlik çalışma da primary niyetlidir.
    expect(
      resolveRunLabelTemplate('cargoflow_html', [suratOrder('single')]).template,
    ).toBe('surat_official_zpl')
  })

  test('PRIMARY-8: TOPLU primary yolu da Sürat', () => {
    const bulk = [suratOrder('a'), suratOrder('b'), suratOrder('c')]
    expect(resolveRunLabelTemplate('cargoflow_html', bulk).template).toBe(
      'surat_official_zpl',
    )
  })

  test('PRIMARY-9: Ayarlar ekranında şablon seçicisi GÖSTERİLMEZ', () => {
    const config: IntegrationConfig = {
      ...defaultIntegrationConfig,
      desi: { defaultUnitDesi: 2, labelPrintTemplate: 'cargoflow_html' },
    } as IntegrationConfig
    render(
      <IntegrationsPage
        config={config}
        busy={false}
        onSave={vi.fn()}
        onTestTrendyol={vi.fn()}
        onTestSurat={vi.fn()}
        onFetchOrders={vi.fn()}
        onFetchProducts={vi.fn()}
      />,
    )
    expect(
      screen.queryByRole('group', { name: 'Kargo Etiketi Şablonu' }),
    ).toBeNull()
    expect(
      screen.queryByRole('radio', { name: /Etiket Şablonu/ }),
    ).toBeNull()
  })

  test('PRIMARY-10: araç çubuğu göstergesi primary davranışla ÇELİŞMEZ', () => {
    // Gösterge organizasyon ayarını DEĞİL, ana aksiyonun gerçekte kullanacağı
    // şablonu yazmalı. Aksi halde "Şablon: CargoFlow" yazarken Sürat basılırdı.
    expect(describeLabelPrintTemplate(DEFAULT_LABEL_PRINT_TEMPLATE)).toContain(
      'Sürat',
    )
    // İki metin AYIRT EDİLEBİLİR olmalı, yoksa iddia anlamsız kalırdı.
    expect(describeLabelPrintTemplate('cargoflow_html')).toContain('CargoFlow')

    // NOT: göstergenin App.tsx içinde HANGİ değerden türetildiği kaynak
    // düzeyinde ayrıca kilitlenir — bkz. CW-15
    // (server/surat-composer-wiring-flow.test.mjs). Node API gerektirdiği
    // için o iddia node:test tarafında durur.
  })
})
