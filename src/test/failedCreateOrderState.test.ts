import { describe, expect, it } from 'vitest'
import {
  classifyOrderForTabs, resolveDashboardOperationStage,
} from '../utils/orderClassification'
import type { CargoOrder } from '../types/cargoflow'

// BAŞARISIZ CREATE SONRASI SİPARİŞ DURUMU.
//
// 2026-08-18, paket 4085791254: Sürat HTTP 200 döndü ama takip/barkod/ZPL
// üretilmedi (CREATE_FAILED). Böyle bir sipariş listede ASLA başarılı kayıt
// ya da "sadece barkod bekleniyor" gibi görünmemelidir — operatör gönderinin
// oluştuğunu sanıp elle takip etmeyi bırakır.

const base = {
  id: 'o1', orderNumber: '11516641186', packageId: '4085791254',
  status: 'Created', marketplaceStatus: 'Picking',
  customerName: 'Ad Soyad', address: 'Adres', city: 'İstanbul',
  district: 'Kadıköy', desi: 2,
} as unknown as CargoOrder

const stageOf = (order: CargoOrder) =>
  resolveDashboardOperationStage(classifyOrderForTabs(order))

/** Başarı ya da "yolunda" izlenimi veren aşamalar. */
const SUCCESS_LIKE = ['labelReady', 'labelPrinted', 'handedToCargo', 'delivered']

describe('CREATE_FAILED siparis durumu', () => {
  const failedCases: Array<[string, CargoOrder]> = [
    ['shipment hic olusmadi + hata mesaji', {
      ...base, errorMessage: 'Sürat gönderisi oluşturulamadı.',
    } as CargoOrder],
    ['kabuk shipment: artefakt YOK', {
      ...base,
      shipment: { trackingNumber: '', barcodeValue: '', printZpl: '' },
    } as unknown as CargoOrder],
    ['operationStatus BARCODE_FAILED', {
      ...base, operationStatus: 'BARCODE_FAILED',
      shipment: { trackingNumber: '', barcodeValue: '' },
    } as unknown as CargoOrder],
  ]

  for (const [name, order] of failedCases) {
    it(`${name} → basarili kayit gibi GORUNMEZ`, () => {
      const stage = stageOf(order)
      expect(SUCCESS_LIKE).not.toContain(stage)
      const classification = classifyOrderForTabs(order)
      expect(classification.isLabelReady).toBe(false)
      expect(classification.isLabelPrinted).toBe(false)
      expect(classification.isHandedToCargo).toBe(false)
    })
  }

  it('BARCODE_FAILED "sadece barkod bekleniyor" DEMEK DEGILDIR', () => {
    const order = {
      ...base, operationStatus: 'BARCODE_FAILED',
      shipment: { trackingNumber: '', barcodeValue: '' },
    } as unknown as CargoOrder
    // hasError, isBarcodeWaiting'ten ONCE degerlendirilir; asama "error".
    expect(stageOf(order)).toBe('error')
    expect(classifyOrderForTabs(order).hasError).toBe(true)
  })

  it('gercek basarili etiket AYRISIR — kapi asiri genis degil', () => {
    const ok = {
      ...base, operationStatus: 'LABEL_READY',
      shipment: {
        trackingNumber: '7270036019076954', barcodeValue: 'BC1',
        printZpl: '^XA^XZ',
      },
    } as unknown as CargoOrder
    expect(SUCCESS_LIKE).toContain(stageOf(ok))
  })
})
