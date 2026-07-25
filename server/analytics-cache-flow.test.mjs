import assert from 'node:assert/strict'
import test from 'node:test'

// Satış analitiği cache'i (bounded LRU + TTL + single-flight + tenant key)
// regresyon/performans testleri (1-10). Cache modülü saftır (DB gerekmez); saat
// enjekte edilerek TTL deterministik test edilir.
const {
  AnalyticsCache,
  buildAnalyticsCacheKey,
  sanitizeAnalyticsOrder,
  sanitizeAnalyticsOrders,
  ANALYTICS_REPORT_VERSION,
} = await import('./cache/analyticsCache.ts')

function makeClock(start = 1000) {
  const state = { t: start }
  return { now: () => state.t, advance: (ms) => (state.t += ms) }
}

const key = (over = {}) =>
  buildAnalyticsCacheKey({
    resource: 'orders',
    tenantId: 'org-1',
    startMs: 1000,
    endMs: 2000,
    timezone: 'Europe/Istanbul',
    filters: {},
    ...over,
  })

test('1 & 10) İlk istek hesaplar; cache hit ağır hesaplamayı TEKRAR çağırmaz', async () => {
  const cache = new AnalyticsCache({ maxEntries: 10, ttlMs: 60_000 })
  let computeCount = 0
  const compute = async () => {
    computeCount += 1
    return { total: 42 }
  }

  const first = await cache.getOrCompute(key(), compute)
  assert.equal(computeCount, 1, 'ilk istek hesaplar')
  assert.equal(first.cached, false)
  assert.deepEqual(first.value, { total: 42 })

  const second = await cache.getOrCompute(key(), compute)
  assert.equal(computeCount, 1, 'cache hit ağır hesaplamayı tekrar çağırmaz')
  assert.equal(second.cached, true)
  assert.deepEqual(second.value, { total: 42 })
})

test('2) İkinci istek cache hit metadata döner (generatedAt/cacheAgeMs)', async () => {
  const clock = makeClock(5000)
  const cache = new AnalyticsCache({ maxEntries: 10, ttlMs: 60_000, now: clock.now })
  const compute = async () => ({ n: 1 })

  const first = await cache.getOrCompute(key(), compute)
  assert.equal(first.cached, false)
  assert.equal(first.generatedAt, 5000)
  assert.equal(first.cacheAgeMs, 0)

  clock.advance(1234)
  const hit = await cache.getOrCompute(key(), compute)
  assert.equal(hit.cached, true)
  assert.equal(hit.generatedAt, 5000, 'generatedAt ilk hesaplama zamanı')
  assert.equal(hit.cacheAgeMs, 1234, 'cacheAgeMs yaş')
})

test('3) Farklı tenant başka tenant cache sonucunu GÖREMEZ', async () => {
  const cache = new AnalyticsCache({ maxEntries: 10, ttlMs: 60_000 })
  let calls = 0
  const compute = (tag) => async () => {
    calls += 1
    return { tenant: tag }
  }
  const a = await cache.getOrCompute(key({ tenantId: 'org-A' }), compute('A'))
  const b = await cache.getOrCompute(key({ tenantId: 'org-B' }), compute('B'))
  assert.equal(calls, 2, 'ayrı tenant ayrı hesaplama')
  assert.deepEqual(a.value, { tenant: 'A' })
  assert.deepEqual(b.value, { tenant: 'B' })
  // org-A tekrar → hit; org-B'nin değeri sızmaz.
  const aAgain = await cache.getOrCompute(key({ tenantId: 'org-A' }), compute('A2'))
  assert.equal(calls, 2)
  assert.deepEqual(aAgain.value, { tenant: 'A' })
})

test('4) Farklı tarih aralığı / timezone / filtre / resource FARKLI key üretir', () => {
  const base = key()
  assert.notEqual(base, key({ startMs: 999 }), 'farklı start farklı key')
  assert.notEqual(base, key({ endMs: 2001 }), 'farklı end farklı key')
  assert.notEqual(base, key({ timezone: 'UTC' }), 'farklı timezone farklı key')
  assert.notEqual(base, key({ filters: { city: 'Ankara' } }), 'farklı filtre farklı key')
  assert.notEqual(base, key({ resource: 'claims' }), 'farklı resource farklı key')
  assert.notEqual(base, key({ tenantId: 'org-2' }), 'farklı tenant farklı key')
  // Aynı parametre → aynı key (deterministik). Filtre alan sırası önemsiz.
  assert.equal(
    buildAnalyticsCacheKey({ resource: 'orders', tenantId: 't', startMs: 1, endMs: 2, filters: { a: 1, b: 2 } }),
    buildAnalyticsCacheKey({ resource: 'orders', tenantId: 't', startMs: 1, endMs: 2, filters: { b: 2, a: 1 } }),
  )
  assert.ok(base.includes(`v=${ANALYTICS_REPORT_VERSION}`), 'rapor sürümü key\'de')
  assert.ok(base.includes('|t=org-1|'), 'tenant invalidation token key\'de')
})

