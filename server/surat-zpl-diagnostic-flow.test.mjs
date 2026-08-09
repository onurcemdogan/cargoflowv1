import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// Sürat resmî ZPL teşhisi (SALT OKUNUR) + köken (provenance) sözleşmesi.
//
// KÖK NEDEN: persistence katmanı provider BarcodeRaw'ını `technicalZpl` adıyla
// normalize eder; teşhis bu alanı okumadığı için 19/19 kaydı yanlışlıkla
// "missingBarcodeRaw" saymıştı.
//
// Tüm ZPL örnekleri SENTETİKTİR; gerçek müşteri verisi veya secret İÇERMEZ.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const {
  classifySuratLabelArtifact,
  decideSuratZplReadiness,
  extractSuratLabelArtifact,
  fingerprintZpl,
  sha256Hex,
  summarizeSuratZplDiagnostic,
  SURAT_PROVIDER_ALIASES,
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

// Eski CargoFlow generated şablonu: CargoFlow'a ÖZGÜ "SIPARIS URUNLERI"
// devam-etiketi başlığını taşır (provider çıktısında bulunmaz).
const LEGACY_GENERATED_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL799',
  `^FO500,20^A0N,26,26^FDT.No: ${TNO}^FS`,
  `^FO60,120^BY3^BCN,140,Y,N,N^FD${BARCODE}^FS`,
  '^FO56,660^A0N,18,18^FDSIPARIS URUNLERI - DEVAM^FS',
  '^XZ',
].join('\n')

const expect = { trackingNumber: TNO, barcode: BARCODE }
const cls = (over) => classifySuratLabelArtifact({ ...expect, ...over })

// ── GÖREV 1: technicalZpl bulunur, missingZpl sayılmaz ────────────────────

test('SZD-1: persist edilmiş technicalZpl teşhis tarafından BULUNUR', () => {
  const artifact = extractSuratLabelArtifact({
    // Production'daki gerçek şekil: technicalZpl payload'un TEPESİNDE.
    technicalZpl: OFFICIAL_ZPL,
    technicalZplSha256: sha256Hex(OFFICIAL_ZPL),
    technicalZplLength: OFFICIAL_ZPL.length,
    carrierTrackingNumber: TNO,
    carrierBarcodeNumber: BARCODE,
  })
  assert.equal(artifact.zpl, OFFICIAL_ZPL)
  assert.equal(artifact.zplField, 'technicalZpl')
  assert.equal(artifact.trackingNumber, TNO)
  assert.equal(artifact.barcode, BARCODE)
})

test('SZD-2: technicalZpl varsa missingZpl SAYILMAZ (kök neden regresyonu)', () => {
  const report = summarizeSuratZplDiagnostic(
    Array.from({ length: 19 }, (_, i) =>
      extractSuratLabelArtifact({
        technicalZpl: OFFICIAL_ZPL.replace('MERKEZ', `SUBE${i}`),
        technicalZplSha256: sha256Hex(OFFICIAL_ZPL.replace('MERKEZ', `SUBE${i}`)),
        carrierTrackingNumber: TNO,
        carrierBarcodeNumber: BARCODE,
      }),
    ),
  )
  assert.equal(report.scannedCount, 19)
  assert.equal(report.missingZplCount, 0, 'eski hatalı sonuç: 19')
  assert.equal(report.validZplEnvelopeCount, 19)
  assert.equal(report.officialProviderZplCount, 19)
  assert.equal(report.zplFieldBuckets.technicalZpl, 19)
})

test('SZD-3: shipment.technicalZpl, barcodeRaw ve eski zplContent de okunur', () => {
  assert.equal(
    extractSuratLabelArtifact({ shipment: { technicalZpl: OFFICIAL_ZPL } }).zplField,
    'shipment.technicalZpl',
  )
  assert.equal(
    extractSuratLabelArtifact({ shipment: { barcodeRaw: OFFICIAL_ZPL } }).zplField,
    'shipment.barcodeRaw',
  )
  assert.equal(
    extractSuratLabelArtifact({
      shipment: { suratCreateLog: { parsedResponse: { BarcodeRaw: OFFICIAL_ZPL } } },
    }).zplField,
    'shipment.suratCreateLog.parsedResponse.BarcodeRaw',
  )
  assert.equal(
    extractSuratLabelArtifact({ label: { zplContent: OFFICIAL_ZPL } }).zplField,
    'label.zplContent',
  )
  assert.equal(extractSuratLabelArtifact({}).zplField, 'none')
})

