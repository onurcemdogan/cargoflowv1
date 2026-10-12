import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { integrationConfigService } from '../services/appServices'
import { stripIntegrationSecrets } from '../services/integrationConfigService'

// ═══ PHASE2-E — TARAYICIDA SIR YOK ═══════════════════════════════════════
// Sırlar (API anahtarı/secret, kargo şifreleri) localStorage/sessionStorage'a
// YAZILMAZ; eski sürümden kalanlar ilk okumada SİLİNİR.

const KEY = 'cargoflow.integrationConfig'
const SECRETS = /GIZLI-KEY|GIZLI-SECRET|GIZLI-SIFRE|GIZLI-WEB|GIZLI-LIVE|GIZLI-REST/

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function storageDump(): string {
  const entries: string[] = []
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index) as string
      entries.push(`${key}=${store.getItem(key)}`)
    }
  }
  return entries.join('\n')
}

test('SEC-1: eski sürümden kalan düz metin sırlar ilk okumada tarayıcıdan SİLİNİR', () => {
  window.localStorage.setItem(
    KEY,
    JSON.stringify({
      trendyol: { sellerId: '123', apiKey: 'GIZLI-KEY', apiSecret: 'GIZLI-SECRET' },
      surat: { kullaniciAdi: 'cari', sifre: 'GIZLI-SIFRE', webPassword: 'GIZLI-WEB', liveSifre: 'GIZLI-LIVE' },
    }),
  )
  const config = integrationConfigService.loadIntegrationConfig()
  expect(config.trendyol.sellerId).toBe('123')
  expect(config.trendyol.apiKey).toBe('')
  expect(storageDump()).not.toMatch(SECRETS)
  expect(storageDump()).toContain('123')
})

test('SEC-2: kaydetme tarayıcıya sır YAZMAZ; sır yalnız sunucuya gider', () => {
  const base = integrationConfigService.loadIntegrationConfig()
  integrationConfigService.saveIntegrationConfig({
    ...base,
    trendyol: { ...base.trendyol, sellerId: '456', apiKey: 'GIZLI-KEY', apiSecret: 'GIZLI-SECRET' },
    surat: { ...base.surat, kullaniciAdi: 'cari', sifre: 'GIZLI-SIFRE', webPassword: 'GIZLI-WEB' },
  })
  expect(storageDump()).not.toMatch(SECRETS)
  expect(storageDump()).toContain('456')
})

test('SEC-3: ad desenine göre ayıklama — bilinmeyen yeni şifre alanı da sızmaz', () => {
  const base = integrationConfigService.loadIntegrationConfig()
  const stripped = stripIntegrationSecrets({
    ...base,
    surat: { ...base.surat, restBasicPassword: 'GIZLI-REST', liveSifre: 'GIZLI-LIVE' } as typeof base.surat,
  })
  expect(JSON.stringify(stripped)).not.toMatch(SECRETS)
})
