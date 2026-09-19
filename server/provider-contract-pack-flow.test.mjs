// SAĞLAYICI SÖZLEŞME PAKETİ (CONTRACT PACK) KABUL TESTLERİ.
//
// ═══ BU DOSYANIN AMACI ═══════════════════════════════════════════════════
//
// Sözleşme paketi bir BELGE DEĞİL, bir KİLİTTİR. Amacı: gelecekte bir
// sağlayıcı dokümanı değiştiğinde ya da biri "şunu da destekliyoruz" diye
// bir yetenek açtığında, bunun SESSİZCE olmasını engellemek.
//
// En sert kural DÜRÜSTLÜK KURALIDIR: resmî kaynakla doğrulanmamış hiçbir
// yetenek `contractVerified: true` olamaz. Ticket'in dediği gibi — "A partial
// connector with honest capabilities is better than false support."
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const kernel = await import('./connectors/connectorKernel.ts')

const PACKS = {
  woocommerce: 'providers/woocommerce/contracts/wc-v3.json',
  ikas: 'providers/ikas/contracts/admin-v1.json',
  ticimax: 'providers/ticimax/contracts/siparisservis-v1.json',
}

function loadPack(provider) {
  const path = join(root, PACKS[provider])
  assert.ok(existsSync(path), `sözleşme paketi yok: ${PACKS[provider]}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

const REQUIRED_SECTIONS = [
  'PROVIDER', 'SOURCE_URLS', 'RETRIEVED_AT', 'API_VERSION', 'AUTH_MODEL',
  'IDENTITY_FIELDS', 'PAGINATION', 'RATE_LIMITS', 'WEBHOOK_MODEL',
  'WEBHOOK_SIGNATURE', 'ORDER_STATUSES', 'ORDER_MODEL',
  'RETRY_MODEL', 'ERROR_MODEL', 'DATE_TIMEZONE_RULES', 'MONEY_RULES',
  'PHONE_ADDRESS_FIELDS', 'CAPABILITIES',
]

// ── PAKET BÜTÜNLÜĞÜ ────────────────────────────────────────────────────────

test('CP-1: her paket ZORUNLU bolumleri tasir', () => {
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    for (const section of REQUIRED_SECTIONS) {
      assert.ok(section in pack, `${provider}: eksik bolum ${section}`)
    }
    assert.equal(pack.PROVIDER, provider)
    assert.match(pack.RETRIEVED_AT, /^\d{4}-\d{2}-\d{2}$/, `${provider}: RETRIEVED_AT tarihi`)
  }
})

test('CP-2: kaynaklar RESMI alan adlarindan — blog/forum/entegrator YOK', () => {
  const OFFICIAL = [
    'woocommerce.github.io', 'developer.woocommerce.com', 'woocommerce.com',
    'ikas.dev', 'ticimax.com',
  ]
  const FORBIDDEN = ['stackoverflow', 'medium.com', 'blogspot', 'wordpress.org/support', 'expressai', 'entegrago', 'dopigo', 'sentos']
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    assert.ok(Array.isArray(pack.SOURCE_URLS) && pack.SOURCE_URLS.length > 0, `${provider}: kaynak yok`)
    for (const url of pack.SOURCE_URLS) {
      assert.ok(
        OFFICIAL.some((domain) => url.includes(domain)),
        `${provider}: resmi olmayan kaynak ${url}`,
      )
      for (const bad of FORBIDDEN) {
        assert.equal(url.includes(bad), false, `${provider}: yasakli kaynak ${url}`)
      }
      assert.match(url, /^https:\/\//, `${provider}: kaynak HTTPS olmali`)
    }
  }
})

// ── DÜRÜSTLÜK KURALI ───────────────────────────────────────────────────────

test('CP-3: DOGRULANMAMIS yetenek "destekleniyor" OLARAK ACILAMAZ', () => {
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    for (const [name, decl] of Object.entries(pack.CAPABILITIES)) {
      assert.ok(
        kernel.CONNECTOR_CAPABILITIES.includes(name),
        `${provider}: sozlukte olmayan yetenek ${name}`,
      )
      if (decl.supported === true) {
        assert.equal(
          decl.contractVerified,
          true,
          `${provider}/${name}: DESTEKLENIYOR ama sozlesme dogrulanmamis — YASAK`,
        )
      }
      if (decl.supported === false) {
        assert.ok(
          typeof decl.reason === 'string' && decl.reason.length > 0,
          `${provider}/${name}: desteklenmiyorsa SEBEP zorunlu`,
        )
      }
      if (decl.stage) {
        assert.ok(
          kernel.CAPABILITY_STAGES.includes(decl.stage),
          `${provider}/${name}: gecersiz asama ${decl.stage}`,
        )
      }
    }
  }
})

test('CP-4: WAVE-1de HICBIR yetenek pilot/ga degil (buyuk patlama yok)', () => {
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    for (const [name, decl] of Object.entries(pack.CAPABILITIES)) {
      if (!decl.stage) continue
      assert.equal(
        kernel.stageAffectsLiveBehavior(decl.stage),
        false,
        `${provider}/${name}: WAVE-1de CANLI asamaya alinamaz (${decl.stage})`,
      )
    }
  }
})

test('CP-5: her YAZMA yetenegi WAVE-1de KAPALI', () => {
  const writes = ['orders.status.write', 'products.write', 'inventory.write', 'shipments.tracking.write']
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    for (const name of writes) {
      const decl = pack.CAPABILITIES[name]
      if (!decl) continue
      assert.equal(decl.stage ?? 'off', 'off', `${provider}/${name}: yazma yolu ACIK olamaz`)
    }
  }
})

// ── SAĞLAYICIYA ÖZEL, KANITA DAYALI KİLİTLER ───────────────────────────────

test('CP-6: WooCommerce webhook imzasi DOGRULANMIS ve TAM tanimli', () => {
  const pack = loadPack('woocommerce')
  const sig = pack.WEBHOOK_SIGNATURE
  assert.equal(sig.verified, true)
  assert.equal(sig.header, 'X-WC-Webhook-Signature')
  assert.equal(sig.algorithm, 'HMAC-SHA256')
  assert.equal(sig.encoding, 'base64')
  assert.ok(sig.computedOver.includes('gövde'), 'imza GOVDE uzerinden hesaplanir')
  assert.equal(pack.CAPABILITIES['orders.webhook'].contractVerified, true)
  // 5 basarisiz teslimde webhook KAPANIR → 2xx donmek zorunlu.
  assert.match(pack.RETRY_MODEL.providerSide, /5/)
  assert.ok(pack.RETRY_MODEL.cargoflowImplication.includes('200'))
})

test('CP-7: ikas webhook imzasi DOGRULANAMADI → yetenek KAPALI, uydurma YOK', () => {
  const pack = loadPack('ikas')
  assert.equal(pack.WEBHOOK_SIGNATURE.verified, false)
  assert.equal(pack.WEBHOOK_SIGNATURE.header, null, 'imza basligi UYDURULMAMALI')
  assert.equal(pack.WEBHOOK_SIGNATURE.algorithm, null)
  assert.equal(
    pack.CAPABILITIES['orders.webhook'].supported,
    false,
    'imzasi dogrulanmamis webhook ACILAMAZ',
  )
  // Doğruluk sigortası: updatedAt mutabakatı DOĞRULANMIŞ olmalı.
  assert.equal(pack.ORDER_LIST.checkpointFilter.verified, true)
  assert.match(pack.ORDER_LIST.checkpointFilter.value, /updatedAt/)
})

test('CP-8: Ticimax webhook SUNMUYOR → yoklama ZORUNLU, imza konusu YOK', () => {
  const pack = loadPack('ticimax')
  assert.equal(pack.WEBHOOK_MODEL.supported, false)
  assert.equal(pack.WEBHOOK_MODEL.verified, true, 'yoklugu KANITLANMIS olmali')
  assert.equal(pack.WEBHOOK_SIGNATURE.applicable, false)
  assert.equal(pack.CAPABILITIES['orders.webhook'].supported, false)
  assert.match(pack.WEBHOOK_MODEL.consequence, /yoklama|polling/i)
})

test('CP-9: Ticimax TARIH SAAT DILIMI belirsiz → CEVRIM ACILMAZ', () => {
  const pack = loadPack('ticimax')
  assert.equal(
    pack.DATE_TIMEZONE_RULES.verified,
    false,
    'saat dilimi dogrulanmadi olarak isaretli kalmali',
  )
  assert.ok(
    pack.DATE_TIMEZONE_RULES.DECISION.includes('TAHMİN EDİLMEZ'),
    'belirtilmemis saat dilimi VARSAYILMAZ — Trendyol kusurunun kok nedeni buydu',
  )
})

test('CP-10: WooCommerce kanonik tarih GMT alanidir, yerel alan DEGIL', () => {
  const pack = loadPack('woocommerce')
  assert.match(pack.DATE_TIMEZONE_RULES.canonicalField, /gmt/i)
  assert.match(pack.DATE_TIMEZONE_RULES.forbidden, /date_created\b/)
  assert.equal(pack.DATE_TIMEZONE_RULES.verified, true)
})

test('CP-11: DOGRULANMAMIS her bolum NOT tasir (sessiz bosluk yok)', () => {
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    for (const [section, value] of Object.entries(pack)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (value.verified === false) {
        const explained =
          typeof value.note === 'string' ||
          typeof value.DECISION === 'string' ||
          typeof value.reason === 'string'
        assert.ok(explained, `${provider}/${section}: dogrulanmadi ama SEBEP/NOT yok`)
      }
    }
  }
})

test('CP-12: acik sorular LISTELENMIS (bilinmeyen gorunur olmali)', () => {
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    assert.ok(Array.isArray(pack.OPEN_QUESTIONS), `${provider}: OPEN_QUESTIONS yok`)
  }
  // Ticimax pilot engeli ACIKCA yazili olmali.
  assert.match(loadPack('ticimax').PILOT_BLOCKER, /UyeKodu|WSDL/)
})

test('CP-13: kimlik alanlari KARARLI (ad/baslik kimlik degil)', async () => {
  const identity = await import('./connectors/canonicalIdentity.ts')
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    for (const [role, field] of Object.entries(pack.IDENTITY_FIELDS)) {
      if (typeof field !== 'string') continue
      if (['note', 'stableIdVerified'].includes(role)) continue
      // Alan adı bir cümle olabilir; yalnız TEK KELİMELİK alan adlarını sına.
      if (/^[A-Za-z_][A-Za-z0-9_.\[\]]*$/.test(field)) {
        identity.assertIdentityFieldIsStable(field.replace(/.*\./, '').replace(/\[\]/g, ''))
      }
    }
  }
})

test('CP-14: paket KERNEL sozlugu ile tutarli — her yetenek beyani cevrilebilir', () => {
  for (const provider of Object.keys(PACKS)) {
    const pack = loadPack(provider)
    const descriptor = {
      providerKey: provider,
      kind: pack.PROVIDER_KIND,
      displayName: pack.DISPLAY_NAME,
      capabilities: Object.entries(pack.CAPABILITIES).map(([name, decl]) =>
        kernel.declareCapability(name, {
          supported: decl.supported,
          contractVerified: decl.contractVerified,
          stage: decl.stage ?? 'off',
          ...(decl.reason ? { reason: decl.reason } : {}),
        }),
      ),
    }
    assert.ok(kernel.PROVIDER_KINDS.includes(descriptor.kind), `${provider}: gecersiz aile`)
    // Kayıt defteri beyanı KABUL ETMELİ (yinelenen/çakışan yetenek yok).
    const registry = new kernel.ConnectorRegistry()
    registry.register(descriptor)
    assert.ok(registry.get(provider))
    // Hiçbir yetenek CANLI olmamalı.
    for (const name of kernel.CONNECTOR_CAPABILITIES) {
      assert.equal(kernel.capabilityIsLive(descriptor, name), false, `${provider}/${name} canli`)
    }
  }
})