test('5) refresh=bypass cache\'i atlar, yeniden hesaplar ve ESKİ kaydın üzerine yazar', async () => {
  const cache = new AnalyticsCache({ maxEntries: 10, ttlMs: 60_000 })
  let version = 0
  const compute = async () => {
    version += 1
    return { version }
  }
  const first = await cache.getOrCompute(key(), compute)
  assert.deepEqual(first.value, { version: 1 })
  // Normal istek → hit (version 1).
  assert.deepEqual((await cache.getOrCompute(key(), compute)).value, { version: 1 })
  // refresh → bypass + yeniden hesapla + üzerine yaz.
  const refreshed = await cache.getOrCompute(key(), compute, { bypass: true })
  assert.equal(refreshed.cached, false)
  assert.deepEqual(refreshed.value, { version: 2 })
  // Sonraki normal istek yeni değeri (version 2) döner.
  assert.deepEqual((await cache.getOrCompute(key(), compute)).value, { version: 2 })
})

test('6) invalidateTenant SADECE o tenant kayıtlarını düşürür (sipariş sync sonrası)', async () => {
  const cache = new AnalyticsCache({ maxEntries: 20, ttlMs: 60_000 })
  const compute = (v) => async () => ({ v })
  // org-A: orders + claims; org-B: orders.
  await cache.getOrCompute(key({ tenantId: 'org-A', resource: 'orders' }), compute('a-o'))
  await cache.getOrCompute(
    buildAnalyticsCacheKey({ resource: 'claims', tenantId: 'org-A', startMs: 1000, endMs: 2000 }),
    compute('a-c'),
  )
  await cache.getOrCompute(key({ tenantId: 'org-B', resource: 'orders' }), compute('b-o'))
  assert.equal(await cache.size(), 3)

  const removed = await cache.invalidateTenant('org-A')
  assert.equal(removed, 2, 'org-A\'nın orders+claims kaydı düşer')
  assert.equal(await cache.hasFresh(key({ tenantId: 'org-A', resource: 'orders' })), false)
  assert.equal(await cache.hasFresh(key({ tenantId: 'org-B', resource: 'orders' })), true, 'org-B etkilenmez')
})

test('7) Eşzamanlı 10 istek TEK ağır hesaplama çalıştırır (single-flight)', async () => {
  const cache = new AnalyticsCache({ maxEntries: 10, ttlMs: 60_000 })
  let computeCount = 0
  let resolveCompute
  const gate = new Promise((resolve) => (resolveCompute = resolve))
  const compute = async () => {
    computeCount += 1
    await gate
    return { heavy: true }
  }
  // 10 eşzamanlı istek (hepsi aynı key) — compute henüz çözülmedi.
  const requests = Array.from({ length: 10 }, () => cache.getOrCompute(key(), compute))
  resolveCompute()
  const results = await Promise.all(requests)
  assert.equal(computeCount, 1, 'promise deduplication: tek hesaplama')
  for (const r of results) assert.deepEqual(r.value, { heavy: true })
})

test('8) Başarısız hesaplama cache\'e YAZILMAZ (promise/hata kalıcı kayıt olmaz)', async () => {
  const cache = new AnalyticsCache({ maxEntries: 10, ttlMs: 60_000 })
  let attempts = 0
  const failing = async () => {
    attempts += 1
    throw new Error('upstream 502')
  }
  await assert.rejects(() => cache.getOrCompute(key(), failing), /upstream 502/)
  assert.equal(await cache.hasFresh(key()), false, 'hata cache\'e yazılmaz')
  assert.equal(await cache.size(), 0, 'promise/hata kalıcı kayıt bırakmaz')

  // Sonraki başarılı hesaplama normal cache\'lenir.
  const ok = await cache.getOrCompute(key(), async () => ({ ok: true }))
  assert.equal(ok.cached, false)
  assert.equal(attempts, 1)
  assert.equal(await cache.hasFresh(key()), true)
})

