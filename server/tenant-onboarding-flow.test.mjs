import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// Organization onboarding (faz 7) hermetik testleri A-P. Gerçek PostgreSQL
// motoru (pglite). Onboarding durumu GERÇEK DB kayıtlarından türetilir;
// credential/sync/shipment akışlarına DOKUNMAZ. Sürat create ÇAĞRILMAZ.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.PRODUCT_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const service = await import('./onboarding/onboardingService.ts')
const repo = await import('./onboarding/onboardingRepository.ts')
const credentials = await import('./integrations/credentialService.ts')
const products = await import('./products/productPersistenceService.ts')
const orders = await import('./orders/orderPersistenceService.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}
async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, name, slug) {
  const [org] = await db.insert(schema.organizations).values({ name, slug }).returning()
  return org.id
}
function makeProduct(barcode) {
  return {
    marketplace: 'Trendyol',
    externalProductId: `P-${barcode}`,
    externalVariantId: `V-${barcode}`,
    productName: 'Ürün',
    sku: `SKU-${barcode}`,
    barcode,
    stock: 1,
    price: 10,
    images: [],
    updatedAt: '2026-07-10T00:00:00Z',
  }
}
function makeOrder(pkg) {
  return {
    marketplace: 'Trendyol',
    packageId: pkg,
    orderNumber: `ORD-${pkg}`,
    orderDate: '2026-07-10T00:00:00Z',
    items: [],
  }
}

test('onboarding A-P: izolasyon, koşullar, sync metadata, Sürat create=0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A', 'onb-a')
  const orgB = await makeOrg(db, 'Org B', 'onb-b')

  // A) Yeni organization onboarding'e yönlenir (completed=false, adımlar boş).
  // ONBOARDING-001: sağlayıcıya bağlı boolean alanlar yerine sağlayıcı
  // farkında projeksiyon + kararlı engel kodları. AYNI olgular doğrulanır.
  const initial = await service.deriveOnboardingStatus(db, orgA)
  assert.equal(initial.completed, false)
  assert.equal(initial.marketplaces[0].providerKey, 'trendyol')
  assert.equal(initial.marketplaces[0].configured, false)
  assert.equal(initial.carrier.configured, false)
  assert.equal(initial.marketplaces[0].bootstrapReady, false)
  assert.equal(initial.steps.find((step) => step.key === 'FIRST_SYNC').done, false)
  assert.equal(initial.counts.products, 0)
  assert.equal(initial.counts.orders, 0)

  // E) Credential olmadan complete → 409 (eksik: pazaryeri, taşıyıcı).
  // İlk senkron engeli pazaryeri KURULMADAN raporlanmaz (sıralı engel).
  const noCred = await service.completeOnboarding(db, orgA)
  assert.equal(noCred.ok, false)
  assert.ok(noCred.blockers.includes('MARKETPLACE_NOT_CONFIGURED'))
  assert.ok(noCred.blockers.includes('CARRIER_NOT_CONFIGURED'))
  assert.equal(noCred.status.eligibleToComplete, false)

  // H) Sürat + Trendyol configured durumu doğru yansır.
  await credentials.saveIntegrationCredential(db, orgA, 'trendyol', { sellerId: '12345' })
  await credentials.saveIntegrationCredential(db, orgA, 'surat', { kullaniciAdi: 'user', firmaId: '1' })
  const configured = await service.deriveOnboardingStatus(db, orgA)
  assert.equal(configured.marketplaces[0].configured, true)
  assert.equal(configured.carrier.configured, true)
  // SUPERSEDED (ONBOARDING-001): eski çapa "Sürat configured = verified"
  // kuralını SABİTLİYORDU — kimlik VARLIĞI doğrulama DEĞİLDİR. Kalıcı,
  // gönderi oluşturmayan doğrulama kanıtı olmadığı AÇIKÇA söylenir.
  assert.equal(configured.carrier.verification, 'VERIFICATION_NOT_PERSISTED')
  assert.equal('suratConnectionVerified' in configured, false)

  // F) Trendyol/Sürat configured ama sync yok → complete 409 (ilk senkron).
  const noSync = await service.completeOnboarding(db, orgA)
  assert.equal(noSync.ok, false)
  assert.deepEqual(noSync.blockers, ['FIRST_SYNC_REQUIRED'])

  // M) Partial sync (kayıt 0) completed saymaz: bootstrap hazır değil.
  await repo.recordSyncState(db, orgA, {
    provider: 'trendyol', resource: 'products', status: 'partial', fetchedCount: 0,
  })
  const afterPartial = await service.deriveOnboardingStatus(db, orgA)
  assert.equal(afterPartial.marketplaces[0].bootstrapReady, false, 'partial + 0 kayıt sync sayılmaz')

  // G) Başarılı ürün sync sonrası durum güncellenir (kayıt + metadata).
  // Bu organizasyonun HİÇ hesabı yok → eski (hesapsız) satır AÇIK
  // uyumlulukla sayılır (ONB-10).
  await products.persistProductSyncResult(db, orgA, [makeProduct('B1')], { complete: true })
  await repo.recordSyncState(db, orgA, {
    provider: 'trendyol', resource: 'products', status: 'success', fetchedCount: 1,
  })
  const afterProducts = await service.deriveOnboardingStatus(db, orgA)
  assert.equal(afterProducts.marketplaces[0].bootstrapReady, true, 'başarılı sync bağlantıyı doğrular')
  assert.equal(afterProducts.marketplaces[0].legacyConnection.counted, true)
  assert.equal(afterProducts.counts.products, 1)

  // I) Tüm koşullar sağlanınca complete başarılı + kalıcı.
  const done = await service.completeOnboarding(db, orgA)
  assert.equal(done.ok, true)
  assert.equal(done.status.completed, true)
  // Refresh (yeniden derive) hâlâ completed → Dashboard açılır, onboarding'e dönmez.
  const refreshed = await service.deriveOnboardingStatus(db, orgA)
  assert.equal(refreshed.completed, true)

  // J) onboardingCompleted DB'de kalıcıdır (frontend source-of-truth değil):
  // yeni db örneği (restart) aynı sonucu verir.
  const db2 = drizzle(pglite, { schema })
  assert.equal((await service.deriveOnboardingStatus(db2, orgA)).completed, true)

  // B) Tamamlanmış organization uygulamaya girer (completed=true görülür).
  assert.equal((await repo.getSettings(db, orgA)).onboardingCompleted, true)

  // C) Org A onboarding durumu Org B'yi ETKİLEMEZ.
  const bStatus = await service.deriveOnboardingStatus(db, orgB)
  assert.equal(bStatus.completed, false)
  assert.equal(bStatus.marketplaces[0].configured, false)
  assert.equal(bStatus.counts.products, 0, 'Org B kataloğu boş')

  // D) Durum yalnız verilen org'dan türetilir (sahte/başka org karışmaz).
  // Org B için complete koşulları sağlanmaz (kendi credential/sync'i yok).
  const bComplete = await service.completeOnboarding(db, orgB)
  assert.equal(bComplete.ok, false)

  // P) Başka organization ürün/sipariş sayıları status'a karışmaz.
  await orders.persistSyncResult(db, orgB, [makeOrder('PKGB')], { complete: true })
  const bAfter = await service.deriveOnboardingStatus(db, orgB)
  assert.equal(bAfter.counts.orders, 1)
  assert.equal(bAfter.counts.products, 0)
  // Org A sayıları Org B sync'inden etkilenmez.
  const aAfter = await service.deriveOnboardingStatus(db, orgA)
  assert.equal(aAfter.counts.orders, 0, 'Org A sipariş sayısı Org B\'den etkilenmez')
  assert.equal(aAfter.counts.products, 1)

  // G-ek) Sipariş sync'i de firstSync kriterini karşılar (orders yolu).
  await repo.recordSyncState(db, orgB, {
    provider: 'trendyol', resource: 'orders', status: 'success', fetchedCount: 1,
  })
  await credentials.saveIntegrationCredential(db, orgB, 'trendyol', { sellerId: '99' })
  await credentials.saveIntegrationCredential(db, orgB, 'surat', { firmaId: '2' })
  const bReady = await service.completeOnboarding(db, orgB)
  assert.equal(bReady.ok, true, 'sipariş sync + credential ile complete başarılı')

  // N/O) Onboarding boyunca Sürat create ÇAĞRILMAZ: shipment_operations boş.
  assert.equal(
    (await db.select().from(schema.shipmentOperations)).length,
    0,
    'onboarding istemsiz Sürat create tetiklemez',
  )
  // shipments tablosu da boş (create/persist yok).
  assert.equal((await db.select().from(schema.shipments)).length, 0)
})

