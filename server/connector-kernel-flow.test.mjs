// CONNECTOR-KERNEL-001 — sağlayıcı-nötr çekirdek kabul testleri.
//
// EN ÖNEMLİ TEST BURADA DEĞİL BİR PARİTE TESTİDİR: yeni çekirdek, ÜRETİMDEKİ
// `marketplaceScopeKey` çıktısını BİT DÜZEYİNDE korumak zorundadır. Kapsam
// anahtarı değişirse Trendyol siparişleri "yeni kayıt" gibi görünür ve
// duplicate üretir — bu, bu depoda DAHA ÖNCE ÖLÇÜLMÜŞ bir kusur sınıfıdır.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))

const kernel = await import('./connectors/connectorKernel.ts')
const identity = await import('./connectors/canonicalIdentity.ts')
const legacySeam = await import('./marketplaces/marketplaceOrderSource.ts')

function descriptor(over = {}) {
  return {
    providerKey: 'woocommerce',
    kind: 'commerce_platform',
    displayName: 'WooCommerce',
    capabilities: [
      kernel.declareCapability('orders.read', { stage: 'ga' }),
      kernel.declareCapability('products.read', { stage: 'shadow' }),
      kernel.declareCapability('orders.status.write', {
        supported: false,
        reason: 'Sözleşme doğrulanmadı.',
      }),
    ],
    ...over,
  }
}

// ── YETENEK ≠ BAĞLANTI ─────────────────────────────────────────────────────

test('CK-1: beyan EDILMEMIS yetenek DESTEKLENMIYOR sayilir (varsayilan kapali)', () => {
  const d = descriptor()
  assert.equal(kernel.supportsCapability(d, 'inventory.write'), false)
  assert.equal(kernel.findCapability(d, 'inventory.write'), null)
})

test('CK-2: sozlesmesi DOGRULANMAMIS yetenek "destekleniyor" GOSTERILMEZ', () => {
  const d = descriptor({
    capabilities: [
      kernel.declareCapability('orders.read', { stage: 'ga', contractVerified: false }),
    ],
  })
  assert.equal(
    kernel.supportsCapability(d, 'orders.read'),
    false,
    'resmi dokumanla kanitlanmamis yetenek UIda DESTEKLENIYOR olamaz',
  )
})

test('CK-3: desteklenmeyen yetenek SEBEP tasir ("bilmiyoruz" ile ayni sey degil)', () => {
  const found = kernel.findCapability(descriptor(), 'orders.status.write')
  assert.equal(found.supported, false)
  assert.ok(found.reason && found.reason.length > 0, 'sebep zorunlu')
})

// ── BÜYÜK PATLAMA YOK ──────────────────────────────────────────────────────

test('CK-4: shadow asamasi CANLI davranisa DOKUNAMAZ', () => {
  const d = descriptor()
  // Beyan edilmiş ve doğrulanmış, AMA aşaması shadow.
  assert.equal(kernel.supportsCapability(d, 'products.read'), true)
  assert.equal(
    kernel.capabilityIsLive(d, 'products.read'),
    false,
    'shadow okur/normallestirir ama canli sevkiyati ETKILEMEZ',
  )
  assert.equal(kernel.capabilityIsLive(d, 'orders.read'), true, 'ga canli')
  for (const stage of ['off', 'internal_test', 'shadow']) {
    assert.equal(kernel.stageAffectsLiveBehavior(stage), false, `${stage} canli DEGIL`)
  }
  for (const stage of ['pilot', 'ga']) {
    assert.equal(kernel.stageAffectsLiveBehavior(stage), true, `${stage} canli`)
  }
})

// ── KAYIT DEFTERİ ──────────────────────────────────────────────────────────

test('CK-5: kayit defteri — cift kayit ve yinelenen yetenek REDDEDILIR', () => {
  const registry = new kernel.ConnectorRegistry()
  registry.register(descriptor())
  assert.throws(() => registry.register(descriptor()), /zaten kayıtlı/)
  assert.throws(
    () =>
      registry.register(
        descriptor({
          providerKey: 'ikas',
          capabilities: [
            kernel.declareCapability('orders.read'),
            kernel.declareCapability('orders.read'),
          ],
        }),
      ),
    /Yinelenen yetenek/,
  )
})

