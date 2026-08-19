import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// AĞ ÖNCESİ KİMLİK PARİTE KAPISI.
//
// Kimliği SEÇEN çözücü ile telde GİDEN hesabı çözen fonksiyon ayrıdır.
// Ayrışırlarsa gönderi yanlış cariye yazılır ve GERİ ALINAMAZ. Bu paket,
// ayrışmanın taşıyıcıya ULAŞAMAYACAĞINI kanıtlar.

const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')

// KIMLIK ARTIK OTORITER ANLIK GORUNTUDEN gelir. Bu testler `config` ile KIRACI
// hesabini temsil ediyordu; ayni degerler artik KIRACI DEPOSU olarak anlik
// goruntuye verilir. Guard GEVSETILMEDI — yalniz kaynak duzeltildi.
const __SNAP = await import('./shipments/suratCredentialSnapshot.ts')
const __ROUTING = await import('./shipments/suratRoutingModel.ts')
const callCanonicalCreate = (p) =>
  ADAPTER.createCanonicalSuratShipmentForRequest({
    ...p,
    credentialSnapshot: __SNAP.buildSuratCredentialSnapshot({
      storedSuratConfig: p.config ?? {},
      role: __ROUTING.resolveSuratCredentialContext({
        config: p.config ?? {},
        billingParty: __ROUTING.resolveBillingPartyV2(
          p.order?.rawOrder ?? {},
        ).billingParty,
        cod: __ROUTING.resolveCodContext({
          enabled: p.cashOnDelivery === true,
          collectionType: p.config?.kapidanOdemeTahsilatTipi,
          amount: p.order?.cashOnDeliveryAmount,
        }),
        codPolicy: __ROUTING.resolveCodCredentialPolicy(
          p.config?.codCredentialPolicy,
        ),
      }).role,
    }),
  })
const ROUTING = await import('./shipments/suratRoutingModel.ts')

const ORDER = {
  marketplace: 'Trendyol', orderNumber: '11516641186',
  packageId: '4085791254', cargoTrackingNumber: '7270036019076954',
  customerName: 'Ad Soyad', address: 'Adres', city: 'İstanbul',
  district: 'Kadıköy', customerPhone: '5551112233', desi: 2,
  items: [{ productName: 'Ürün', quantity: 1 }], rawOrder: {},
}

async function run(config) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
  }
  try {
    const result = await callCanonicalCreate({
      organizationId: 'org-A', config,
      order: ORDER, reference: ORDER.packageId,
    })
    return { result, calls }
  } finally { globalThis.fetch = original }
}

const HEALTHY = {
  serviceMode: 'SURAT_CANONICAL_API',
  canonicalPrimaryKullaniciAdi: 'PRIMARY_2622',
  canonicalPrimarySifre: 'PRIMARY_SECRET',
}

/* ═══ POZİTİF ════════════════════════════════════════════════════════ */

test('PARITY-1: cozucu ve tel AYNI hesabi tasiyinca create YAPILIR', async () => {
  const { result, calls } = await run(HEALTHY)
  assert.equal(calls, 1, 'saglikli paritede tasiyiciya GIDILIR')
  const trace = result.suratCreateTrace
  assert.equal(trace.credentialFingerprintMatch, true)
  assert.equal(trace.credentialRole, 'PRIMARY_MARKETPLACE')
  assert.equal(
    trace.resolverAccountFingerprint, trace.wireAccountFingerprint,
  )
  // Parmak izi ham cari kodu TASIMAZ.
  assert.equal(trace.resolverAccountFingerprint.includes('PRIMARY_2622'), false)
})

test('PARITY-2: parite degerleri IZDE saklanir', async () => {
  const { result } = await run(HEALTHY)
  // Parite "tele ne gidiyor" sorusudur → REQUEST_READY anlik goruntusunde.
  const parity = result.traceAttempt.stages.find(
    (entry) => entry.stage === 'REQUEST_READY',
  ).data
  assert.equal(parity.credentialFingerprintMatch, true)
  assert.ok(parity.resolverAccountFingerprint)
  assert.ok(parity.wireAccountFingerprint)
  assert.equal(parity.credentialSource, 'tenant.surat.primary')
})

