// TZ bağımsızlık kanıtı için child runner: process TZ'si ne olursa olsun
// resolveReportingRange aynı UTC anlarını üretmelidir.
import { createServer } from 'vite'

const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  logLevel: 'silent',
})
const { resolveReportingRange } = await vite.ssrLoadModule(
  '/src/dashboard/reportingRange.ts',
)
const now = new Date('2026-07-19T12:00:00.000Z')
const today = resolveReportingRange('today', now, 'UTC')
const yesterday = resolveReportingRange('yesterday', now, 'UTC')
const istToday = resolveReportingRange('today', now, 'Europe/Istanbul')
console.log(
  JSON.stringify({
    tz: process.env.TZ ?? null,
    todayStart: today.start.toISOString(),
    yesterdayStart: yesterday.start.toISOString(),
    istTodayStart: istToday.start.toISOString(),
  }),
)
await vite.close()
process.exit(0)
