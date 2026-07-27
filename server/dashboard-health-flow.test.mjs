import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// Dashboard provider health reload regresyonu: sayfa yenilemesinden sonra güvenlik
// gereği ham apiKey/apiSecret/sifre frontend'e DÖNMEZ. Dashboard "configured"
// kararını ham secret alanlarından DEĞİL, backend maskeli metadata'sından vermeli.
// Aksi hâlde kayıtlı entegrasyon "Pazaryeri bağlantısı bulunamadı" gösterir.

function emptyConfig() {
  return {
    trendyol: { sellerId: '', apiKey: '', apiSecret: '', environment: 'prod', userAgentName: 'CargoFlow' },
    surat: { kullaniciAdi: '', sifre: '', webPassword: '', firmaId: '', ortam: 'live' },
  }
}

test('dashboard provider health: masked metadata\'dan configured türetir (reload regresyonu)', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { resolveTrendyolConfigured, resolveSuratConfigured } = await vite.ssrLoadModule(
    '/src/utils/integrationConfigured.ts',
  )
  const { buildDashboardProviderHealth } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardSummary.ts',
  )

  // (1-4) Trendyol kayıtlı; reload sonrası ham apiKey/apiSecret BOŞ; maskedStatus.configured=true.
  const reloadMasked = {
    mode: 'auth',
    configured: true,
    trendyol: { configured: true, sellerId: '696196', hasApiKey: true, hasApiSecret: true, apiKeyMasked: '••••1234' },
    surat: { configured: false, customerCode: '', usernameMasked: '' },
  }
  assert.equal(
    resolveTrendyolConfigured(reloadMasked, emptyConfig()),
    true,
    'ham secret boş olsa da maskeli metadata ile configured',
  )

  // (5) Dashboard "bağlantı bulunamadı" göstermez: marketplace configured=true.
  const health = buildDashboardProviderHealth({
    config: emptyConfig(),
    maskedStatus: reloadMasked,
    apiDebugLogs: [],
    orders: [],
    lastSyncedAt: undefined,
  })
  const trendyol = health.marketplaceIntegrations.find((p) => p.providerKey === 'trendyol')
  assert.equal(trendyol.configured, true)
  assert.notEqual(trendyol.status, 'not_configured', 'not_configured DEĞİL → "bağlantı bulunamadı" gösterilmez')
  // Son gerçek test kanıtı yok → connected değil, "kontrol edilmeli" (needs_check).
  assert.equal(trendyol.connected, false)
  assert.equal(trendyol.status, 'needs_check')

  // (9) configured=true ve son sync başarılı (lastSyncedAt) → connected.
  const connectedHealth = buildDashboardProviderHealth({
    config: emptyConfig(),
    maskedStatus: reloadMasked,
    apiDebugLogs: [],
    orders: [],
    lastSyncedAt: '2026-07-26T10:00:00.000Z',
  })
  const t2 = connectedHealth.marketplaceIntegrations.find((p) => p.providerKey === 'trendyol')
  assert.equal(t2.connected, true)
  assert.equal(t2.status, 'connected')

  // (9b) configured=true ama son test ERROR → status 'error' (kontrol gerekli), configured korunur.
  const erroredHealth = buildDashboardProviderHealth({
    config: emptyConfig(),
    maskedStatus: reloadMasked,
    apiDebugLogs: [{ provider: 'Trendyol', status: 'ERROR', timestamp: '2026-07-26T10:00:00.000Z' }],
    orders: [],
    lastSyncedAt: undefined,
  })
  const t3 = erroredHealth.marketplaceIntegrations.find((p) => p.providerKey === 'trendyol')
  assert.equal(t3.configured, true)
  assert.equal(t3.connected, false)
  assert.notEqual(t3.status, 'not_configured')
})

test('Sürat configured: FirmaId ZORUNLU değil; kullaniciAdi/cariKod + (sifre|webPassword) yeterli', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { resolveSuratConfigured } = await vite.ssrLoadModule('/src/utils/integrationConfigured.ts')
  const { buildDashboardProviderHealth } = await vite.ssrLoadModule('/src/dashboard/dashboardSummary.ts')

  // (6-8) maskedStatus.surat: customerCode dolu, hasPassword=true, firmaId BOŞ.
  const masked = {
    mode: 'auth',
    configured: true,
    trendyol: { configured: false, sellerId: '', apiKeyMasked: '' },
    surat: { configured: true, customerCode: '1551267127', cariKod: '1551267127', firmaId: '', hasPassword: true, hasWebPassword: false, usernameMasked: '••••7127' },
  }
  assert.equal(resolveSuratConfigured(masked, emptyConfig()), true, 'firmaId olmadan configured')

  // Legacy (maskedStatus yok): yalnız kullaniciAdi + webPassword (sifre yok, firmaId yok) → configured.
  const legacyConfig = {
    trendyol: { sellerId: '', apiKey: '', apiSecret: '' },
    surat: { kullaniciAdi: '1551267127', sifre: '', webPassword: 'WEB', firmaId: '' },
  }
  assert.equal(resolveSuratConfigured(null, legacyConfig), true, 'legacy: webPassword fallback + firmaId opsiyonel')

  const health = buildDashboardProviderHealth({
    config: emptyConfig(),
    maskedStatus: masked,
    apiDebugLogs: [],
    orders: [],
  })
  const surat = health.carrierIntegrations.find((p) => p.providerKey === 'surat')
  assert.equal(surat.configured, true)
  assert.notEqual(surat.status, 'not_configured')
})

test('Hiç credential yok → not_configured ("bağlantı bulunamadı" doğru gösterilir)', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { buildDashboardProviderHealth } = await vite.ssrLoadModule('/src/dashboard/dashboardSummary.ts')
  const health = buildDashboardProviderHealth({
    config: emptyConfig(),
    maskedStatus: null,
    apiDebugLogs: [],
    orders: [],
  })
  const trendyol = health.marketplaceIntegrations.find((p) => p.providerKey === 'trendyol')
  assert.equal(trendyol.configured, false)
  assert.equal(trendyol.status, 'not_configured')
})
