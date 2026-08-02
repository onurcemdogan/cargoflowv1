import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// Sürat resmî ZPL teşhisi (SALT OKUNUR) sözleşmesi.
// Tüm ZPL örnekleri SENTETİKTİR; gerçek müşteri verisi veya secret İÇERMEZ.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const {
  classifySuratLabelArtifact,
  decideSuratZplReadiness,
  extractSuratLabelArtifact,
  fingerprintZpl,
  summarizeSuratZplDiagnostic,
} = await import('./integrations/suratZplDiagnostic.ts')

const TNO = '25220148446193'
const BARCODE = '01231201025'

const OFFICIAL_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL799',
  '^FO40,20^A0N,28,28^FDSube: MERKEZ^FS',
  `^FO500,20^A0N,26,26^FDT.No: ${TNO}^FS`,
  `^FO60,120^BY3^BCN,140,Y,N,N^FD${BARCODE}^FS`,
  `^FO60,560^BQN,2,6^FDLA,${BARCODE}^FS`,
  '^XZ',
].join('\n')

const WEB_ONLY_ZPL =
  '^XA^PW799^LL799^FO60,120^BCN,140,Y,N,N^FDWeb3952033136^FS' +
  '^FO60,700^A0N,20,20^FDDahili^FS^XZ'

const LEGACY_GENERATED_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL799',
  '^FO24,0^A0B,22,22^FDSiparis No: 7270000000000001^FS',
  `^FO60,120^BY3^BCN,140,Y,N,N^FD${BARCODE}^FS`,
  `^FO500,20^A0N,26,26^FDT.No: ${TNO}^FS`,
  '^FO56,660^A0N,18,18^FDTop Ds/Kg^FS',
  '^XZ',
].join('\n')

const expect = { trackingNumber: TNO, barcode: BARCODE }
const classOf = (over) =>
  classifySuratLabelArtifact({ ...expect, ...over }).primaryClass

// ── 1..8: sınıflandırma sözleşmesi ────────────────────────────────────────

test('SZD-1: geçerli tek sayfa resmî ZPL → validOfficialZpl', () => {
  const c = classifySuratLabelArtifact({
    ...expect,
    barcodeRaw: OFFICIAL_ZPL,
    zplSource: 'surat.ortakBarkod.BarcodeRaw',
  })
  assert.equal(c.primaryClass, 'validOfficialZpl')
  assert.equal(c.zplSourceBucket, 'surat.ortakBarkod.BarcodeRaw')
  assert.equal(c.fingerprint.length, 12)
  assert.equal(c.fingerprint, fingerprintZpl(OFFICIAL_ZPL))
})

test('SZD-2: yalnız Web... iç kod → webInternalCodeOnly', () => {
  assert.equal(classOf({ barcodeRaw: WEB_ONLY_ZPL }), 'webInternalCodeOnly')
})

test('SZD-3: boş/eksik BarcodeRaw → missingBarcodeRaw', () => {
  for (const raw of ['', '   ', null, undefined, 42]) {
    assert.equal(classOf({ barcodeRaw: raw }), 'missingBarcodeRaw')
  }
  assert.equal(
    classifySuratLabelArtifact({ ...expect, barcodeRaw: '' }).fingerprint,
    '',
    'içerik yoksa parmak izi de yok',
  )
})

test('SZD-4: HTML/JSON hata gövdesi ve ZPL olmayan metin → invalidEnvelope', () => {
  const bodies = [
    '<!DOCTYPE html><html><body>Gateway Timeout</body></html>',
    '{"isError":true,"Message":"014"}',
    '[{"error":"x"}]',
    'PLAIN TEXT LABEL',
    '^XA kirik',
    '^XA^XZ',
  ]
  for (const body of bodies) {
    assert.equal(classOf({ barcodeRaw: body }), 'invalidEnvelope', body.slice(0, 24))
  }
})

test('SZD-5: çoklu ^XA/^XZ → multiPageProviderZpl', () => {
  assert.equal(
    classOf({ barcodeRaw: OFFICIAL_ZPL + '\n' + OFFICIAL_ZPL }),
    'multiPageProviderZpl',
  )
})

test('SZD-6: T.No/barkod uyuşmazlığı → trackingEvidenceMismatch', () => {
  const foreign = OFFICIAL_ZPL
    .replaceAll(BARCODE, '09999999999')
    .replaceAll(TNO, '99999999999999')
  assert.equal(classOf({ barcodeRaw: foreign }), 'trackingEvidenceMismatch')
})

test('SZD-7: resmî PDF var, ZPL yok → officialPdfAvailable + missingBarcodeRaw', () => {
  const c = classifySuratLabelArtifact({
    ...expect,
    barcodeRaw: '',
    hasPdfBarkod: true,
    pdfBarkodLength: 48_000,
  })
  assert.equal(c.primaryClass, 'missingBarcodeRaw')
  assert.equal(c.officialPdfAvailable, true, 'PDF ayrı bir eksen olarak sayılır')
})

