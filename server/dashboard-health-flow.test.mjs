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
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
    // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
    // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
    // "server is being restarted or closed" hatası verir. SSR-only test
    // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
    // tarama tamamen kapatılır.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
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
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
    // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
    // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
    // "server is being restarted or closed" hatası verir. SSR-only test
    // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
    // tarama tamamen kapatılır.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
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
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
    // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
    // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
    // "server is being restarted or closed" hatası verir. SSR-only test
    // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
    // tarama tamamen kapatılır.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
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

/* ═══════════════════════════════════════════════════════════════════════
   PANO YAZICI GERÇEĞİ — SAKLANMIŞ AD "BAĞLI" YAPMAZ
   ═══════════════════════════════════════════════════════════════════════

   ÖLÇÜLEN KUSUR: pano yazıcı sağlığını

     printerSettings.mode !== 'download' && printerSettings.printerName

   ifadesinden türetiyordu. Linux bir API çalışma zamanında, kayıtlı bir
   yazıcı adı yüzünden SERVER_WINDOWS_RAW GERÇEKTEN kullanılamazken
   "bağlı / Windows RAW baskı" gösterilebiliyordu.                        */

const RAW_PRINTER_SETTINGS = {
  printerName: 'Zebra ZD220',
  mode: 'local-agent',
  labelSize: '100x100',
  defaultFormat: 'zpl',
}

test('PRINT-CAP-UI-1/4: Linux çalışma zamanında kayıtlı yazıcı adı BAĞLI ÜRETMEZ', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => vite.close())
  // GERÇEK PANO ÖZETİNDEN geçilir: yardımcıyı tek başına ölçmek, panonun
  // KENDİ kuralına geri dönmesini YAKALAMAZDI (ilk yazımda öyleydi;
  // mutasyon yalnız kaynak taramasını düşürdü).
  const { buildDashboardSummary } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardSummary.ts',
  )
  const { describeServerRawCapability } = await vite.ssrLoadModule(
    '/server/printing/printTransport.ts',
  )
  const summaryOf = (printerSettings, rawPrintCapability) =>
    buildDashboardSummary({
      orders: [],
      marketplaceIntegrations: [],
      carrierIntegrations: [],
      printerSettings,
      ...(rawPrintCapability === undefined ? {} : { rawPrintCapability }),
    }).printerHealth

  // ── PRINT-CAP-UI-1: platform=linux, printerName dolu, mode=local-agent ─
  const linuxCapability = describeServerRawCapability({
    platform: 'linux',
    printerName: RAW_PRINTER_SETTINGS.printerName,
  })
  assert.equal(linuxCapability.available, false)
  assert.equal(linuxCapability.reason, 'RUNTIME_NOT_WINDOWS')

  const linux = summaryOf(RAW_PRINTER_SETTINGS, linuxCapability)
  assert.notEqual(linux.status, 'connected', 'Linux çalışma zamanında BAĞLI DİYEMEZ')
  assert.match(linux.detail, /kullanılamıyor/)
  // "Windows RAW baskı" VAADİ KALKAR.
  assert.equal(/^Windows RAW baskı$/.test(linux.detail), false)

  // ── PRINT-CAP-UI-4: yetenek HİÇ okunamadıysa da BAĞLI DEĞİL ───────────
  const unknown = summaryOf(RAW_PRINTER_SETTINGS, undefined)
  assert.notEqual(unknown.status, 'connected', 'yalnız yazıcı adı BAĞLI üretemez')

  // ── KARŞIT KANIT: sunucu GERÇEKTEN uygun derse BAĞLI olur ─────────────
  const windows = summaryOf(
    RAW_PRINTER_SETTINGS,
    describeServerRawCapability({
      platform: 'win32',
      printerName: RAW_PRINTER_SETTINGS.printerName,
    }),
  )
  assert.equal(windows.status, 'connected')
  assert.equal(windows.detail, 'Windows RAW baskı')

  // ── PRINT-CAP-UI-5/6: tarayıcı ve indirme ETKİLENMEZ ─────────────────
  const browser = summaryOf({ ...RAW_PRINTER_SETTINGS, mode: 'browser-print' }, null)
  assert.equal(browser.status, 'connected')
  assert.match(browser.detail, /Chrome temiz etiket/)
  const download = summaryOf({ ...RAW_PRINTER_SETTINGS, mode: 'download' }, null)
  assert.equal(download.status, 'not_configured')
  assert.equal(download.detail, 'ZPL indirme modu')
})

test('PRINT-CAP-UI-DASH: pano KENDİ yazıcı kuralını KURMAZ', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => vite.close())
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(
    join(here, '..', 'src', 'dashboard', 'dashboardSummary.ts'),
    'utf8',
  )
  // İKİNCİ GERÇEK YOK: eski türetme geri gelemez.
  assert.equal(
    /mode !== 'download' && printerSettings\.printerName/.test(source),
    false,
    'pano yazıcı durumunu yazıcı adından türetmemeli',
  )
  assert.match(source, /resolvePrinterHealth\(printerSettings, rawPrintCapability\)/)
})
