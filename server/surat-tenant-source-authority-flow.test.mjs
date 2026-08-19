import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// KİRACI KAYNAK OTORİTESİ — ÜRETİM ÇELİŞKİSİ A.
//
// ═══ ÖLÇÜLEN OLGU ════════════════════════════════════════════════════════
//
// Aynı kiracı için kanarya otoriter birincil hesabı `****2622` gösterdi;
// canlı POST'un izi telde `****0944` gösterdi. İki yol da "kiracı deposundan
// okudum" diyordu ve İKİSİ DE haklı olabilirdi: hiçbir çıktı HANGİ
// organizasyonun HANGİ satırının okunduğunu yazmıyordu.
//
// `integration_credentials` üzerinde `(organization_id, provider)` tekil
// indeksi VARDIR — yani tek organizasyon içinde iki Sürat satırı bulunamaz.
// Bu, ayrışmanın kaynağının satır seçimi OLAMAYACAĞINI söyler; geriye
// GİRDİNİN farklı olması kalır (farklı organizationId). Bu testler o farkı
// GÖRÜNÜR ve KARŞILAŞTIRILABİLİR yapar — üretim erişimi olmadan ayrışmanın
// kendisini "düzeltildi" diye ilan ETMEZ.
//
// ═══ SIR ═════════════════════════════════════════════════════════════════
// Ham kullanıcı adı/parola hiçbir iddiada basılmaz; kimlikler maskelidir.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const CRED = await import('./integrations/credentialService.ts')
const ACTIVE = await import('./integrations/activeSuratIntegration.ts')
const SNAP = await import('./shipments/suratCredentialSnapshot.ts')
const ROUTING = await import('./shipments/suratRoutingModel.ts')
const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')
const PROJECTION = await import('./shipments/suratTraceProjection.ts')

const KEY_HEX = randomBytes(32).toString('hex')

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
  const [org] = await db
    .insert(schema.organizations)
    .values({ name, slug })
    .returning()
  return org.id
}

function withEncryptionKey(t) {
  const previous = process.env.CREDENTIAL_ENCRYPTION_KEY
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_HEX
  t.after(() => {
    if (previous === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY
    else process.env.CREDENTIAL_ENCRYPTION_KEY = previous
  })
}

// ═══ TENANT-1 — TEK YÜKLEYİCİ ════════════════════════════════════════════

test('TENANT-1: kanarya ve canlı POST AYNI yükleyiciyi çağırır', async () => {
  const [indexSource, canarySource] = await Promise.all([
    readFile(new URL('./index.mjs', import.meta.url), 'utf8'),
    readFile(
      new URL('./shipments/suratCanaryPrecheckCli.ts', import.meta.url), 'utf8',
    ),
  ])
  const loader = 'loadActiveSuratIntegrationForOrganization'
  assert.ok(
    indexSource.includes(loader),
    'canlı POST paylaşılan yükleyiciyi kullanmıyor',
  )
  assert.ok(
    canarySource.includes(loader),
    'kanarya paylaşılan yükleyiciyi kullanmıyor',
  )
  // İKİNCİ bir normalizasyon çağrısı kalırsa iki yol yeniden ayrışabilir:
  // türetme YALNIZ yükleyicinin içinde olmalıdır.
  assert.equal(
    canarySource.includes('normalizeAuthoritativeSuratStore'), false,
    'kanarya hâlâ kendi normalizasyonunu yapıyor',
  )
})

// ═══ TENANT-2 — AYNI GİRDİ, AYNI ÇIKTI ═══════════════════════════════════

test('TENANT-2: aynı organizasyon için yükleyici deterministiktir', async (t) => {
  withEncryptionKey(t)
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Monalisa', 'monalisa')
  await CRED.saveIntegrationCredential(db, org, 'surat', {
    serviceMode: 'SURAT_CANONICAL_API',
    liveKullaniciAdi: '1537692622',
    liveSifre: 'SECRET',
  })

  const first = await ACTIVE.loadActiveSuratIntegrationForOrganization(db, org)
  const second = await ACTIVE.loadActiveSuratIntegrationForOrganization(db, org)
  assert.deepEqual(first, second)
  assert.equal(first.configured, true)

  // Kanarya ile canlı POST aynı deponun ÜZERİNE aynı anlık görüntüyü kurar.
  const snapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: first.store,
    role: 'PRIMARY_MARKETPLACE',
  })
  assert.equal(snapshot.resolved, true)
  assert.equal(snapshot.accountFingerprint, 'LEN10:****2622')
})

