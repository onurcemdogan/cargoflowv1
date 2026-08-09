import { describe, expect, test } from 'vitest'

import {
  DEFAULT_LABEL_PRINT_TEMPLATE,
  LEGACY_LABEL_PRINT_TEMPLATE,
  SURAT_TEMPLATE_FALLBACK_NOTICE,
  isSuratShipmentOrder,
  normalizeLabelPrintTemplate,
  resolveLabelPrintTemplateDecision,
} from '../utils/labelPrintTemplateRouting'
import type { CargoOrder } from '../types/cargoflow'

// ANA AKSİYON VARSAYILANI — "Kargo Etiketi Oluştur ve Yazdır".
//
// Ana buton `resolveLabelPrintTemplateDecision`'ı override VERMEDEN çağırır;
// yani kullanıcıya şablon seçtirmeden organizasyon varsayılanını kullanır.
// Bu paket o varsayılanın Sürat olduğunu, taşıyıcı güvenliğinin BYPASS
// EDİLMEDİĞİNİ ve eski şablonun hâlâ erişilebilir olduğunu kilitler.
//
// Composer/fallback/invariant sistemine DOKUNULMAZ: UI yalnız mevcut doğru
// backend yolunu seçer (create → attachPrintZplArtifact → compose sözleşmesi
// → kalıcı artefakt → render).

const order = (overrides: Partial<CargoOrder> = {}): CargoOrder =>
  ({
    id: 'o1',
    orderNumber: '1141234567890',
    shipment: { provider: 'surat' },
    ...overrides,
  }) as CargoOrder

const suratOrder = () => order()
const otherCarrierOrder = () =>
  order({ id: 'o2', shipment: { provider: 'aras-kargo' } } as unknown as Partial<CargoOrder>)

describe('UI-DEFAULT: ana aksiyon şablon yönlendirmesi', () => {
  test('UI-DEFAULT-1: Sürat seçimi + ana buton → ek seçim İSTEMEDEN Sürat akışı', () => {
    // Ana buton override GÖNDERMEZ; organizasyon ayarı da yoksa varsayılan.
    const decision = resolveLabelPrintTemplateDecision({
      orders: [suratOrder()],
    })
    expect(decision.template).toBe('surat_official_zpl')
    expect(decision.overridden).toBe(false)
    expect(decision.fallbackApplied).toBe(false)
    // Kullanıcıya sorulacak/uyarılacak bir şey YOK: seçim ekranı gerekmez.
    expect(decision.notice).toBeUndefined()
    expect(decision.blockedReason).toBeUndefined()
    expect(DEFAULT_LABEL_PRINT_TEMPLATE).toBe('surat_official_zpl')
  })

  test('UI-DEFAULT-2: Gelişmiş İşlemler → eski şablon HÂLÂ seçilebilir', () => {
    const decision = resolveLabelPrintTemplateDecision({
      orders: [suratOrder()],
      templateOverride: LEGACY_LABEL_PRINT_TEMPLATE,
    })
    expect(decision.template).toBe('cargoflow_html')
    expect(decision.overridden).toBe(true)
    expect(decision.blockedReason).toBeUndefined()
    // Açık seçim varsayılan değişse bile SESSİZCE ezilmez.
    expect(normalizeLabelPrintTemplate('cargoflow_html')).toBe('cargoflow_html')
    expect(normalizeLabelPrintTemplate('surat_official_zpl')).toBe(
      'surat_official_zpl',
    )
    // Yalnız bilinmeyen/eksik değer varsayılana düşer.
    expect(normalizeLabelPrintTemplate(undefined)).toBe('surat_official_zpl')
    expect(normalizeLabelPrintTemplate('bilinmeyen')).toBe('surat_official_zpl')
  })

  test('UI-DEFAULT-3: Sürat DIŞI taşıyıcı Sürat şablonuna ZORLANMAZ', () => {
    expect(isSuratShipmentOrder(otherCarrierOrder())).toBe(false)
    // Varsayılan Sürat olsa bile: seçimde Sürat dışı gönderi varsa mevcut
    // CargoFlow davranışı korunur ve TEK kısa bilgi verilir.
    const decision = resolveLabelPrintTemplateDecision({
      orders: [suratOrder(), otherCarrierOrder()],
    })
    expect(decision.template).toBe('cargoflow_html')
    expect(decision.fallbackApplied).toBe(true)
    expect(decision.notice).toBe(SURAT_TEMPLATE_FALLBACK_NOTICE)
    // Baskı BLOKLANMAZ (kullanıcı açık seçim yapmadı).
    expect(decision.blockedReason).toBeUndefined()

    // Yalnız Sürat dışı gönderi olsa da aynı güvenli davranış.
    const onlyOther = resolveLabelPrintTemplateDecision({
      orders: [otherCarrierOrder()],
    })
    expect(onlyOther.template).toBe('cargoflow_html')
    expect(onlyOther.fallbackApplied).toBe(true)
  })

  test('UI-DEFAULT-4: AÇIK Sürat seçimi uygulanamıyorsa baskı BLOKLANIR', () => {
    // Mevcut sözleşme korunur: açık kullanıcı seçimi sessizce başka şablona
    // düşürülmez.
    const decision = resolveLabelPrintTemplateDecision({
      orders: [suratOrder(), otherCarrierOrder()],
      templateOverride: 'surat_official_zpl',
    })
    expect(decision.template).toBe('cargoflow_html')
    expect(decision.overridden).toBe(true)
    expect(decision.fallbackApplied).toBe(false)
    expect(decision.blockedReason).toBeTruthy()
  })

  test('UI-DEFAULT-5: organizasyon ayarı varsayılanı EZEBİLİR', () => {
    // Kayıtlı eski tercihi olan kurulumlar davranışlarını korur.
    const decision = resolveLabelPrintTemplateDecision({
      organizationTemplate: 'cargoflow_html',
      orders: [suratOrder()],
    })
    expect(decision.template).toBe('cargoflow_html')
    expect(decision.overridden).toBe(false)
  })
})