test('CK-6: kayit defteri aileye gore listeler ve anahtari NORMALLESTIRIR', () => {
  const registry = new kernel.ConnectorRegistry()
  registry.register(descriptor({ providerKey: '  WooCommerce  ' }))
  registry.register(
    descriptor({ providerKey: 'surat', kind: 'shipping', displayName: 'Sürat Kargo' }),
  )
  assert.ok(registry.get('WOOCOMMERCE'), 'buyuk/kucuk harf ve bosluk onemsiz')
  assert.deepEqual(
    registry.list('commerce_platform').map((d) => d.providerKey),
    ['woocommerce'],
  )
  assert.deepEqual(registry.list('shipping').map((d) => d.providerKey), ['surat'])
  assert.equal(registry.list().length, 2)
})

// ── KANONİK KİMLİK ─────────────────────────────────────────────────────────

test('CK-7: PARITE — mevcut pazaryeri kapsam anahtari BIT DUZEYINDE korunur', () => {
  const cases = [
    { providerKey: 'trendyol', marketplaceAccountId: 'acc-1', marketplacePackageId: 'PKG-1' },
    { providerKey: 'Trendyol', marketplaceAccountId: null, marketplacePackageId: 'PKG-2' },
    { providerKey: 'n11', marketplaceAccountId: '  ', marketplacePackageId: '  P3  ' },
  ]
  for (const input of cases) {
    assert.equal(
      identity.marketplaceCompatibleScopeKey(input),
      legacySeam.marketplaceScopeKey(input),
      `kapsam anahtari DEGISTI: ${JSON.stringify(input)}`,
    )
  }
})

test('CK-8: kimlik KIRACISIZ, SAGLAYICISIZ veya BOS id ile URETILMEZ', () => {
  const base = {
    organizationId: 'org-1',
    providerKey: 'woocommerce',
    storeAccountId: 'store-1',
    entityType: 'order',
    externalId: '1001',
  }
  assert.ok(identity.canonicalIdentityKey(base))
  for (const broken of [
    { ...base, organizationId: '' },
    { ...base, providerKey: '  ' },
    { ...base, externalId: '' },
    { ...base, externalId: '   ' },
  ]) {
    assert.throws(
      () => identity.canonicalIdentityKey(broken),
      identity.UnstableIdentityError,
      `kimlik uretilmemeliydi: ${JSON.stringify(broken)}`,
    )
  }
})

test('CK-9: kimlik parcalari BIRBIRINE TASMAZ (ayrac kacisi)', () => {
  // İki FARKLI varlık, naif birleştirmede AYNI anahtara düşerdi.
  const a = identity.canonicalIdentityKey({
    organizationId: 'org',
    providerKey: 'ikas',
    storeAccountId: 'a::b',
    entityType: 'order',
    externalId: 'c',
  })
  const b = identity.canonicalIdentityKey({
    organizationId: 'org',
    providerKey: 'ikas',
    storeAccountId: 'a',
    entityType: 'order',
    externalId: 'b::c',
  })
  assert.notEqual(a, b, 'parca sinirlari KORUNMALI')
})

test('CK-10: DEGISKEN alandan kimlik uretimi DERHAL reddedilir', () => {
  for (const stable of ['id', 'orderId', 'external_id', 'sku', 'packageId']) {
    identity.assertIdentityFieldIsStable(stable)
  }
  for (const mutable of ['name', 'productName', 'title', 'display_name', 'label', 'description']) {
    assert.throws(
      () => identity.assertIdentityFieldIsStable(mutable),
      identity.UnstableIdentityError,
      `kimlik alani olarak kabul EDILMEMELIYDI: ${mutable}`,
    )
  }
})

// ── AYNI MAĞAZANIN İKİ KEZ BAĞLANMASI ──────────────────────────────────────

