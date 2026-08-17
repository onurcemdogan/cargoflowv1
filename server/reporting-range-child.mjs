// TZ bağımsızlık kanıtı için child runner: process TZ'si ne olursa olsun
// resolveReportingRange aynı UTC anlarını üretmelidir.
import { createServer } from 'vite'

const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  logLevel: 'silent',
  // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
  // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
  // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
  // "server is being restarted or closed" hatası verir. SSR-only test
  // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
  // tarama tamamen kapatılır.
  optimizeDeps: { noDiscovery: true, include: [] },
})
const { resolveReportingRange } = await vite.ssrLoadModule(
  '/src/dashboard/reportingRange.ts',
)
const now = new Date('2026-07-19T12:00:00.000Z')
const today = resolveReportingRange('today', now, 'UTC')
const yesterday = resolveReportingRange('yesterday', now, 'UTC')
const istToday = resolveReportingRange('today', now, 'Europe/Istanbul')
// TSİ gece senaryosu: 20.07 00:07 TSİ = 19.07 21:07 UTC → Bugün 20.07 UTC.
const midnight = new Date('2026-07-19T21:07:35.000Z')
const midnightToday = resolveReportingRange('today', midnight, 'UTC')
console.log(
  JSON.stringify({
    tz: process.env.TZ ?? null,
    todayStart: today.start.toISOString(),
    yesterdayStart: yesterday.start.toISOString(),
    istTodayStart: istToday.start.toISOString(),
    midnightTodayStart: midnightToday.start.toISOString(),
  }),
)
await vite.close()
process.exit(0)
