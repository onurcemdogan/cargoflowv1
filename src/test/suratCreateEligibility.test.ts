import { describe, expect, it } from 'vitest'
import { resolveSuratCreateEligibility } from '../utils/suratCreateEligibility'
import { displayOrderNumber, sourceOrderNumber } from '../utils/orderDisplay'

// ÜRETİM ANOMALİSİ (2026-08-25): "Yeni Siparişler" 22 Ağustos siparişlerini
// gösteriyor ve "Sipariş No" alanında 727… takip numarası görünüyor.
// Bu paket iki şeyi kilitler: görünen değer OTORİTE DEĞİLDİR ve sekmede
// görünmek create adayı olmak DEMEK DEĞİLDİR.

const base = {
  orderNumber: '11529094251',
  packageId: '4096209239',
  cargoTrackingNumber: '7270036215917594',
  marketplaceStatus: 'Picking',
  operationStatus: 'NEW',
}

/* ═══ KİMLİK — GÖRÜNEN DEĞER OTORİTE DEĞİL ═══════════════════════════ */

describe('kimlik ayrimi', () => {
  it('gorunen "Siparis No" 727 takip numarasidir, siparis kimligi DEGIL', () => {
    const order = { ...base, shipment: undefined } as never
    // Gorunum bilerek 727'yi one alir (operatorun tanidigi kimlik).
    expect(displayOrderNumber(order)).toBe(base.cargoTrackingNumber)
    // Gercek siparis kimligi AYRI alanda kalir.
    expect(sourceOrderNumber(order)).toBe(base.orderNumber)
  })

  it('roller cakisirsa create UYGUN DEGILDIR', () => {
    // 727 hem takip hem siparis numarasi olarak gelirse WebSiparisKodu
    // yanlis olur ve dogrulama sessizce bosa cikar.
    const broken = resolveSuratCreateEligibility({
      order: { ...base, orderNumber: base.cargoTrackingNumber },
      createAttemptCount: 0,
    })
    expect(broken.eligible).toBe(false)
    expect(broken.reasons).toContain('IDENTITY_INCONSISTENT')
  })

  it('eksik kimlik create ACMAZ', () => {
    const missing = resolveSuratCreateEligibility({
      order: { ...base, cargoTrackingNumber: '' }, createAttemptCount: 0,
    })
    expect(missing.eligible).toBe(false)
    expect(missing.reasons).toContain('IDENTITY_INCOMPLETE')
  })
})

/* ═══ UYGUNLUK — SEKMEDE GÖRÜNMEK YETMEZ ════════════════════════════ */

describe('create uygunlugu', () => {
  it('temiz yeni paket UYGUNDUR', () => {
    const result = resolveSuratCreateEligibility({
      order: { ...base }, createAttemptCount: 0,
    })
    expect(result.eligible).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('onceki deneme varsa UYGUN DEGIL', () => {
    const result = resolveSuratCreateEligibility({
      order: { ...base }, createAttemptCount: 1,
    })
    expect(result.eligible).toBe(false)
    expect(result.reasons).toContain('PREVIOUS_CREATE_ATTEMPT_EXISTS')
  })

  it('tasiyici artefakti varsa UYGUN DEGIL', () => {
    for (const shipment of [
      { trackingNumber: '41176176501029' },
      { barcodeValue: 'Web00157962154' },
      { printZpl: '^XA^XZ' },
      { ozelKargoTakipNo: '7270036215917594' },
    ]) {
      const result = resolveSuratCreateEligibility({
        order: { ...base, shipment }, createAttemptCount: 0,
      })
      expect(result.eligible).toBe(false)
      expect(result.reasons).toContain('CARRIER_EVIDENCE_EXISTS')
    }
  })

  it('etiket zaten olustuysa UYGUN DEGIL', () => {
    const result = resolveSuratCreateEligibility({
      order: { ...base, operationStatus: 'LABEL_READY' }, createAttemptCount: 0,
    })
    expect(result.eligible).toBe(false)
    expect(result.reasons).toContain('LABEL_ALREADY_CREATED')
  })

  it('pazaryeri durumu uygun degilse create ACILMAZ', () => {
    for (const marketplaceStatus of ['Delivered', 'Cancelled', 'Shipped', '']) {
      const result = resolveSuratCreateEligibility({
        order: { ...base, marketplaceStatus }, createAttemptCount: 0,
      })
      expect(result.eligible).toBe(false)
      expect(result.reasons).toContain('MARKETPLACE_STATE_NOT_ELIGIBLE')
    }
  })

  it('BELIRSIZLIK uygunluk SAYILMAZ (fail closed)', () => {
    // Deneme sayisi bilinmiyorsa "0" VARSAYILMAZ.
    const unknown = resolveSuratCreateEligibility({
      order: { ...base }, createAttemptCount: Number.NaN,
    })
    expect(unknown.eligible).toBe(false)
    // Bos siparis nesnesi de asla uygun degildir.
    expect(resolveSuratCreateEligibility({ order: {} }).eligible).toBe(false)
  })
})