// ── zarf sınıfları ────────────────────────────────────────────────────────

test('SZD-4: zarf sınıfları — eksik / bozuk / çok sayfa / kanıt uyuşmazlığı', () => {
  assert.equal(cls({ zpl: '' }).envelopeClass, 'missingZpl')
  assert.equal(cls({ zpl: null }).envelopeClass, 'missingZpl')
  for (const body of [
    '<!DOCTYPE html><html><body>Gateway Timeout</body></html>',
    '{"isError":true,"Message":"014"}',
    'PLAIN TEXT LABEL',
    '^XA^XZ',
  ]) {
    assert.equal(cls({ zpl: body }).envelopeClass, 'invalidEnvelope', body.slice(0, 20))
  }
  assert.equal(
    cls({ zpl: OFFICIAL_ZPL + '\n' + OFFICIAL_ZPL }).envelopeClass,
    'multiPageProviderZpl',
  )
  assert.equal(cls({ zpl: WEB_ONLY_ZPL }).envelopeClass, 'trackingEvidenceMismatch')
  const foreign = OFFICIAL_ZPL.replaceAll(BARCODE, '09999999999').replaceAll(TNO, '9')
  assert.equal(cls({ zpl: foreign }).envelopeClass, 'trackingEvidenceMismatch')
  assert.equal(cls({ zpl: OFFICIAL_ZPL }).envelopeClass, 'validZplEnvelope')
})

// ── GÖREV 2: köken ayrımı ─────────────────────────────────────────────────

test('SZD-5: resmî provider ZPL — açık source metadata ile kanıtlanır', () => {
  for (const source of [
    'surat.ortakBarkod.BarcodeRaw',
    'surat.create.replayStoredZpl',
  ]) {
    assert.equal(
      cls({ zpl: OFFICIAL_ZPL, zplSource: source }).provenance,
      'officialProviderZpl',
      source,
    )
  }
})

test('SZD-6: resmî provider ZPL — ham BarcodeRaw SHA-256 eşleşmesiyle kanıtlanır', () => {
  // Metadata YOK; kanıt yalnız özet eşleşmesi.
  assert.equal(
    cls({
      zpl: OFFICIAL_ZPL,
      rawResponseBarcodeRawSha256: sha256Hex(OFFICIAL_ZPL),
    }).provenance,
    'officialProviderZpl',
  )
  // technicalZplSha256 eşleşmesi de kanıttır: buildSafeZplReference bu özeti
  // YALNIZ BarcodeRaw alanlarından üretir.
  assert.equal(
    cls({ zpl: OFFICIAL_ZPL, persistedZplSha256: sha256Hex(OFFICIAL_ZPL) }).provenance,
    'officialProviderZpl',
  )
  // Özet TUTMUYORSA kanıt sayılmaz.
  assert.equal(
    cls({ zpl: OFFICIAL_ZPL, persistedZplSha256: sha256Hex('baska') }).provenance,
    'provenanceUnknown',
  )
})

test('SZD-7: eski generated CargoFlow ZPL doğru sınıflanır', () => {
  assert.equal(
    cls({ zpl: OFFICIAL_ZPL, zplSource: 'generated' }).provenance,
    'legacyGeneratedCargoFlowZpl',
  )
  // Metadata kayıpsa CargoFlow'a ÖZGÜ imzadan tanınır.
  assert.equal(
    cls({ zpl: LEGACY_GENERATED_ZPL }).provenance,
    'legacyGeneratedCargoFlowZpl',
  )
  // Çelişkili durumda ASLA "resmî" denmez: generated imzası önce elenir.
  assert.equal(
    cls({
      zpl: LEGACY_GENERATED_ZPL,
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      persistedZplSha256: sha256Hex(LEGACY_GENERATED_ZPL),
    }).provenance,
    'legacyGeneratedCargoFlowZpl',
  )
})

