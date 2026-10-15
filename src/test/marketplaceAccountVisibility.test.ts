import { expect, test } from 'vitest'
import { isCurrentMarketplaceAccount, marketplaceAccountLabel } from '../integrations/marketplaceAccountVisibility'

test('current Trendyol visibility requires literal true, tolerates stored provider casing, preserves other providers', () => {
  for (const marketplace of ['Trendyol', 'trendyol', ' TRENDYOL ']) {
    expect(isCurrentMarketplaceAccount({ marketplace, isActive: true })).toBe(true)
    for (const isActive of [false, null, undefined, 'true', 1]) {
      expect(isCurrentMarketplaceAccount({ marketplace, isActive })).toBe(false)
    }
  }
  for (const marketplace of ['n11', 'woocommerce', 'ikas', 'hepsiburada']) {
    expect(isCurrentMarketplaceAccount({ marketplace, isActive: false })).toBe(true)
  }
})

test('Trendyol account labels show provider once, retain real identity, and invent no store name', () => {
  for (const displayName of ['Trendyol • 222', 'Trendyol · 222', 'Trendyol · Trendyol • 222', '222']) {
    expect(marketplaceAccountLabel({ marketplace: 'Trendyol', displayName })).toBe('Trendyol · 222')
  }
  expect(marketplaceAccountLabel({ marketplace: 'trendyol', displayName: 'Gerçek Mağaza • 222' })).toBe('Trendyol · Gerçek Mağaza • 222')
  expect(marketplaceAccountLabel({ marketplace: 'Trendyol', displayName: null })).toBe('Trendyol')
  expect(marketplaceAccountLabel({ marketplace: 'Trendyol', displayName: null, providerAccountId: '222' })).toBe('Trendyol · 222')
  expect(marketplaceAccountLabel({ marketplace: 'Trendyol', displayName: 'Gerçek Mağaza', providerAccountId: '222' })).toBe('Trendyol · Gerçek Mağaza · 222')
  expect(marketplaceAccountLabel({ marketplace: 'Trendyol', displayName: 'Trendyol • 222', providerAccountId: '222' })).toBe('Trendyol · 222')
  expect(marketplaceAccountLabel({ marketplace: 'n11', displayName: 'n11 Mağaza' })).toBe('n11 · n11 Mağaza')
})