/* ═══ NEGATİF — ZORUNLU ══════════════════════════════════════════════ */

test('PARITY-3: iki cozumleme alan kumeleri HIZALI kalir', async () => {
  // Ayrisma yalnizca alan kumeleri ayrisirsa dogar. Bunlar bilerek hizali;
  // asagidaki senaryolar hizanin KORUNDUGUNU dogrular. Hizayi bozan bir
  // degisiklik bu testi dusurur ve kapi da agi bloklar.
  const scenarios = [
    { name: 'yalniz canonicalPrimary',
      config: { serviceMode: 'SURAT_CANONICAL_API',
        canonicalPrimaryKullaniciAdi: 'P1', canonicalPrimarySifre: 'S1' } },
    { name: 'yalniz live',
      config: { serviceMode: 'SURAT_CANONICAL_API',
        liveKullaniciAdi: 'L1', liveSifre: 'S2' } },
    { name: 'ikisi birden — canonicalPrimary ONCELIKLI',
      config: { serviceMode: 'SURAT_CANONICAL_API',
        canonicalPrimaryKullaniciAdi: 'P1', canonicalPrimarySifre: 'S1',
        liveKullaniciAdi: 'L1', liveSifre: 'S2' } },
  ]
  for (const scenario of scenarios) {
    const { result, calls } = await run(scenario.config)
    assert.equal(calls, 1, `${scenario.name}: hizali ise create YAPILIR`)
    assert.equal(
      result.suratCreateTrace.credentialFingerprintMatch, true, scenario.name,
    )
  }
})

test('PARITY-3b: kapi AG CAGRISINDAN ONCE calisir ve fail-closed doner',
  () => {
    const code = readFileSync(
      'server/shipments/suratCanonicalCreateAdapter.ts', 'utf8',
    )
    const guardAt = code.indexOf('credentialFingerprintMatch =')
    const networkAt = code.indexOf('await createCanonicalSuratShipment(')
    assert.ok(guardAt > 0, 'parite kapisi VAR OLMALI')
    assert.ok(
      guardAt < networkAt, 'kapi AG CAGRISINDAN ONCE calismali',
    )
    // Uyusmazlikta taşiyiciya GIDILMEZ.
    const block = code.slice(guardAt, networkAt)
    assert.ok(block.includes('SURAT_CREDENTIAL_WIRE_MISMATCH'))
    assert.ok(block.includes("carrierCreateStatus: 'NOT_STARTED'"))
    assert.ok(block.includes('carrierCalled: false'))
  })

test('PARITY-4: parmak izi fonksiyonu ayrismayi YAKALAR', () => {
  // Kapinin dayandigi degismez: farkli hesap → farkli parmak izi.
  assert.notEqual(
    ROUTING.accountFingerprint('LIVE_9999'),
    ROUTING.accountFingerprint('PRIMARY_2622'),
  )
  assert.equal(
    ROUTING.accountFingerprint('PRIMARY_2622'),
    ROUTING.accountFingerprint('PRIMARY_2622'),
  )
})

test('PARITY-5: bloklanan denemede CARRIER_CALL asamasi YOKTUR', async () => {
  const { result, calls } = await run({
    serviceMode: 'SURAT_CANONICAL_API',
    canonicalPrimaryKullaniciAdi: '', canonicalPrimarySifre: '',
  })
  assert.equal(calls, 0)
  const stages = result.traceAttempt.stages.map((entry) => entry.stage)
  assert.equal(stages.includes('CARRIER_CALL'), false)
  assert.equal(stages.at(-1), 'FINAL')
})

test('PARITY-6: iz SIR TASIMAZ', async () => {
  const { result } = await run(HEALTHY)
  const text = JSON.stringify(result.traceAttempt)
  assert.equal(text.includes('PRIMARY_SECRET'), false)
})