test('9) Maksimum boyut aşılınca en eski (LRU) entry çıkarılır; bellek sınırlı', async () => {
  const cache = new AnalyticsCache({ maxEntries: 2, ttlMs: 60_000 })
  const compute = (v) => async () => ({ v })
  await cache.getOrCompute(key({ startMs: 1 }), compute(1))
  await cache.getOrCompute(key({ startMs: 2 }), compute(2))
  assert.equal(await cache.size(), 2)
  // Üçüncü kayıt → en eski (start=1) çıkar.
  await cache.getOrCompute(key({ startMs: 3 }), compute(3))
  assert.equal(await cache.size(), 2, 'boyut maxEntries\'i aşmaz')
  assert.equal(await cache.hasFresh(key({ startMs: 1 })), false, 'en eski çıkarıldı')
  assert.equal(await cache.hasFresh(key({ startMs: 2 })), true)
  assert.equal(await cache.hasFresh(key({ startMs: 3 })), true)
})

test('LRU erişim-sırası: okunan kayıt "en yeni" olur, eviction\'dan korunur', async () => {
  const cache = new AnalyticsCache({ maxEntries: 2, ttlMs: 60_000 })
  const compute = (v) => async () => ({ v })
  await cache.getOrCompute(key({ startMs: 1 }), compute(1))
  await cache.getOrCompute(key({ startMs: 2 }), compute(2))
  // start=1'e eriş → en yeni olur; sonraki eklemede start=2 çıkar.
  await cache.getOrCompute(key({ startMs: 1 }), compute(1))
  await cache.getOrCompute(key({ startMs: 3 }), compute(3))
  assert.equal(await cache.hasFresh(key({ startMs: 1 })), true, 'erişilen korunur')
  assert.equal(await cache.hasFresh(key({ startMs: 2 })), false, 'erişilmeyen çıkar')
})

test('TTL: süre dolunca normal cache-miss oluşur (yeniden hesaplanır)', async () => {
  const clock = makeClock(0)
  const cache = new AnalyticsCache({ maxEntries: 10, ttlMs: 1000, now: clock.now })
  let computeCount = 0
  const compute = async () => {
    computeCount += 1
    return { c: computeCount }
  }
  await cache.getOrCompute(key(), compute)
  clock.advance(999)
  assert.equal((await cache.getOrCompute(key(), compute)).cached, true, 'TTL içinde hit')
  clock.advance(2) // toplam 1001ms > ttl
  const afterExpiry = await cache.getOrCompute(key(), compute)
  assert.equal(afterExpiry.cached, false, 'TTL sonrası miss')
  assert.equal(computeCount, 2, 'TTL sonrası yeniden hesaplar')
})

test('PII: sanitizeAnalyticsOrders ham payload/adres/telefon/e-posta düşürür, aggregate korur', () => {
  const raw = {
    packageId: 'PKG-1',
    orderNumber: 'ORD-1',
    marketplace: 'Trendyol',
    marketplaceStatus: 'Delivered',
    orderDate: '2026-07-10T00:00:00Z',
    totalAmount: 149.9,
    city: 'İstanbul',
    district: 'Kadıköy',
    customerName: 'Ada L.',
    customerFirstName: 'Ada',
    customerLastName: 'Lovelace',
    customerPhone: '5551112233',
    customerEmail: 'ada@example.com',
    address: 'Gizli Mah. Sokak No 1',
    shipmentAddress: { fullAddress: 'Gizli Mah. Sokak No 1', phone: '5551112233', city: 'İstanbul' },
    rawOrder: { customerPhone: '5551112233', tcId: '11111111111' },
    items: [{ barcode: 'BRC', price: 149.9, quantity: 1, productName: 'Ürün', color: 'Siyah', stockCode: 'S1' }],
  }
  const clean = sanitizeAnalyticsOrder(raw)
  const dump = JSON.stringify(clean)
  // PII düştü.
  for (const secret of ['5551112233', 'ada@example.com', 'Gizli Mah', '11111111111', 'Lovelace']) {
    assert.ok(!dump.includes(secret), `PII sızmamalı: ${secret}`)
  }
  assert.equal(clean.rawOrder, undefined)
  assert.equal(clean.shipmentAddress, undefined)
  assert.equal(clean.address, undefined)
  assert.equal(clean.customerPhone, undefined)
  assert.equal(clean.customerEmail, undefined)
  // Aggregate/gösterim alanları korundu.
  assert.equal(clean.packageId, 'PKG-1')
  assert.equal(clean.totalAmount, 149.9)
  assert.equal(clean.city, 'İstanbul')
  assert.equal(clean.customerName, 'Ada L.', 'kartlarda gösterilen ad korunur')
  // Satır alanları (ürün kırılımı için gerekli) tam korunur.
  assert.deepEqual(clean.items[0], {
    barcode: 'BRC', price: 149.9, quantity: 1, productName: 'Ürün', color: 'Siyah', stockCode: 'S1',
  })
  // Toplu sürüm de aynı davranır.
  assert.equal(sanitizeAnalyticsOrders([raw]).length, 1)
  assert.equal(sanitizeAnalyticsOrders([raw])[0].customerPhone, undefined)
})
