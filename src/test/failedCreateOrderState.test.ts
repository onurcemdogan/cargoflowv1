import { describe, expect, it } from 'vitest'
import {
  classifyOrderForTabs, resolveDashboardOperationStage,
} from '../utils/orderClassification'
import { resolveLabelWorkflowActivation } from '../utils/labelWorkflowActivation'
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

  // MİMARİ DEĞİŞİKLİK (kullanıcı etiket aktivasyonu): "gerçek başarılı etiket"
  // artık YALNIZ artefakt demek DEĞİLDİR. Arka plan worker'ı artefaktı önceden
  // hazırlayabilir; o sipariş kullanıcı için hâlâ "Barkod Bekliyor"dur. Bu
  // yüzden fixture'a AÇIK kullanıcı aktivasyon damgası eklendi ve testin
  // koruduğu ayrım GÜÇLENDİRİLDİ: aynı artefakt damgasız iken başarı-benzeri
  // aşamaya DÜŞMEMELİ. (Eski hâli yalnız "damgalı" tarafı ölçüyordu.)
  const readyArtifact = {
    trackingNumber: '7270036019076954', barcodeValue: 'BC1',
    printZpl: '^XA^XZ',
  }

  it('gercek basarili etiket AYRISIR — kapi asiri genis degil', () => {
    const ok = {
      ...base, operationStatus: 'LABEL_READY',
      userLabelActivatedAt: '2026-09-01T10:00:00.000Z',
      shipment: readyArtifact,
    } as unknown as CargoOrder
    expect(SUCCESS_LIKE).toContain(stageOf(ok))
  })

  it('AYNI artefakt kullanici aktivasyonu YOKKEN basari-benzeri DEGILDIR', () => {
    const preparedOnly = {
      ...base, operationStatus: 'LABEL_READY',
      shipment: readyArtifact,
    } as unknown as CargoOrder
    expect(SUCCESS_LIKE).not.toContain(stageOf(preparedOnly))
    expect(stageOf(preparedOnly)).toBe('barcodeWaiting')
    // Ayrımı yapan şey artefaktın varlığı DEĞİL, kullanıcı aktivasyonudur.
    expect(resolveLabelWorkflowActivation(preparedOnly).activated).toBe(false)
  })
})
