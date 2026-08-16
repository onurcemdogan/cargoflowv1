import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// SERVIS MODU ROUND-TRIP — GERCEK ZINCIR (kaynak metni DEGIL).
//
// Bu dosya kaynak-metin iddiasi KULLANMAZ. Gercek sifreleme, gercek DB
// (PGlite + gercek migration'lar), gercek merge ve gercek maskeli durum
// uretimi CALISTIRILIR. Amac §5'teki ayrimi kesin yapmaktir:
//   DB'de ORTAK_BARKOD_SOAP  → SAVE/PERSISTENCE bug
//   DB'de SURAT_CANONICAL_API → RELOAD/HYDRATION bug

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const cred = await import('./integrations/credentialService.ts')
// GERCEK frontend modulu calistirilir (kaynak metni degil). `src/` uzantisiz
// bundler importlari kullandigi icin cozumleyici kancasi kaydedilir.
const { register } = await import('node:module')
register('./testing/bundlerStyleResolver.mjs', import.meta.url)
const FE = await import('../src/services/integrationConfigService.ts')

const CANONICAL = 'SURAT_CANONICAL_API'
const LEGACY = 'ORTAK_BARKOD_SOAP'

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

/** Uretimdeki kayitli sekil: legacy modda, gercek cari kodu ile. */
const STORED_LEGACY = {
  serviceMode: LEGACY,
  serviceType: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
  createShipmentPath: '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  ortam: 'live',
  kullaniciAdi: 'TEST_CUSTOMER_2622',
  sifre: 'TEST_SECRET',
  webPassword: 'TEST_WEB',
}

/** UI'nin kanonik secim sonrasi gonderdigi govde (secret alanlari BOS). */
const UI_CANONICAL_SAVE = {
  serviceMode: CANONICAL,
  serviceType: 'SuratCanonicalWebApi',
  createShipmentPath: '/api/OrtakBarkodOlustur',
  ortam: 'live',
  kullaniciAdi: '',
  sifre: '',
  webPassword: '',
}

// ═══ 1. SAVE → DB (GERCEK SIFRELEME) ══════════════════════════════════════

test('RT-1: kanonik mod GERCEK sifreli kayda yazilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka', 'monalisatoka')

  await cred.saveIntegrationCredential(db, org, 'surat', STORED_LEGACY)
  await cred.saveIntegrationCredential(db, org, 'surat', UI_CANONICAL_SAVE)

  const decrypted = await cred.getIntegrationCredential(db, org, 'surat')
  assert.equal(decrypted.serviceMode, CANONICAL, 'DB kanonik modu tasimali')
  // Bos secret ESKI degeri korur (mevcut sozlesme bozulmadi).
  assert.equal(decrypted.kullaniciAdi, 'TEST_CUSTOMER_2622')
  assert.equal(decrypted.sifre, 'TEST_SECRET')
})

// ═══ 2. DB → LOAD API (MASKELI DURUM) ═════════════════════════════════════

test('RT-2: maskeli durum kanonik modu GERI DONER, sir DONMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka', 'monalisatoka')
  await cred.saveIntegrationCredential(db, org, 'surat', STORED_LEGACY)
  await cred.saveIntegrationCredential(db, org, 'surat', UI_CANONICAL_SAVE)

  const status = await cred.getMaskedIntegrationStatus(db, org)
  assert.equal(status.surat.serviceMode, CANONICAL, 'load API kanonik donmeli')
  // Sir sizmaz.
  const json = JSON.stringify(status)
  assert.equal(json.includes('TEST_SECRET'), false)
  assert.equal(json.includes('TEST_WEB'), false)
  assert.equal(status.surat.hasPassword, true)
})

// ═══ 3. LOAD API → FORM HYDRATION (GERCEK FRONTEND GUARD) ═════════════════

/** Auth modu hydrate mantiginin AYNISI (gercek frontend fonksiyonlariyla). */
function hydrateSuratFromStatus(suratStatus) {
  return {
    ...FE.defaultIntegrationConfig.surat,
    kullaniciAdi: String(suratStatus?.cariKod ?? suratStatus?.customerCode ?? ''),
    firmaId: String(suratStatus?.firmaId ?? ''),
    ...(FE.isSuratServiceMode(suratStatus?.serviceMode)
      ? {
          serviceMode: suratStatus.serviceMode,
          ...FE.routeFromServiceMode(suratStatus.serviceMode),
        }
      : {}),
  }
}

test('RT-3: maskeli durumdan hydrate KANONIK kalir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka', 'monalisatoka')
  await cred.saveIntegrationCredential(db, org, 'surat', STORED_LEGACY)
  await cred.saveIntegrationCredential(db, org, 'surat', UI_CANONICAL_SAVE)

  const status = await cred.getMaskedIntegrationStatus(db, org)
  const hydrated = hydrateSuratFromStatus(status.surat)
  assert.equal(hydrated.serviceMode, CANONICAL, 'form kanonik gostermeli')
  assert.equal(hydrated.serviceType, 'SuratCanonicalWebApi')
  assert.equal(hydrated.createShipmentPath, '/api/OrtakBarkodOlustur')
})

// ═══ 4. SAYFA YENILEME SIMULASYONU (TAM TUR) ══════════════════════════════