test('SZD-8: eski CargoFlow generated şablonu → persistedGeneratedLegacyZpl', () => {
  // zplSource açıkça 'generated'
  assert.equal(
    classOf({ barcodeRaw: OFFICIAL_ZPL, zplSource: 'generated' }),
    'persistedGeneratedLegacyZpl',
  )
  // zplSource kayıp olsa bile şablon imzasından tanınır (resmî sayılmaz)
  assert.equal(
    classOf({ barcodeRaw: LEGACY_GENERATED_ZPL, zplSource: '' }),
    'persistedGeneratedLegacyZpl',
  )
})

// ── aggregate + karar ─────────────────────────────────────────────────────

test('SZD-9: aggregate sayaçlar ve zplSourceBuckets doğru toplanır', () => {
  const report = summarizeSuratZplDiagnostic([
    { ...expect, barcodeRaw: OFFICIAL_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw' },
    { ...expect, barcodeRaw: OFFICIAL_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw' },
    { ...expect, barcodeRaw: WEB_ONLY_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw' },
    { ...expect, barcodeRaw: '', hasPdfBarkod: true },
    { ...expect, barcodeRaw: '<html>err</html>' },
    { ...expect, barcodeRaw: OFFICIAL_ZPL + OFFICIAL_ZPL },
    { ...expect, barcodeRaw: OFFICIAL_ZPL.replaceAll(BARCODE, '09999999999').replaceAll(TNO, '9') },
    { ...expect, barcodeRaw: LEGACY_GENERATED_ZPL, zplSource: 'generated' },
  ])
  assert.equal(report.scannedCount, 8)
  assert.equal(report.validOfficialZplCount, 2)
  assert.equal(report.webInternalCodeOnlyCount, 1)
  assert.equal(report.missingBarcodeRawCount, 1)
  assert.equal(report.invalidEnvelopeCount, 1)
  assert.equal(report.multiPageCount, 1)
  assert.equal(report.trackingMismatchCount, 1)
  assert.equal(report.legacyGeneratedCount, 1)
  assert.equal(report.officialPdfAvailableCount, 1)
  assert.equal(report.zplSourceBuckets['surat.ortakBarkod.BarcodeRaw'], 3)
  assert.equal(report.zplSourceBuckets.generated, 1)
  assert.equal(report.zplSourceBuckets.unknown, 4)
  const sum =
    report.validOfficialZplCount + report.webInternalCodeOnlyCount +
    report.missingBarcodeRawCount + report.invalidEnvelopeCount +
    report.multiPageCount + report.trackingMismatchCount +
    report.legacyGeneratedCount
  assert.equal(sum, report.scannedCount, 'sınıflar birbirini dışlar')
})

test('SZD-10: dört karar cümlesi tam olarak sözleşmedeki gibi üretilir', () => {
  const mk = (over) => summarizeSuratZplDiagnostic(over)
  assert.deepEqual(
    decideSuratZplReadiness(mk([{ ...expect, barcodeRaw: OFFICIAL_ZPL }])),
    {
      decision: 'OFFICIAL_ZPL_VERIFIED',
      message: 'Resmî Sürat ZPL production verisinde doğrulandı.',
    },
  )
  const pdfOnly = decideSuratZplReadiness(
    mk([{ ...expect, barcodeRaw: '', hasPdfBarkod: true }]),
  )
  assert.equal(pdfOnly.decision, 'PDF_ONLY')
  assert.match(pdfOnly.message, /yalnız resmî PDF sağlıyor olabilir/)
  const webOnly = decideSuratZplReadiness(mk([{ ...expect, barcodeRaw: WEB_ONLY_ZPL }]))
  assert.equal(webOnly.decision, 'WEB_CODE_ONLY')
  assert.match(webOnly.message, /BarcodeRaw resmî etiket değildir/)
  const none = decideSuratZplReadiness(mk([]))
  assert.equal(none.decision, 'NO_EVIDENCE')
  assert.match(none.message, /kontrollü tek test gönderisi/)
  // Geçerli ZPL varsa PDF veya Web kayıtları kararı BOZMAZ.
  assert.equal(
    decideSuratZplReadiness(mk([
      { ...expect, barcodeRaw: WEB_ONLY_ZPL },
      { ...expect, barcodeRaw: '', hasPdfBarkod: true },
      { ...expect, barcodeRaw: OFFICIAL_ZPL },
    ])).decision,
    'OFFICIAL_ZPL_VERIFIED',
  )
})

test('SZD-11: persist edilmiş carrier payload şeklinden alanlar çözülür', () => {
  const artifact = extractSuratLabelArtifact({
    carrierTrackingNumber: TNO,
    carrierBarcodeNumber: BARCODE,
    shipment: {
      suratCreateLog: {
        parsedResponse: { BarcodeRaw: OFFICIAL_ZPL },
        PdfBarkod: 'JVBERi0xLjQKJSVFT0Y=',
      },
    },
  })
  assert.equal(artifact.barcodeRaw, OFFICIAL_ZPL)
  assert.equal(artifact.trackingNumber, TNO)
  assert.equal(artifact.barcode, BARCODE)
  assert.equal(artifact.hasPdfBarkod, true)
  assert.equal(artifact.pdfBarkodLength, 20)
  // Çıkarılan yapı PDF İÇERİĞİNİ taşımaz.
  assert.equal(
    JSON.stringify(artifact).includes('JVBERi0xLjQ'),
    false,
    'PDF base64 içeriği dışarı taşınmaz',
  )
  assert.deepEqual(extractSuratLabelArtifact(null).barcodeRaw, undefined)
  assert.equal(extractSuratLabelArtifact(undefined).hasPdfBarkod, false)
})

// ── gizlilik sözleşmesi ───────────────────────────────────────────────────

test('SZD-12: rapor çıktısı ham ZPL veya PII TAŞIMAZ', () => {
  const report = summarizeSuratZplDiagnostic([
    { trackingNumber: TNO, barcode: BARCODE, barcodeRaw: OFFICIAL_ZPL },
    { trackingNumber: TNO, barcode: BARCODE, barcodeRaw: WEB_ONLY_ZPL },
    { trackingNumber: TNO, barcode: BARCODE, barcodeRaw: LEGACY_GENERATED_ZPL },
  ])
  const serialized = JSON.stringify(report)
  for (const secret of ['^XA', '^FO', '^BCN', '^FD', TNO, BARCODE, 'Web3952033136', '7270000000000001']) {
    assert.equal(serialized.includes(secret), false, `raporda sızdı: ${secret}`)
  }
  assert.ok(report.safeFingerprintSamples.length > 0)
  for (const sample of report.safeFingerprintSamples) {
    assert.deepEqual(Object.keys(sample).sort(), ['class', 'fingerprint'])
    assert.match(sample.fingerprint, /^[0-9a-f]{12}$/)
  }
})

test('SZD-13: parmak izi örnekleri sınıf başına sınırlıdır (çıktı şişmez)', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    ...expect,
    barcodeRaw: OFFICIAL_ZPL.replace('MERKEZ', `SUBE${i}`),
  }))
  const report = summarizeSuratZplDiagnostic(many)
  assert.equal(report.validOfficialZplCount, 50)
  assert.equal(report.safeFingerprintSamples.length, 3)
})

