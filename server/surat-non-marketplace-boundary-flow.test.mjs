import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// P6 — PAZARYERI DISI (OWN_PLATFORM) SINIRI.
//
// DURUM (P6_AUDIT): kanonik model pazaryeri disi gonderiyi ZATEN tanimlar ve
// fail-closed dogrular, ama URETIMDE HICBIR CAGIRAN YOKTUR. Eksik olan tek sey
// vendor kurali: `OzelKargoTakipNo` pazaryeri disi gonderide NE olmalidir.
//
// Bu dosya o bosluga kod YAZMAZ. Sinirin ACIK ve FAIL-CLOSED kalmasini kilitler:
// referans uydurulup sessizce baglanamaz.
//
// Ag YOK, DB YOK, gercek tasiyici cagrisi YOK.

const here = dirname(fileURLToPath(import.meta.url))
const MODEL = await import('./shipments/suratCanonicalGonderiModel.ts')

/* ═══ MODEL PAZARYERI DISI GONDERIYI TANIR ══════════════════════════ */

test('NM-1: pazaryeri disi baglam pazaryerimi=0 ve entegrasyonFirmasi bos', () => {
  const ctx = MODEL.resolveSuratMarketplaceContext(
    { marketplace: 'KendiSitem' },
    { ownPlatformReference: 'CF-REF-001' },
  )
  assert.equal(ctx.isMarketplace, false)
  assert.equal(ctx.marketplace, 'OWN_PLATFORM')
  assert.equal(ctx.pazaryerimi, 0)
  assert.equal(ctx.entegrasyonFirmasi, '')
  assert.equal(ctx.ozelKargoTakipNo, 'CF-REF-001')
  assert.equal(ctx.trackingSource, 'ownPlatformReference')
})

/* ═══ REFERANS YOKSA FAIL-CLOSED ════════════════════════════════════ */

test('NM-2: referans verilmezse gonderi GECERSIZDIR', () => {
  const ctx = MODEL.resolveSuratMarketplaceContext({ marketplace: 'KendiSitem' })
  assert.equal(ctx.ozelKargoTakipNo, '')
  const check = MODEL.validateSuratBillingContext(ctx)
  assert.equal(check.valid, false, 'referanssiz gonderi gecerli sayildi')
  assert.equal(check.errorCode, 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING')
})

test('NM-3: pazaryeri disi gonderide entegrasyonFirmasi DOLDURULAMAZ', () => {
  // Pazaryeri olmayan gonderiyi pazaryeri gibi faturalamak = yanlis cari.
  const check = MODEL.validateSuratBillingContext({
    isMarketplace: false,
    marketplace: 'OWN_PLATFORM',
    pazaryerimi: 0,
    entegrasyonFirmasi: 'Trendyol',
    ozelKargoTakipNo: 'CF-REF-001',
    trackingSource: 'ownPlatformReference',
  })
  assert.equal(check.valid, false)
  assert.equal(check.errorCode, 'SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID')
})

/* ═══ SINIR: REFERANS URETICISI YOK ve SESSIZCE EKLENEMEZ ═══════════ */

test('NM-4: pazaryeri disi referans URETICISI repoda YOK', () => {
  // Vendor kurali (format/tekillik) DOGRULANMADAN uretici yazmak, Surat'in
  // borclandirma siniflandirmasini bozma riskidir — model bunu acikca reddeder.
  const model = readFileSync(
    join(here, 'shipments', 'suratCanonicalGonderiModel.ts'), 'utf8',
  )
  assert.match(model, /burada yeni üretici yazılmaz/)

  // Uretim kodunda `ownPlatformReference` CAGIRANI OLMAMALI. Varsa ya vendor
  // kurali dogrulanmistir (o zaman P6 acilir ve bu test guncellenir) ya da
  // referans UYDURULMUSTUR (o zaman bu test dogru sekilde duser).
  const productionCallers = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx|mjs)$/.test(entry.name)) continue
      if (/\.test\.(mjs|ts|tsx)$/.test(entry.name)) continue
      if (entry.name === 'suratCanonicalGonderiModel.ts') continue
      if (readFileSync(full, 'utf8').includes('ownPlatformReference')) {
        productionCallers.push(full)
      }
    }
  }
  walk(join(here))
  walk(join(here, '..', 'src'))
  assert.deepEqual(
    productionCallers, [],
    `pazaryeri disi yol baglanmis: ${productionCallers.join(', ')}`,
  )
})