// ═══ TENANT-3 — BELİRSİZLİK FAIL CLOSED ══════════════════════════════════

test('TENANT-3: birden çok kayıtta satır SEÇİLMEZ, hata atılır', async () => {
  // Tekil indeks gerçek DB'de bunu engeller; bu yüzden koşul stub ile
  // kurulur. Test edilen şey indeksin varlığı DEĞİL, indeks olmadığında
  // kodun ne yaptığıdır: `rows[0]` sessizce YANLIŞ cariyi seçerdi.
  const stubDb = {
    select: () => ({
      from: () => ({
        where: async () => [
          { id: 'row-a', updatedAt: null, encryptedPayload: '{}' },
          { id: 'row-b', updatedAt: null, encryptedPayload: '{}' },
        ],
      }),
    }),
  }
  await assert.rejects(
    () => CRED.getIntegrationCredentialRecord(stubDb, 'org-x', 'surat'),
    (error) => {
      assert.equal(error.code, 'INTEGRATION_CREDENTIAL_AMBIGUOUS')
      assert.equal(error.recordCount, 2)
      return true
    },
  )
  // Paylaşılan yükleyici hatayı YUTMAZ: yanlış cariye gönderi açmaktansa
  // deneme durmalıdır.
  await assert.rejects(
    () => ACTIVE.loadActiveSuratIntegrationForOrganization(stubDb, 'org-x'),
    /INTEGRATION_CREDENTIAL_AMBIGUOUS|kayıt bulundu/,
  )
})

// ═══ TENANT-4 — KİMLİK MASKELİ ═══════════════════════════════════════════

test('TENANT-4: kayıt kimliği maskelidir, ham değer sızmaz', async (t) => {
  withEncryptionKey(t)
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Maskeli', 'maskeli')
  await CRED.saveIntegrationCredential(db, org, 'surat', {
    liveKullaniciAdi: '1537692622', liveSifre: 'SECRET',
  })
  const active = await ACTIVE.loadActiveSuratIntegrationForOrganization(db, org)

  assert.ok(active.organizationIdMasked.startsWith('****'))
  assert.ok(active.integrationIdMasked.startsWith('****'))
  assert.equal(active.organizationIdMasked.length <= 8, true)
  assert.equal(
    active.organizationIdMasked.includes(org), false,
    'ham organizasyon kimliği maskede duruyor',
  )
  const serialized = JSON.stringify({
    organizationIdMasked: active.organizationIdMasked,
    integrationIdMasked: active.integrationIdMasked,
    configured: active.configured,
  })
  assert.equal(serialized.includes('SECRET'), false)
  assert.equal(serialized.includes('1537692622'), false)

  // Kayıt yoksa "bilinmiyor" AYRI bir değerdir; boş dize iki farklı
  // bilinmeyeni eşit gösterirdi.
  const empty = await ACTIVE.loadActiveSuratIntegrationForOrganization(
    db, await makeOrg(db, 'Bos', 'bos'),
  )
  assert.equal(empty.configured, false)
  assert.equal(empty.integrationIdMasked, ACTIVE.INTEGRATION_ID_ABSENT)
})

// ═══ TENANT-5 — AYRIŞMA ARTIK ÖLÇÜLEBİLİR ════════════════════════════════