test('SZD-14: CLI ve loader salt okunurdur — write/provider çağrısı içermez', () => {
  const cliPath = join(here, 'integrations', 'suratZplDiagnosticCli.ts')
  const src = readFileSync(cliPath, 'utf8')
  const loaderSrc = readFileSync(
    join(here, 'integrations', 'suratZplDiagnosticLoader.ts'),
    'utf8',
  )
  for (const forbidden of [
    '.insert(', '.update(', '.delete(', 'createShipment', 'OrtakBarkod',
    'soap', 'fetch(', 'axios',
  ]) {
    for (const [name, text] of [['CLI', src], ['loader', loaderSrc]]) {
      assert.equal(
        text.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `${name} yasak çağrı içeriyor: ${forbidden}`,
      )
    }
  }
  // Veri yolu YALNIZ select kullanır.
  assert.match(loaderSrc, /\.select\(/)
  assert.match(src, /--apply desteklenmez/, '--apply bilinçli reddedilir')
  // Teşhis modülü de saf olmalı: DB/ağ importu yok.
  const mod = readFileSync(
    join(here, 'integrations', 'suratZplDiagnostic.ts'),
    'utf8',
  )
  assert.equal(/from '\.\.\/db\//.test(mod), false, 'saf modül DB import etmez')
})

// ── gerçek DB yolu (hermetik pglite) ──────────────────────────────────────

test('SZD-15: loader gerçek şemadan okur, hesap kapsamına uyar ve DB\'yi DEĞİŞTİRMEZ', async (t) => {
  const schema = await import('./db/schema.ts')
  const { encryptShipmentPayload } = await import('./shipments/shipmentEncryption.ts')
  const { loadSuratLabelArtifacts } = await import(
    './integrations/suratZplDiagnosticLoader.ts'
  )
  const accounts = await import('./integrations/marketplaceAccountRepository.ts')

  const pglite = new PGlite()
  t.after(() => pglite.close())
  const dir = join(here, '..', 'drizzle')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(dir, file), 'utf8')
      .split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      await pglite.exec(stmt)
    }
  }
  const db = drizzle(pglite, { schema })
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'szd', slug: 'szd' }).returning()
  const accA = await accounts.resolveOrCreateActiveAccount(db, org.id, 'Trendyol', '277221')
  const accB = await accounts.resolveOrCreateActiveAccount(db, org.id, 'Trendyol', '999999')

  const order = (packageId, accountId) => ({
    organizationId: org.id, marketplaceAccountId: accountId,
    marketplace: 'Trendyol', packageId, orderNumber: packageId,
    orderDate: new Date('2026-07-10T08:00:00Z'),
  })
  await db.insert(schema.orders).values([
    order('PKG-A', accA.id), order('PKG-B', accB.id),
  ])

  const carrier = (zpl) => ({
    carrierTrackingNumber: TNO, carrierBarcodeNumber: BARCODE,
    shipment: { barcodeRaw: zpl, zplSource: 'surat.ortakBarkod.BarcodeRaw' },
  })
  const shipmentRow = (packageId, zpl) => ({
    organizationId: org.id, marketplace: 'Trendyol', packageId,
    provider: 'surat-kargo', source: 'local_create', status: 'created',
    trackingNumber: TNO, barcode: BARCODE,
    carrierPayloadEncrypted: encryptShipmentPayload(carrier(zpl)),
  })
  await db.insert(schema.shipments).values([
    shipmentRow('PKG-A', OFFICIAL_ZPL),
    shipmentRow('PKG-B', WEB_ONLY_ZPL),
  ])
  // shipments'a terfi etmemiş create yanıtı da taranır.
  await db.insert(schema.shipmentOperations).values({
    organizationId: org.id, marketplace: 'Trendyol', packageId: 'PKG-A',
    provider: 'surat-kargo', operationType: 'create', idempotencyKey: 'idem-a',
    status: 'succeeded', trackingNumber: TNO,
    responsePayloadEncrypted: encryptShipmentPayload(carrier(LEGACY_GENERATED_ZPL)),
  })

  const base = { organizationId: org.id, marketplace: 'Trendyol', provider: 'surat-kargo', limit: 200 }

  // Hesap kapsamı: yalnız 277221'in paketleri.
  const scopedA = await loadSuratLabelArtifacts(db, { ...base, providerAccountId: '277221' })
  const reportA = summarizeSuratZplDiagnostic(scopedA.artifacts)
  assert.equal(scopedA.accountResolved, true)
  assert.equal(scopedA.scopedPackageCount, 1)
  assert.equal(reportA.scannedCount, 2, 'shipment + operation okundu')
  assert.equal(reportA.validOfficialZplCount, 1)
  assert.equal(reportA.legacyGeneratedCount, 1)
  assert.equal(reportA.webInternalCodeOnlyCount, 0, 'diğer hesap sızmadı')
  assert.equal(
    decideSuratZplReadiness(reportA).decision,
    'OFFICIAL_ZPL_VERIFIED',
  )

  // Kapsamsız tarama her iki hesabı da görür.
  const all = summarizeSuratZplDiagnostic((await loadSuratLabelArtifacts(db, base)).artifacts)
  assert.equal(all.scannedCount, 3)
  assert.equal(all.webInternalCodeOnlyCount, 1)

  // Bilinmeyen hesap → sert hata yolu, tarama yok.
  const unknown = await loadSuratLabelArtifacts(db, { ...base, providerAccountId: '000000' })
  assert.equal(unknown.accountResolved, false)
  assert.equal(unknown.artifacts.length, 0)

  // Çözülemeyen payload kaydı sayılır, patlatmaz.
  await db.insert(schema.shipments).values({
    ...shipmentRow('PKG-C', OFFICIAL_ZPL),
    carrierPayloadEncrypted: '{"v":1,"iv":"AA==","tag":"AA==","data":"AA=="}',
  })
  const withBad = await loadSuratLabelArtifacts(db, base)
  assert.equal(withBad.undecryptableCount, 1)

  // SALT OKUNUR kanıtı: satır sayıları değişmedi.
  assert.equal((await db.select().from(schema.shipments)).length, 3)
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 1)
  assert.equal((await db.select().from(schema.orders)).length, 2)
})

test('SZD-16: npm script kayıtlı ve dry-run varsayılan', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts['surat:zpl:diagnose'],
    'node server/integrations/suratZplDiagnosticCli.ts',
  )
  const src = readFileSync(
    join(here, 'integrations', 'suratZplDiagnosticCli.ts'),
    'utf8',
  )
  assert.match(src, /YAZAN bir modu\s*\n?\/\/ YOKTUR|YAZAN bir modu/)
})
