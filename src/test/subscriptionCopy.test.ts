import { expect, test } from 'vitest'
import {
  presentEntitlement,
  presentPlanHeadline,
  presentUsage,
} from '../subscription/entitlementCopy'

// ═══ BILLING-MODEL-UI-001 — DÜRÜST TİCARİ KOPYA ═════════════════════════
//
// Beş farklı "kapalı" nedeni, beş FARKLI mesaj almalıdır. Hepsini tek bir
// gri "kullanılamıyor" kutusuna çökertmek kullanıcıyı ya boş yere uğraştırır
// (desteklenmeyen özellik için plan yükseltmeye çalışır) ya da yanlış
// tahsilata yol açar (yayında olmayan özellik için ödeme yapar).

test('BILLC-1: bes farkli neden BES FARKLI mesaj ve ton uretir', () => {
  const cases = [
    ['ALLOWED', 'ok'],
    ['PLAN_REQUIRED', 'upgrade'],
    ['LIMIT_REACHED', 'upgrade'],
    ['CONNECTION_REQUIRED', 'fix'],
    ['ROLLOUT_DISABLED', 'wait'],
    ['UNSUPPORTED', 'unavailable'],
  ] as const
  const texts = new Set<string>()
  for (const [decision, tone] of cases) {
    const view = presentEntitlement({
      capability: 'labels.bulk_print',
      decision,
      reasonCode: decision,
      requiredPlanId: 'tier_standard',
    })
    expect(view.tone).toBe(tone)
    texts.add(view.text)
  }
  expect(texts.size).toBe(cases.length)
})

test('BILLC-2: DESTEKLENMEYEN ozellik icin "yukselt" GOSTERILMEZ', () => {
  const unsupported = presentEntitlement({
    capability: 'analytics.export',
    decision: 'UNSUPPORTED',
    reasonCode: 'CAPABILITY_NOT_SUPPORTED',
    requiredPlanId: null,
  })
  expect(unsupported.upgradeTarget).toBeNull()
  expect(unsupported.actionable).toBe(false)
  expect(unsupported.text).toBe('Bu özellik bu entegrasyonda desteklenmiyor.')
})

test('BILLC-3: YAYINDA OLMAYAN ozellik icin "yukselt" GOSTERILMEZ', () => {
  const pending = presentEntitlement({
    capability: 'labels.bulk_print',
    decision: 'ROLLOUT_DISABLED',
    reasonCode: 'ROLLOUT_NOT_ENABLED',
    requiredPlanId: null,
  })
  expect(pending.upgradeTarget).toBeNull()
  expect(pending.actionable).toBe(false)
  // Kullanicinin yapabilecegi bir sey YOK; beklemesi gerekiyor.
  expect(pending.tone).toBe('wait')
})

test('BILLC-4: yukseltme hedefi YOKSA "yukselt" DENMEZ', () => {
  const noTarget = presentEntitlement({
    capability: 'analytics.export',
    decision: 'PLAN_REQUIRED',
    reasonCode: 'CAPABILITY_NOT_IN_PLAN',
    requiredPlanId: null,
  })
  expect(noTarget.upgradeTarget).toBeNull()
  expect(noTarget.actionable).toBe(false)

  const withTarget = presentEntitlement({
    capability: 'analytics.export',
    decision: 'PLAN_REQUIRED',
    reasonCode: 'CAPABILITY_NOT_IN_PLAN',
    requiredPlanId: 'tier_advanced',
  })
  expect(withTarget.upgradeTarget).toBe('tier_advanced')
  expect(withTarget.actionable).toBe(true)
})

test('BILLC-5: BAGLANTI sorunu ile PLAN sorunu AYRI mesajdir', () => {
  const connection = presentEntitlement({
    capability: 'connections.marketplace',
    decision: 'CONNECTION_REQUIRED',
    reasonCode: 'CONNECTION_NOT_OPERATIONAL',
    requiredPlanId: null,
  })
  const plan = presentEntitlement({
    capability: 'connections.marketplace',
    decision: 'PLAN_REQUIRED',
    reasonCode: 'CAPABILITY_NOT_IN_PLAN',
    requiredPlanId: 'tier_standard',
  })
  expect(connection.text).toBe('Bağlantının yeniden doğrulanması gerekiyor.')
  expect(plan.text).toBe('Bu özellik mevcut planınıza dahil değil.')
  expect(connection.text).not.toBe(plan.text)
  expect(connection.upgradeTarget).toBeNull()
})

test('BILLC-6: legacy organizasyon "mevcut kullanimin korunuyor" der', () => {
  const legacy = presentPlanHeadline({ displayName: 'Mevcut Kullanım', legacy: true })
  expect(legacy.note).toBe('Mevcut kullanımınız korunuyor.')
  const paid = presentPlanHeadline({ displayName: 'Standart', legacy: false })
  expect(paid.note).toBeNull()
})

test('BILLC-7: OLCULEMEYEN kullanim SIFIR gibi gosterilmez', () => {
  expect(presentUsage({ metered: false, value: null })).toBe('Henüz ölçülmüyor')
  expect(presentUsage({ metered: true, value: 0 })).toBe('0')
  expect(presentUsage({ metered: true, value: 3 })).toBe('3')
  // "0" ile "bilinmiyor" ASLA ayni gorunmemeli.
  expect(presentUsage({ metered: false, value: null })).not.toBe(
    presentUsage({ metered: true, value: 0 }),
  )
})

test('BILLC-8: sunum katmani FIYAT UYDURMAZ', () => {
  const views = [
    presentEntitlement({
      capability: 'labels.bulk_print',
      decision: 'PLAN_REQUIRED',
      reasonCode: 'CAPABILITY_NOT_IN_PLAN',
      requiredPlanId: 'tier_standard',
    }),
    presentPlanHeadline({ displayName: 'Standart', legacy: false }),
  ]
  const serialized = JSON.stringify(views)
  for (const money of ['₺', 'TL', 'TRY', '$', '€', '/ay', 'aylık ']) {
    expect(serialized).not.toContain(money)
  }
})