test('TENANT-5: farklı organizasyon farklı kayıt kimliği ve hesap verir', async (t) => {
  withEncryptionKey(t)
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  // ÜRETİM ÇELİŞKİSİNİN BİREBİR KURULUMU: iki organizasyon, iki hesap.
  const orgCanary = await makeOrg(db, 'Kanarya Kiracisi', 'kanarya')
  const orgLive = await makeOrg(db, 'Canli Kiracisi', 'canli')
  await CRED.saveIntegrationCredential(db, orgCanary, 'surat', {
    liveKullaniciAdi: '1537692622', liveSifre: 'S1',
  })
  await CRED.saveIntegrationCredential(db, orgLive, 'surat', {
    liveKullaniciAdi: '1537690944', liveSifre: 'S2',
  })

  const canary = await ACTIVE.loadActiveSuratIntegrationForOrganization(
    db, orgCanary,
  )
  const live = await ACTIVE.loadActiveSuratIntegrationForOrganization(db, orgLive)

  const fingerprint = (active) => SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: active.store, role: 'PRIMARY_MARKETPLACE',
  }).accountFingerprint

  assert.equal(fingerprint(canary), 'LEN10:****2622')
  assert.equal(fingerprint(live), 'LEN10:****0944')
  // KANIT NOKTASI: ayrışma artık kimlikten OKUNABİLİR. Önceden iki taraf da
  // yalnız "tenant.surat.primary" diyordu ve fark görünmezdi.
  assert.notEqual(canary.integrationIdMasked, live.integrationIdMasked)
  assert.notEqual(canary.organizationIdMasked, live.organizationIdMasked)
})

// ═══ SOURCE — ETİKET YALNIZ GERÇEKTEN ÇÖZÜLDÜYSE ═════════════════════════

const baseOrder = {
  marketplace: 'Trendyol',
  orderNumber: '1141234567',
  packageId: 'PKG-TENANT',
  cargoTrackingNumber: '727TEST123',
  customerName: 'Test Alici',
  address: 'Ornek Mah. 1',
  city: 'Istanbul',
  district: 'Kadikoy',
  customerPhone: '5551112233',
  desi: 2,
  items: [{ productName: 'Urun', quantity: 1 }],
}

async function runAdapter({ store, identity }) {
  const config = { serviceMode: 'SURAT_CANONICAL_API' }
  return ADAPTER.createCanonicalSuratShipmentForRequest({
    organizationId: 'org-tenant',
    credentialSnapshot: SNAP.buildSuratCredentialSnapshot({
      storedSuratConfig: store,
      role: ROUTING.resolveSuratCredentialContext({
        config,
        billingParty: ROUTING.resolveBillingPartyV2({}).billingParty,
        cod: ROUTING.resolveCodContext({ enabled: false }),
        codPolicy: ROUTING.resolveCodCredentialPolicy(undefined),
      }).role,
    }),
    credentialRecordIdentity: identity,
    config,
    order: baseOrder,
    reference: 'PKG-TENANT',
    // Ağ ÇAĞRILMAZ: çözülemeyen kimlik taşıyıcıya gitmeden bloke olmalıdır.
    fetchImpl: () => {
      throw new Error('TAŞIYICI ÇAĞRILDI — bu testte ağ YASAK')
    },
  })
}

test('SOURCE-1: çözülemeyen anlık görüntü tenant.surat.primary DEMEZ', async () => {
  const result = await runAdapter({
    store: {}, // kimlik alanı YOK → resolved=false
    identity: {
      organizationIdMasked: '****aaaa',
      integrationIdMasked: '****bbbb',
      integrationConfigured: true,
    },
  })
  assert.equal(result.ok, false)
  const routing = PROJECTION.stageData(result.traceAttempt?.stages, 'ROUTING')
  assert.ok(routing, 'ROUTING aşaması yok')
  assert.equal(routing.credentialResolved, false)
  assert.equal(
    routing.credentialSource, 'UNRESOLVED_SNAPSHOT',
    'çözülmemiş kimlik "kiracı birincil hesabı" gibi etiketleniyor',
  )
  assert.equal(routing.maskedAccount, '')
})

test('SOURCE-2: çözülen anlık görüntü rol etiketini KORUR', async () => {
  const result = await runAdapter({
    store: { liveKullaniciAdi: '1537692622', liveSifre: 'SECRET' },
    identity: {
      organizationIdMasked: '****aaaa',
      integrationIdMasked: '****bbbb',
      integrationConfigured: true,
    },
  })
  const routing = PROJECTION.stageData(result.traceAttempt?.stages, 'ROUTING')
  assert.equal(routing.credentialResolved, true)
  // Mevcut iz sözleşmesi: etiket ROL ÖZELDİR ve düzleştirilmez.
  assert.equal(routing.credentialSource, 'tenant.surat.primary')
})

