// Basit benchmark: analitik cache miss (ağır hesaplama simülasyonu) vs hit.
// Gerçek Trendyol çekimi statü × pencere × sayfalama nedeniyle saniyeler sürer;
// burada bir "ağır hesaplama" 120ms gecikmeyle taklit edilir. Amaç cache hit'in
// ve single-flight'ın sağladığı kazanımı somut göstermek.
//
// Çalıştırma:  node server/analytics-cache-bench.mjs
import { performance } from 'node:perf_hooks'
import { AnalyticsCache, buildAnalyticsCacheKey } from './cache/analyticsCache.ts'

const HEAVY_MS = 120
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let heavyCalls = 0
async function heavyCompute() {
  heavyCalls += 1
  await wait(HEAVY_MS) // Trendyol pencereli çekimini taklit eder
  return { total: 12345, orders: [] }
}

const cache = new AnalyticsCache({ maxEntries: 200, ttlMs: 5 * 60 * 1000 })
const key = buildAnalyticsCacheKey({
  resource: 'orders',
  tenantId: 'bench-org',
  startMs: 1000,
  endMs: 2000,
  timezone: 'Europe/Istanbul',
  filters: {},
})

function ms(x) {
  return `${x.toFixed(1)}ms`
}

// 1) İlk istek (cache miss) — ağır hesaplama.
let t = performance.now()
await cache.getOrCompute(key, heavyCompute)
const missMs = performance.now() - t

// 2) 100 ardışık cache hit.
t = performance.now()
for (let i = 0; i < 100; i += 1) await cache.getOrCompute(key, heavyCompute)
const hit100Ms = performance.now() - t

// 3) Single-flight: 50 EŞZAMANLI istek (cache temizlendikten sonra) tek hesaplama.
await cache.clear()
heavyCalls = 0
t = performance.now()
await Promise.all(Array.from({ length: 50 }, () => cache.getOrCompute(key, heavyCompute)))
const concurrentMs = performance.now() - t

console.log('--- Analytics cache benchmark ---')
console.log(`Ağır hesaplama gecikmesi (simülasyon): ${HEAVY_MS}ms`)
console.log(`1) İlk istek (miss)          : ${ms(missMs)}  (heavyCalls=1)`)
console.log(`2) 100 cache hit toplam      : ${ms(hit100Ms)}  (ortalama ${ms(hit100Ms / 100)}/istek)`)
console.log(`   -> hit, miss'e göre ~${Math.round(missMs / (hit100Ms / 100))}x hızlı`)
console.log(`3) 50 eşzamanlı istek (single-flight): ${ms(concurrentMs)}  (heavyCalls=${heavyCalls})`)
console.log(
  `   -> single-flight olmasa ~${ms(50 * HEAVY_MS)} ağır işlem gerekirdi (50 ayrı çekim).`,
)