test('SZD-8: kaynağı bilinmeyen ZPL official DİYE İŞARETLENMEZ', () => {
  const c = cls({ zpl: OFFICIAL_ZPL })
  assert.equal(c.envelopeClass, 'validZplEnvelope', 'geçerli ZPL')
  assert.equal(c.provenance, 'provenanceUnknown', 'kanıtsız = unknown')
  // Gerçek Sürat etiketinde de bulunan metinler generated kanıtı SAYILMAZ
  // (aksi hâlde resmî ZPL yanlışlıkla "legacy" işaretlenirdi).
  const withSharedText = OFFICIAL_ZPL.replace(
    '^FO40,20^A0N,28,28^FDSube: MERKEZ^FS',
    '^FO40,20^A0N,28,28^FDMUST.IRS.NO^FS\n^FO40,60^A0N,20,20^FDSiparis No: 727^FS',
  )
  assert.notEqual(
    cls({ zpl: withSharedText, zplSource: 'surat.ortakBarkod.BarcodeRaw' }).provenance,
    'legacyGeneratedCargoFlowZpl',
  )
})

// ── aggregate + kararlar ──────────────────────────────────────────────────

test('SZD-9: aggregate sayaçlar tutarlı ve denetlenebilir', () => {
  const report = summarizeSuratZplDiagnostic([
    { ...expect, zpl: OFFICIAL_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw', zplField: 'technicalZpl' },
    { ...expect, zpl: OFFICIAL_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw', zplField: 'technicalZpl' },
    { ...expect, zpl: LEGACY_GENERATED_ZPL, zplSource: 'generated', zplField: 'shipment.barcodeRaw' },
    { ...expect, zpl: OFFICIAL_ZPL, zplField: 'technicalZpl' },
    { ...expect, zpl: '', zplField: 'none' },
    { ...expect, zpl: '<html>err</html>', zplField: 'technicalZpl' },
    { ...expect, zpl: OFFICIAL_ZPL + OFFICIAL_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw', zplField: 'technicalZpl' },
    { ...expect, zpl: WEB_ONLY_ZPL, zplField: 'technicalZpl' },
  ])
  assert.equal(report.scannedCount, 8)
  // Zarf sınıfı ve köken BAĞIMSIZ eksenlerdir: legacy generated kayıt da
  // geçerli bir zarftır, çok sayfalı kayıt da resmî kaynaklı olabilir.
  assert.equal(report.validZplEnvelopeCount, 4)
  assert.equal(report.missingZplCount, 1)
  assert.equal(report.invalidEnvelopeCount, 1)
  assert.equal(report.multiPageCount, 1)
  assert.equal(report.trackingMismatchCount, 1)
  const envelopeSum =
    report.validZplEnvelopeCount + report.missingZplCount +
    report.invalidEnvelopeCount + report.multiPageCount +
    report.trackingMismatchCount
  assert.equal(envelopeSum, report.scannedCount, 'zarf sınıfları birbirini dışlar')

  assert.equal(report.officialProviderZplCount, 3)
  assert.equal(report.legacyGeneratedCargoFlowZplCount, 1)
  assert.equal(report.provenanceUnknownCount, 2)
  assert.equal(report.zplFieldBuckets.technicalZpl, 6)
  assert.equal(report.zplSourceBuckets['surat.ortakBarkod.BarcodeRaw'], 3)
})

test('SZD-10: dört karar sözleşmedeki gibi üretilir', () => {
  const d = (rows) => decideSuratZplReadiness(summarizeSuratZplDiagnostic(rows)).decision
  assert.equal(
    d([{ ...expect, zpl: OFFICIAL_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw' }]),
    'OFFICIAL_ZPL_VERIFIED',
  )
  assert.equal(
    d([{ ...expect, zpl: LEGACY_GENERATED_ZPL, zplSource: 'generated' }]),
    'LEGACY_GENERATED_ONLY',
  )
  assert.equal(d([{ ...expect, zpl: OFFICIAL_ZPL }]), 'ZPL_FOUND_PROVENANCE_UNKNOWN')
  assert.equal(d([]), 'NO_EVIDENCE')
  assert.equal(d([{ ...expect, zpl: '' }]), 'NO_EVIDENCE')
  // Tek bir resmî kanıt, legacy/unknown kayıtların yanında da kararı belirler.
  assert.equal(
    d([
      { ...expect, zpl: LEGACY_GENERATED_ZPL, zplSource: 'generated' },
      { ...expect, zpl: OFFICIAL_ZPL },
      { ...expect, zpl: OFFICIAL_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw' },
    ]),
    'OFFICIAL_ZPL_VERIFIED',
  )
  const legacyPlusUnknown = decideSuratZplReadiness(summarizeSuratZplDiagnostic([
    { ...expect, zpl: LEGACY_GENERATED_ZPL, zplSource: 'generated' },
    { ...expect, zpl: OFFICIAL_ZPL },
  ]))
  assert.equal(legacyPlusUnknown.decision, 'ZPL_FOUND_PROVENANCE_UNKNOWN')
  assert.match(legacyPlusUnknown.message, /resmî sayılmaz/)
})

// ── gizlilik ──────────────────────────────────────────────────────────────

test('SZD-11: rapor ham ZPL veya PII TAŞIMAZ', () => {
  const report = summarizeSuratZplDiagnostic([
    { ...expect, zpl: OFFICIAL_ZPL, zplSource: 'surat.ortakBarkod.BarcodeRaw' },
    { ...expect, zpl: WEB_ONLY_ZPL },
    { ...expect, zpl: LEGACY_GENERATED_ZPL, zplSource: 'generated' },
  ])
  const serialized = JSON.stringify(report)
  for (const secret of ['^XA', '^FO', '^BCN', '^FD', TNO, BARCODE, 'Web3952033136']) {
    assert.equal(serialized.includes(secret), false, `raporda sızdı: ${secret}`)
  }
  assert.ok(report.safeFingerprintSamples.length > 0)
  for (const s of report.safeFingerprintSamples) {
    assert.deepEqual(Object.keys(s).sort(), ['class', 'fingerprint', 'provenance'])
    assert.match(s.fingerprint, /^[0-9a-f]{12}$/)
  }
  assert.equal(fingerprintZpl(OFFICIAL_ZPL), sha256Hex(OFFICIAL_ZPL).slice(0, 12))
})

test('SZD-12: PDF metadata alınır ama base64 içerik TAŞINMAZ', () => {
  const artifact = extractSuratLabelArtifact({
    technicalZpl: OFFICIAL_ZPL,
    shipment: { suratCreateLog: { PdfBarkod: 'JVBERi0xLjQKJSVFT0Y=' } },
  })
  assert.equal(artifact.hasPdfBarkod, true)
  assert.equal(artifact.pdfBarkodLength, 20)
  assert.equal(JSON.stringify(artifact).includes('JVBERi0xLjQ'), false)
})

// ── GÖREV 3: üretim akışı doğru alana bağlı ───────────────────────────────

test('SZD-13: label sağlayıcı technicalZpl\'i resmî ZPL olarak kullanır', async (t) => {
  const { createServer } = await import('vite')
  const vite = await createServer({
    appType: 'custom', server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { ZebraZplLabelProvider } = await vite.ssrLoadModule(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const { resolvePersistedLabelArtifact } = await vite.ssrLoadModule(
    '/src/utils/persistedLabel.ts',
  )

  // barcodeRaw YOK, yalnız technicalZpl var (DB'den gelen gerçek şekil).
  const shipment = {
    provider: 'surat-kargo',
    trackingNumber: TNO, tNo: TNO, kargoTakipNo: TNO,
    barcode: BARCODE, barkodNo: BARCODE, barcodeValue: BARCODE,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    zplReady: true, printEnabled: true,
    technicalZpl: OFFICIAL_ZPL,
  }
  const order = {
    id: 'o1', orderNumber: '7270000000000001', packageId: 'PKG1',
    operationStatus: 'LABEL_READY',
    items: [{ id: 'l1', productName: 'Ürün', quantity: 1, barcode: 'B1' }],
    shipment,
  }
  const label = await new ZebraZplLabelProvider().generateSingle({
    order, shipment, template: { id: 't' }, desiConfig: { defaultUnitDesi: null },
  })
  assert.equal(label.zplContent, OFFICIAL_ZPL, 'byte-for-byte provider ZPL')
  assert.equal(label.zplSource, 'surat.ortakBarkod.BarcodeRaw')
  assert.equal((label.zplContent.match(/\^XA/g) ?? []).length, 1)
  // SÖZLEŞME (Aşama 3A/Adım 3): sağlayıcı katmanı DEĞİŞMEDİ — yukarıdaki
  // byte-for-byte iddiası aynen geçerli. Değişen tek şey İSTEMCİNİN artık
  // basılabilir çıktıyı kaynaktan SEÇMEMESİ; etiketin VARLIĞI yine bilinir.
  const artifact = resolvePersistedLabelArtifact(order)
  assert.equal(artifact.hasPrintableLabel, true)
  assert.equal(artifact.zpl, null, 'basılabilir çıktı istemciden SEÇİLMEZ')
  assert.equal(artifact.source, 'pending-fetch')
})

// ── salt okunurluk + gerçek DB yolu ───────────────────────────────────────

test('SZD-14: CLI ve loader salt okunurdur — write/provider çağrısı içermez', () => {
  const src = readFileSync(join(here, 'integrations', 'suratZplDiagnosticCli.ts'), 'utf8')
  const loaderSrc = readFileSync(
    join(here, 'integrations', 'suratZplDiagnosticLoader.ts'), 'utf8',
  )
  for (const forbidden of [
    '.insert(', '.update(', '.delete(', 'createShipment', 'OrtakBarkodOlustur',
    'soap', 'fetch(', 'axios',
  ]) {
    for (const [name, text] of [['CLI', src], ['loader', loaderSrc]]) {
      assert.equal(
        text.toLowerCase().includes(forbidden.toLowerCase()), false,
        `${name} yasak çağrı içeriyor: ${forbidden}`,
      )
    }
  }
  assert.match(loaderSrc, /\.select\(/)
  assert.match(src, /--apply desteklenmez/)
  const mod = readFileSync(join(here, 'integrations', 'suratZplDiagnostic.ts'), 'utf8')
  assert.equal(/from '\.\.\/db\//.test(mod), false, 'saf modül DB import etmez')
})

test('SZD-15: loader gerçek şemadan okur, provider alias\'larını kapsar, DB\'yi DEĞİŞTİRMEZ', async (t) => {
  const schema = await import('./db/schema.ts')
  const { encryptShipmentPayload } = await import('./shipments/shipmentEncryption.ts')
  const { loadSuratLabelArtifacts, resolveProviderFilter } = await import(
    './integrations/suratZplDiagnosticLoader.ts'
  )
  const accounts = await import('./integrations/marketplaceAccountRepository.ts')

  // Alias sözleşmesi: yanlış/eksik isim kayıtları sessizce sıfırlamaz.
  assert.deepEqual(resolveProviderFilter(), [...SURAT_PROVIDER_ALIASES])
  assert.deepEqual(resolveProviderFilter([]), [...SURAT_PROVIDER_ALIASES])
  assert.ok(resolveProviderFilter(['yanlis-isim']).includes('surat'))
  assert.ok(resolveProviderFilter(['yanlis-isim']).includes('surat-kargo'))

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
  await db.insert(schema.orders).values(
    [['PKG-A', accA.id], ['PKG-B', accB.id], ['PKG-C', accA.id]].map(([p, a]) => ({
      organizationId: org.id, marketplaceAccountId: a, marketplace: 'Trendyol',
      packageId: p, orderNumber: p, orderDate: new Date('2026-07-10T08:00:00Z'),
    })),
  )

  // Production şekli: technicalZpl + sha256 payload'un tepesinde.
  const payload = (zpl, extra = {}) => ({
    technicalZpl: zpl,
    technicalZplSha256: createHash('sha256').update(zpl, 'utf8').digest('hex'),
    technicalZplLength: zpl.length,
    carrierTrackingNumber: TNO, carrierBarcodeNumber: BARCODE,
    ...extra,
  })
  const ship = (packageId, provider, zpl, extra) => ({
    organizationId: org.id, marketplace: 'Trendyol', packageId, provider,
    source: 'local_create', status: 'created',
    trackingNumber: TNO, barcode: BARCODE,
    carrierPayloadEncrypted: encryptShipmentPayload(payload(zpl, extra)),
  })
  await db.insert(schema.shipments).values([
    // İki farklı provider kimliği — ikisi de taranmalı.
    ship('PKG-A', 'surat-kargo', OFFICIAL_ZPL),
    ship('PKG-C', 'surat', OFFICIAL_ZPL.replace('MERKEZ', 'IKINCI')),
    ship('PKG-B', 'surat-kargo', WEB_ONLY_ZPL),
  ])
  await db.insert(schema.shipmentOperations).values({
    organizationId: org.id, marketplace: 'Trendyol', packageId: 'PKG-A',
    provider: 'surat', operationType: 'create', idempotencyKey: 'idem-a',
    status: 'succeeded', trackingNumber: TNO,
    responsePayloadEncrypted: encryptShipmentPayload(
      payload(LEGACY_GENERATED_ZPL, { shipment: { zplSource: 'generated' } }),
    ),
  })

  const base = { organizationId: org.id, marketplace: 'Trendyol', limit: 200 }

  // Hesap kapsamı + her iki provider alias'ı.
  const scoped = await loadSuratLabelArtifacts(db, { ...base, providerAccountId: '277221' })
  assert.deepEqual(scoped.providersScanned, [...SURAT_PROVIDER_ALIASES])
  const reportA = summarizeSuratZplDiagnostic(scoped.artifacts)
  assert.equal(reportA.scannedCount, 3, 'surat + surat-kargo + operation')
  assert.equal(reportA.missingZplCount, 0, 'technicalZpl bulundu')
  assert.equal(reportA.officialProviderZplCount, 2, 'sha256 eşleşmesi kanıt')
  assert.equal(reportA.legacyGeneratedCargoFlowZplCount, 1)
  assert.equal(reportA.trackingMismatchCount, 0, 'diğer hesap sızmadı')
  assert.equal(reportA.zplFieldBuckets.technicalZpl, 3)
  assert.equal(decideSuratZplReadiness(reportA).decision, 'OFFICIAL_ZPL_VERIFIED')

  // Yanlış provider adı verilse bile alias'lar sayesinde kayıtlar bulunur.
  const wrongName = await loadSuratLabelArtifacts(db, { ...base, providers: ['yanlis'] })
  assert.equal(
    summarizeSuratZplDiagnostic(wrongName.artifacts).scannedCount, 4,
    'yanlış isim kayıtları sıfırlamaz',
  )

  const unknown = await loadSuratLabelArtifacts(db, { ...base, providerAccountId: '000000' })
  assert.equal(unknown.accountResolved, false)
  assert.equal(unknown.artifacts.length, 0)
  assert.ok(accB)

  // SALT OKUNUR kanıtı.
  assert.equal((await db.select().from(schema.shipments)).length, 3)
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 1)
  assert.equal((await db.select().from(schema.orders)).length, 3)
})

test('SZD-16: npm script kayıtlı ve komutun yazan modu yok', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts['surat:zpl:diagnose'],
    'node server/integrations/suratZplDiagnosticCli.ts',
  )
  const src = readFileSync(join(here, 'integrations', 'suratZplDiagnosticCli.ts'), 'utf8')
  assert.match(src, /YAZAN bir modu/)
})