// L) Çift tıklama koruması saf mantık düzeyinde: TEK kanonik değerlendirici
// (`evaluateOnboarding`) idempotent ve yan etkisizdir (aynı durumda tekrar
// çağrı aynı sonucu verir). ONBOARDING-001: `evaluateCompletion` bu
// değerlendiriciyle DEĞİŞTİRİLDİ — ikinci bir tamamlanma algoritması YOK.
test('evaluateOnboarding idempotent + eksik adım raporu (L,M)', async () => {
  const model = await import('./onboarding/onboardingModel.ts')
  const base = {
    completed: false,
    completedAt: null,
    providers: [{
      providerKey: 'trendyol', displayName: 'Trendyol', rolloutStage: 'ga',
      eligibleForOnboarding: true, bootstrapResources: ['orders', 'products'],
    }],
    healthByResource: {
      products: [{
        providerKey: 'trendyol', marketplaceAccountId: null, connectionScope: 'legacy',
        connection: 'CONNECTED', sync: 'HEALTHY', lastSuccessfulSyncAt: '2026-07-10T00:00:00.000Z',
      }],
    },
    accounts: [],
    accountScopedCredentialProviders: [],
    carrierConfigured: false,
    defaultUnitDesiConfigured: false,
    counts: { products: 3, orders: 0 },
  }
  const first = model.evaluateOnboarding(base)
  const second = model.evaluateOnboarding(base)
  assert.deepEqual(first, second, 'aynı durumda aynı sonuç (idempotent)')
  assert.deepEqual(first.blockers, ['CARRIER_NOT_CONFIGURED'])
  assert.equal(first.eligibleToComplete, false)

  const ready = model.evaluateOnboarding({ ...base, carrierConfigured: true })
  assert.equal(ready.eligibleToComplete, true)
  assert.deepEqual(ready.blockers, [])
})