test('RT-4: sayfa yenileme turu kanonik modu KAYBETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka', 'monalisatoka')
  await cred.saveIntegrationCredential(db, org, 'surat', STORED_LEGACY)
  await cred.saveIntegrationCredential(db, org, 'surat', UI_CANONICAL_SAVE)

  // Yenileme 1 → hydrate → (kullanici hicbir sey degistirmeden) tekrar kaydet.
  for (let round = 0; round < 3; round += 1) {
    const status = await cred.getMaskedIntegrationStatus(db, org)
    const hydrated = hydrateSuratFromStatus(status.surat)
    assert.equal(hydrated.serviceMode, CANONICAL, `tur ${round}: kanonik kalmali`)
    // Form neyse o geri PUT edilir (secret alanlar BOS).
    await cred.saveIntegrationCredential(db, org, 'surat', {
      ...hydrated, kullaniciAdi: '', sifre: '', webPassword: '',
    })
  }
  const finalRow = await cred.getIntegrationCredential(db, org, 'surat')
  assert.equal(finalRow.serviceMode, CANONICAL, 'tekrarli tur modu bozmamali')
  assert.equal(finalRow.kullaniciAdi, 'TEST_CUSTOMER_2622', 'cari kodu korunmali')
})

// ═══ 5. ILGISIZ KAYDETME KANONIGI BOZMAZ (§12 REGRESSION) ═════════════════

test('RT-5: Surat DISI ayar kaydetmek kanonik modu GERI CEVIRMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka', 'monalisatoka')
  await cred.saveIntegrationCredential(db, org, 'surat', UI_CANONICAL_SAVE)

  // Kullanici yalnizca Trendyol tarafini kaydediyor.
  await cred.saveIntegrationCredential(db, org, 'trendyol', {
    sellerId: '277221', apiKey: 'K', apiSecret: 'S', environment: 'prod',
  })
  const surat = await cred.getIntegrationCredential(db, org, 'surat')
  assert.equal(surat.serviceMode, CANONICAL, 'Surat kaydi etkilenmemeli')

  // Ayni tur icinde Surat da PUT ediliyor (uygulama tum config'i gonderir):
  // hydrate edilmis form kanonik oldugu icin mod korunur.
  const status = await cred.getMaskedIntegrationStatus(db, org)
  await cred.saveIntegrationCredential(db, org, 'surat', {
    ...hydrateSuratFromStatus(status.surat), kullaniciAdi: '', sifre: '',
  })
  const after = await cred.getIntegrationCredential(db, org, 'surat')
  assert.equal(after.serviceMode, CANONICAL)
})

// ═══ 6. BAYAT LEGACY ALANLAR KANONIGI EZMEZ ═══════════════════════════════

test('RT-6: kayitta bayat legacy serviceType olsa da kanonik KAZANIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka', 'monalisatoka')
  // Kanonik mod + BAYAT legacy serviceType/path ayni kayitta.
  await cred.saveIntegrationCredential(db, org, 'surat', {
    ...STORED_LEGACY,
    serviceMode: CANONICAL,
  })
  const status = await cred.getMaskedIntegrationStatus(db, org)
  assert.equal(status.surat.serviceMode, CANONICAL)
  const hydrated = hydrateSuratFromStatus(status.surat)
  // serviceMode SOURCE-OF-TRUTH: route ondan turetilir, bayat alandan DEGIL.
  assert.equal(hydrated.serviceMode, CANONICAL)
  assert.equal(hydrated.serviceType, 'SuratCanonicalWebApi')
})

// ═══ 7. LEGACY TENANT DEGISMEDI ═══════════════════════════════════════════

test('RT-7: legacy tenant round-trip AYNEN korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'LegacyTenant', 'legacytenant')
  await cred.saveIntegrationCredential(db, org, 'surat', STORED_LEGACY)

  const status = await cred.getMaskedIntegrationStatus(db, org)
  assert.equal(status.surat.serviceMode, LEGACY)
  assert.equal(hydrateSuratFromStatus(status.surat).serviceMode, LEGACY)
})

test('RT-8: serviceMode kaydi HIC yoksa varsayilan korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'OldRecord', 'oldrecord')
  // Eski kayit: serviceMode alani YOK.
  await cred.saveIntegrationCredential(db, org, 'surat', {
    kullaniciAdi: 'OLD_CUSTOMER', sifre: 'OLD_SECRET', ortam: 'live',
  })
  const status = await cred.getMaskedIntegrationStatus(db, org)
  assert.equal(status.surat.serviceMode, '', 'alan bos donmeli')
  // Gecersiz/bos mod → form varsayilani AYNEN kalir.
  assert.equal(hydrateSuratFromStatus(status.surat).serviceMode, LEGACY)
})

// ═══ 9. TENANT IZOLASYONU ═════════════════════════════════════════════════

test('RT-9: bir tenant kanonik olurken digeri legacy KALIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const canary = await makeOrg(db, 'MonalisaToka', 'monalisatoka')
  const other = await makeOrg(db, 'OtherTenant', 'othertenant')
  await cred.saveIntegrationCredential(db, canary, 'surat', UI_CANONICAL_SAVE)
  await cred.saveIntegrationCredential(db, other, 'surat', STORED_LEGACY)

  assert.equal(
    (await cred.getMaskedIntegrationStatus(db, canary)).surat.serviceMode, CANONICAL,
  )
  assert.equal(
    (await cred.getMaskedIntegrationStatus(db, other)).surat.serviceMode, LEGACY,
  )
})
