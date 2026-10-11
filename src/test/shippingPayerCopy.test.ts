import { expect, test } from 'vitest'
import {
  buildPayerField,
  presentResolvedPayer,
  PAYER_OPTIONS,
  PAYER_QUESTION,
} from '../shipping/shippingPayerCopy'

// ═══ KARGO ÖDEYENİ — DÜRÜST UI ══════════════════════════════════════════
//
// En tehlikeli UI hatası, taşıyıcıya bakıp ödeyeni ÖN SEÇMEKTİR. Operatör
// onaylayıp geçer ve yanlış cariye fatura kesilir.

test('BPC-1: hicbir secenek OTOMATIK secili gelmez', () => {
  const field = buildPayerField({ evidenceClass: 'ACCOUNT_CONFIG_REQUIRED' })
  expect(field.selected).toBe('UNKNOWN')
  expect(field.question).toBe(PAYER_QUESTION)
  expect(PAYER_OPTIONS.map((o) => o.value)).toEqual([
    'MARKETPLACE_PAYS',
    'SELLER_PAYS',
    'UNKNOWN',
  ])
  expect(PAYER_OPTIONS.map((o) => o.label)).toEqual([
    'Pazaryeri ödüyor',
    'Satıcı ödüyor',
    'Bilinmiyor / seçilmedi',
  ])
})

test('BPC-2: siparisten turetilebilen pazaryerinde alan SORULMAZ', () => {
  const trendyol = buildPayerField({ evidenceClass: 'CAN_DERIVE_FROM_ORDER' })
  expect(trendyol.visible).toBe(false)
  expect(trendyol.blocksRouting).toBe(false)
  expect(trendyol.reasonText).toContain('siparişin kendisinden')

  const n11 = buildPayerField({ evidenceClass: 'ACCOUNT_CONFIG_REQUIRED' })
  expect(n11.visible).toBe(true)
  expect(n11.reasonText).toContain('doğrulanamıyor')
})

test('BPC-3: SECILMEDIYSE odeyen kesinligi gerektiren akis ACILMAZ', () => {
  const unset = buildPayerField({ evidenceClass: 'ACCOUNT_CONFIG_REQUIRED' })
  expect(unset.blocksRouting).toBe(true)
  const set = buildPayerField({
    evidenceClass: 'ACCOUNT_CONFIG_REQUIRED',
    currentValue: 'SELLER_PAYS',
  })
  expect(set.blocksRouting).toBe(false)
  expect(set.selected).toBe('SELLER_PAYS')
})

test('BPC-4: yardim metni GELECEK OZELLIK vaadi ICERMEZ', () => {
  const field = buildPayerField({ evidenceClass: 'ACCOUNT_CONFIG_REQUIRED' })
  expect(field.helpText).toBe(
    'Etiket ve kargo oluşturma yöntemi bu sözleşme tipine göre değişebilir.',
  )
  const serialized = JSON.stringify(field)
  for (const promise of ['Aras', 'yakında', 'yakinda', 'çok yakında', 'gelecek sürüm']) {
    expect(serialized).not.toContain(promise)
  }
})

test('BPC-5: cozumlenen odeyen KAYNAGIYLA birlikte gosterilir', () => {
  expect(presentResolvedPayer({ payer: 'MARKETPLACE_PAYS', provenance: 'ORDER_CONTRACT' })).toEqual(
    { text: 'Pazaryeri ödüyor', sourceText: 'Sipariş verisinden' },
  )
  expect(presentResolvedPayer({ payer: 'SELLER_PAYS', provenance: 'ACCOUNT_CONFIG' })).toEqual({
    text: 'Satıcı ödüyor',
    sourceText: 'Hesap ayarından',
  })
  expect(presentResolvedPayer({ payer: 'UNKNOWN', provenance: 'UNKNOWN' })).toEqual({
    text: 'Bilinmiyor',
    sourceText: 'Kaynak yok',
  })
})

test('BPC-6: sunum katmani ABONELIK kavramlarini TASIMAZ', () => {
  const field = JSON.stringify(buildPayerField({ evidenceClass: 'ACCOUNT_CONFIG_REQUIRED' }))
  for (const subscription of ['plan', 'tier_', 'entitlement', 'PLAN_REQUIRED', 'abonelik']) {
    expect(field.toLowerCase()).not.toContain(subscription.toLowerCase())
  }
})