test('CK-11: ayni magaza farkli YAZIMLARLA iki kez baglanamaz', () => {
  const variants = [
    'https://shop.example.com',
    'https://shop.example.com/',
    'https://www.shop.example.com',
    'HTTPS://Shop.Example.COM/',
    'https://shop.example.com:443',
  ]
  const fingerprints = new Set(
    variants.map((url) =>
      identity.storeFingerprint({ providerKey: 'woocommerce', externalStoreId: url }),
    ),
  )
  assert.equal(fingerprints.size, 1, `ayni magaza TEK parmak izi uretmeli: ${[...fingerprints]}`)

  // FARKLI mağazalar ayrışmalı.
  assert.notEqual(
    identity.storeFingerprint({ providerKey: 'woocommerce', externalStoreId: 'https://a.example.com' }),
    identity.storeFingerprint({ providerKey: 'woocommerce', externalStoreId: 'https://b.example.com' }),
  )
  // Aynı mağaza kimliği FARKLI sağlayıcıda ayrı kayıttır.
  assert.notEqual(
    identity.storeFingerprint({ providerKey: 'woocommerce', externalStoreId: 'store-1' }),
    identity.storeFingerprint({ providerKey: 'ikas', externalStoreId: 'store-1' }),
  )
})

test('CK-12: alt yol tasiyan magaza kimlikleri AYRI magazadir', () => {
  const root = identity.storeFingerprint({
    providerKey: 'woocommerce',
    externalStoreId: 'https://example.com',
  })
  const sub = identity.storeFingerprint({
    providerKey: 'woocommerce',
    externalStoreId: 'https://example.com/magaza',
  })
  assert.notEqual(root, sub, 'alt dizindeki WordPress kurulumu AYRI magazadir')
})

// ── MİMARİ KURAL ───────────────────────────────────────────────────────────

/**
 * Yorumları ve dize sabitlerini ÇIKARIR.
 *
 * Ham metinde arama YANILTIR: `'shipments.tracking.write'` bir YETENEK ADIDIR,
 * `shipments` modülüne çağrı DEĞİLDİR; ve "switch(provider) YASAK" diyen bir
 * YORUM, yasağın ihlali gibi görünürdü. Bu iki hata ilk koşuda gerçekten
 * oluştu — tarama bu yüzden koda indirgenir.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

test('CK-13: cekirdek MEVCUT uretim yollarini IMPORT ETMEZ (tamamen eklemeli)', () => {
  for (const file of ['connectorKernel.ts', 'canonicalIdentity.ts']) {
    const source = readFileSync(join(here, 'connectors', file), 'utf8')
    // Bağımlılık YALNIZ import satırlarından okunur.
    const imports = [...source.matchAll(/^\s*import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
    for (const specifier of imports) {
      assert.match(
        specifier,
        /^\.\/(connectorKernel|canonicalIdentity)\.ts$|^node:/,
        `${file} cekirdek disina bagimli: ${specifier}`,
      )
    }
    // Ağ/DB/üretim akışı çağrısı KOD içinde bulunmamalı.
    const code = codeOnly(source)
    for (const forbidden of ['persistSyncResult', 'printZpl', 'labelJobs', 'fetch(', 'drizzle']) {
      assert.equal(code.includes(forbidden), false, `${file} uretim yoluna dokunuyor: ${forbidden}`)
    }
  }
})

test('CK-14: yetenek sozlugu KAPALI — serbest dize yok', () => {
  assert.ok(kernel.CONNECTOR_CAPABILITIES.includes('orders.read'))
  assert.ok(kernel.CONNECTOR_CAPABILITIES.includes('shipments.tracking.write'))
  // Sözlükte olmayan bir yetenek aranınca sessizce "var" DEMEZ.
  assert.equal(kernel.supportsCapability(descriptor(), 'orders.telepathy'), false)
  assert.equal(new Set(kernel.CONNECTOR_CAPABILITIES).size, kernel.CONNECTOR_CAPABILITIES.length)
})

test('CK-15: switch(provider) blogu YOK — karar beyandan okunur', () => {
  const dir = join(here, 'connectors')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = codeOnly(readFileSync(join(dir, file), 'utf8'))
    assert.equal(
      /switch\s*\(\s*\w*[Pp]rovider/.test(source),
      false,
      `${file}: saglayiciya gore switch YASAK`,
    )
  }
})