test('SOURCE-3: kayıt kimliği ize düşer; verilmezse UNKNOWN olur', async () => {
  const withIdentity = await runAdapter({
    store: { liveKullaniciAdi: '1537692622', liveSifre: 'SECRET' },
    identity: {
      organizationIdMasked: '****aaaa',
      integrationIdMasked: '****bbbb',
      integrationConfigured: true,
    },
  })
  const routing = PROJECTION.stageData(withIdentity.traceAttempt?.stages, 'ROUTING')
  assert.equal(routing.tenantOrganizationIdMasked, '****aaaa')
  assert.equal(routing.tenantIntegrationIdMasked, '****bbbb')
  assert.equal(routing.tenantIntegrationConfigured, true)

  const without = await runAdapter({
    store: { liveKullaniciAdi: '1537692622', liveSifre: 'SECRET' },
    identity: null,
  })
  const bare = PROJECTION.stageData(without.traceAttempt?.stages, 'ROUTING')
  // Boş dize DEĞİL: iki farklı bilinmeyen eşit görünmemeli.
  assert.equal(bare.tenantOrganizationIdMasked, 'UNKNOWN')
  assert.equal(bare.tenantIntegrationIdMasked, 'UNKNOWN')
})

// ═══ INSPECT — SAYAÇLAR DENETÇİNİNDİR, DENEMENİN DEĞİL ═══════════════════

test('INSPECT-1: sayaç etiketleri denetçinin KENDİ yan etkisini söyler', async () => {
  const source = await readFile(
    new URL('./shipments/suratTraceInspectCli.ts', import.meta.url), 'utf8',
  )
  // Eski etiketler (`NETWORK_CALLS=0`) denemenin özelliği sanılıyordu: aynı
  // iz `carrierCalled=true` derken denetçi `0` basıyordu.
  assert.ok(source.includes('INSPECTOR_NETWORK_CALLS=0'))
  assert.ok(source.includes('INSPECTOR_DB_WRITES=0'))
  assert.ok(source.includes('INSPECTOR_CREATE_CALLS=0'))
  assert.equal(
    /[^_]NETWORK_CALLS=0/.test(source), false,
    'etiketsiz sayaç kaldı; denemenin özelliği gibi okunur',
  )
  // Denetçi kayıt kimliğini de basmalı; yoksa A çelişkisi yine ölçülemez.
  assert.ok(source.includes('tenantIntegrationIdMasked'))
  assert.ok(source.includes('tenantOrganizationIdMasked'))
})

test('INSPECT-2: taşıyıcı gerçeği izden gelir, sayaçlardan DEĞİL', () => {
  const stages = [
    { stage: 'CARRIER_CALL_STARTED', section: 'CARRIER', at: 1, data: {} },
    {
      stage: 'CARRIER_RESPONSE',
      section: 'CARRIER',
      at: 2,
      data: { carrierCalled: true, createCallCount: 1, businessResult: 'SUCCESS' },
    },
    { stage: 'FINAL', section: 'FINAL', at: 3, data: { outcome: 'delivered' } },
  ]
  const truth = PROJECTION.projectCarrierTruth(stages)
  assert.equal(truth.carrierCallStarted, true)
  assert.equal(truth.carrierCalled, true)
  assert.equal(truth.carrierCreateAttempts, 1)
  assert.equal(truth.finalState, 'delivered')

  // Hiç çağrı yapılmamış deneme: `false` ile `ABSENT` karışmaz.
  const blocked = PROJECTION.projectCarrierTruth([
    { stage: 'FINAL', section: 'FINAL', at: 1, data: { outcome: 'blocked' } },
  ])
  assert.equal(blocked.carrierCallStarted, false)
  assert.equal(blocked.carrierCalled, false)
  assert.equal(blocked.carrierCreateAttempts, PROJECTION.WIRE_FIELD_ABSENT)
})
