import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// KAYITLI printZpl ONARIMI — ÜRÜN SATIRI EKLENEMEMİŞ ARTEFAKTLAR.
//
// KÖK NEDEN: resolvePersistedPrintableLabel kayıtlı artefaktı AYNEN döndürür.
// Artefakt oluşurken augmentation düştüyse (ör. katalog henüz boştu) printZpl
// === technicalZpl olarak donar ve ürün satırı BİR DAHA gelmez.
//
// Bu paket onarımın YALNIZ o durumu hedeflediğini, kaynağa dokunmadığını ve
// zaten ürün satırı olan artefakta ASLA yazmadığını doğrular.
// GERÇEK PGlite. Veriler SENTETİKTİR.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY ??= 'a'.repeat(64)
process.env.CREDENTIAL_ENCRYPTION_KEY ??= 'b'.repeat(64)

const schema = await import('./db/schema.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')
const repair = await import('./shipments/repairPrintZpl.ts')
const { SURAT_PERSISTENCE_PROVIDER } = await import('./shipments/suratProvider.ts')
const { deriveAugmentedSuratZplWithHashes, sha256Hex } = await import(
  '../src/utils/augmentedSuratZpl.ts'
)

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
const pools = []
async function makeDb() {
  const pglite = new PGlite()
  pools.push(pglite)
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return drizzle(pglite, { schema })
}
after(async () => {
  for (const pool of pools) await pool.close()
})

// Ürün satırının SIĞDIĞI sentetik Sürat şablonu (resmî içerik ~640 dot'ta biter).
const TECHNICAL_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO60,20^GB700,90,2^FS',
  '^FT80,50^A0N,24,24^FDSube: ORNEK^FS',
  '^FO90,130^BY3^BCN,130,Y,N,N^FD01200000001^FS',
  '^FO60,300^GB700,140,2^FS',
  '^FT80,330^A0N,24,24^FDSENTETIK ALICI^FS',
  '^FO90,500^BXN,5,200^FD1000000000000001^FS',
  '^FT300,620^A0N,34,34^FDORNEKSEHIR/01^FS',
  '^FWB', '^FT40,600^A0B,18,18^FDSiparis No: 1000000000000001^FS', '^FWN',
  '^PQ1,0,1,Y', '^XZ',
].join('\n')

const PACKAGE_ID = '4056494300'
const ORDER_NO = '1000000000000001'

/** Ürün satırı EKLENEMEMİŞ artefakt: printZpl === technicalZpl. */
function sourceOnlyArtifact() {
  return {
    printZpl: TECHNICAL_ZPL,
    printZplLength: TECHNICAL_ZPL.length,
    printZplSha256: sha256Hex(TECHNICAL_ZPL),
    printZplSourceSha256: sha256Hex(TECHNICAL_ZPL),
    printZplVersion: 'surat-product-line-v1',
    printZplFooterProfile: null,
    templateFingerprint: 'x',
    printZplCreatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** Ürün satırı ZATEN eklenmiş artefakt (dokunulmamalı). */
function augmentedArtifact() {
  const derived = deriveAugmentedSuratZplWithHashes(TECHNICAL_ZPL, [
    { productName: 'Onceden Eklenmis Urun', quantity: 1, color: 'Mavi', size: '38', sku: 'OLD-1' },
  ])
  assert.equal(derived.augmented, true, 'fixture gerçekten augmented olmalı')
  return {
    printZpl: derived.printZpl,
    printZplLength: derived.printZpl.length,
    printZplSha256: derived.printZplSha256,
    printZplSourceSha256: sha256Hex(TECHNICAL_ZPL),
    printZplVersion: derived.printZplVersion,
    printZplFooterProfile: derived.printZplFooterProfile ?? null,
    templateFingerprint: derived.templateFingerprint,
    printZplCreatedAt: '2026-01-01T00:00:00.000Z',
  }
}

async function seed(db, over = {}) {
  const slug = over.slug ?? `org-${pools.length}-${Math.trunc(performance.now())}`
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  const packageId = over.packageId ?? PACKAGE_ID
  const [orderRow] = await db
    .insert(schema.orders)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: over.orderNumber ?? ORDER_NO,
      orderDate: new Date('2026-01-01T00:00:00.000Z'),
      rawPayloadEncrypted: encryption.encryptShipmentPayload({
        customerName: 'SENTETIK ALICI',
      }),
      operationStatus: 'LABEL_READY',
    })
    .returning()
  // Katalog satırı: onarımın besleneceği kaynak.
  if (over.withItems !== false) {
    await db.insert(schema.orderLines).values({
      organizationId: org.id,
      orderId: orderRow.id,
      externalLineId: 'line-1',
      productName: over.productName ?? 'Scuba Secil Detayli Tesettur Elbise',
      quantity: 1,
      merchantSku: 'SCUBA-SEC01',
      // GERÇEK ŞEKİL: pazaryeri varyant nitelikleri {name,value} DİZİSİDİR
      // (labelProductMetadata.ProductMetadataSource ile aynı sözleşme).
      variantAttributes: [
        { name: 'Renk', value: 'Lacivert' },
        { name: 'Beden', value: '40' },
      ],
    })
  }
  await db.insert(schema.shipments).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId,
    provider: over.provider ?? SURAT_PERSISTENCE_PROVIDER,
    source: 'local_create',
    status: 'VERIFIED',
    carrierPayloadEncrypted: encryption.encryptShipmentPayload({
      technicalZpl: over.zpl ?? TECHNICAL_ZPL,
      ...(over.artifact === null
        ? {}
        : { printZplArtifact: over.artifact ?? sourceOnlyArtifact() }),
    }),
  })
  return { organizationId: org.id, packageId }
}

async function readPayload(db, organizationId) {
  const rows = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  return {
    row: rows[0],
    payload: encryption.decryptShipmentPayload(rows[0].carrierPayloadEncrypted),
  }
}

// ═══ PR-1..PR-3: DRY-RUN = TEŞHİS, YAZMA YOK ════════════════════════════

test('PR-1: dry-run DB YAZMAZ ve onay jetonu üretir', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const before = await readPayload(db, seeded.organizationId)
  const report = await repair.repairSourceOnlyPrintZpl(db, {
    organizationId: seeded.organizationId,
  })
  const after = await readPayload(db, seeded.organizationId)
  assert.equal(report.mode, 'dry-run')
  assert.equal(report.candidates, 1)
  assert.equal(report.repaired, 1)
  assert.ok(report.confirmationToken, 'jeton üretildi')
  assert.equal(
    after.row.carrierPayloadEncrypted,
    before.row.carrierPayloadEncrypted,
    'dry-run şifreli payload’a DOKUNMAZ',
  )
})

test('PR-2: dry-run düşme sebebini RAPORLAR (teşhis)', async () => {
  const db = await makeDb()
  // Katalog satırı YOK → augmentation hâlâ düşer, sebep raporlanır.
  const seeded = await seed(db, { withItems: false })
  const report = await repair.repairSourceOnlyPrintZpl(db, {
    organizationId: seeded.organizationId,
  })
  assert.equal(report.repaired, 0)
  assert.equal(report.entries[0].outcome, 'still_no_items')
  assert.equal(report.entries[0].itemCount, 0)
})

test('PR-3: bilinmeyen şablonda sebep unsupported_template', async () => {
  const db = await makeDb()
  const seeded = await seed(db, {
    zpl: '^XA^PW400^LL0400^FT10,10^A0N,20,20^FDbasit^FS^XZ',
    artifact: {
      ...sourceOnlyArtifact(),
      printZpl: '^XA^PW400^LL0400^FT10,10^A0N,20,20^FDbasit^FS^XZ',
      printZplSha256: sha256Hex('^XA^PW400^LL0400^FT10,10^A0N,20,20^FDbasit^FS^XZ'),
      printZplSourceSha256: sha256Hex('^XA^PW400^LL0400^FT10,10^A0N,20,20^FDbasit^FS^XZ'),
    },
  })
  const report = await repair.repairSourceOnlyPrintZpl(db, {
    organizationId: seeded.organizationId,
  })
  assert.equal(report.repaired, 0)
  assert.equal(report.entries[0].outcome, 'still_unsupported_template')
  // Sebep metni ham ZPL veya PII TAŞIMAZ.
  const detail = report.entries[0].detail ?? ''
  assert.equal(/\^FD|\^XA|SENTETIK/.test(detail), false)
})

// ═══ PR-4..PR-6: APPLY ══════════════════════════════════════════════════

test('PR-4: apply ürün satırını EKLER, technicalZpl DEĞİŞMEZ', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const report = await repair.repairSourceOnlyPrintZpl(
    db,
    { organizationId: seeded.organizationId },
    { apply: true, now: '2026-08-08T00:00:00.000Z', batchId: 'batch-1' },
  )
  assert.equal(report.mode, 'apply')
  assert.equal(report.repaired, 1)
  const { payload } = await readPayload(db, seeded.organizationId)
  // KAYNAK KUTSAL: aynen duruyor.
  assert.equal(payload.technicalZpl, TECHNICAL_ZPL)
  // Türetilmiş artefakt artık ürün satırı içeriyor.
  assert.notEqual(payload.printZplArtifact.printZpl, TECHNICAL_ZPL)
  assert.ok(payload.printZplArtifact.printZpl.startsWith(TECHNICAL_ZPL.slice(0, 40)))
  assert.equal(
    payload.printZplArtifact.printZplSourceSha256,
    sha256Hex(TECHNICAL_ZPL),
    'kaynak hash’i korunur',
  )
  assert.equal(payload.printZplArtifact.augmentationReason, 'success')
})

test('PR-5: ürün adı, renk, beden ve SKU çıktıda GÖRÜNÜR', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  await repair.repairSourceOnlyPrintZpl(
    db,
    { organizationId: seeded.organizationId },
    { apply: true },
  )
  const { payload } = await readPayload(db, seeded.organizationId)
  const printZpl = payload.printZplArtifact.printZpl
  // EKLENEN komutlar: kaynakta HİÇ ^FB yoktur; footer bloklarının tamamı ^FB'lidir.
  assert.equal(TECHNICAL_ZPL.includes('^FB'), false, 'kaynakta ^FB yok')
  const added = printZpl
    .split(/\r?\n/)
    .filter((line) => line.includes('^FB'))
    .join('\n')
  for (const expected of [
    'Scuba Secil Detayli Tesettur Elbise',
    'Renk: Lacivert',
    'Beden: 40',
    'SCUBA-SEC01',
    '1 x ',
  ]) {
    assert.ok(added.includes(expected), `eksik: ${expected}`)
  }
  // TAŞMA KONTROLÜ: her blok ^FB{genişlik},{satır},0,L,0 ile sınırlanır —
  // metin KESİLMEZ, kontrollü şekilde alta sarar.
  const fb = [...added.matchAll(/\^FB(\d+),(\d+),0,L,0/g)]
  assert.ok(fb.length > 0, 'footer ^FB bloğu üretildi')
  for (const [, width] of fb) {
    assert.ok(Number(width) > 0 && Number(width) <= 799, `blok genişliği: ${width}`)
  }
  // Ürün satırı etiketin ALT bölümündedir ve alt kenar payı korunur.
  const ys = [...added.matchAll(/\^FO\d+,(\d+)/g)].map((m) => Number(m[1]))
  assert.ok(ys.length > 0, 'footer komutu üretildi')
  assert.ok(Math.min(...ys) > 620, `footer üstte kalmamalı: ${ys}`)
  assert.ok(Math.max(...ys) <= 799 - 8, `alt kenar payı korunmalı: ${ys}`)
})

test('PR-6: ZATEN ürün satırı olan artefakta ASLA dokunulmaz', async () => {
  const db = await makeDb()
  const seeded = await seed(db, { artifact: augmentedArtifact() })
  const before = await readPayload(db, seeded.organizationId)
  const report = await repair.repairSourceOnlyPrintZpl(
    db,
    { organizationId: seeded.organizationId },
    { apply: true },
  )
  const after = await readPayload(db, seeded.organizationId)
  assert.equal(report.candidates, 0)
  assert.equal(report.repaired, 0)
  assert.equal(report.entries[0].outcome, 'already_augmented')
  assert.equal(
    after.row.carrierPayloadEncrypted,
    before.row.carrierPayloadEncrypted,
    'mevcut artefakt BAYT BAYT korunur',
  )
})

// ═══ PR-7..PR-9: KAPSAM VE GÜVENLİK ═════════════════════════════════════

test('PR-7: onarım ORG kapsamlıdır; başka org ETKİLENMEZ', async () => {
  const db = await makeDb()
  const alfa = await seed(db, { slug: 'alfa-org' })
  const beta = await seed(db, { slug: 'beta-org' })
  const betaBefore = await readPayload(db, beta.organizationId)
  await repair.repairSourceOnlyPrintZpl(
    db,
    { organizationId: alfa.organizationId },
    { apply: true },
  )
  const betaAfter = await readPayload(db, beta.organizationId)
  assert.equal(
    betaAfter.row.carrierPayloadEncrypted,
    betaBefore.row.carrierPayloadEncrypted,
    'diğer org DOKUNULMADAN kalır',
  )
  const alfaAfter = await readPayload(db, alfa.organizationId)
  assert.notEqual(alfaAfter.payload.printZplArtifact.printZpl, TECHNICAL_ZPL)
})

test('PR-8: tek gönderi hedeflenebilir (--package-id)', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  // Aynı org'da ikinci gönderi.
  const [orderRow] = await db
    .insert(schema.orders)
    .values({
      organizationId: seeded.organizationId,
      marketplace: 'Trendyol',
      packageId: 'OTHER-PKG',
      orderNumber: '2000000000000002',
      orderDate: new Date('2026-01-01T00:00:00.000Z'),
      rawPayloadEncrypted: encryption.encryptShipmentPayload({ customerName: 'X' }),
      operationStatus: 'LABEL_READY',
    })
    .returning()
  await db.insert(schema.orderLines).values({
    organizationId: seeded.organizationId,
    orderId: orderRow.id,
    externalLineId: 'line-9',
    productName: 'Diger Urun',
    quantity: 1,
  })
  await db.insert(schema.shipments).values({
    organizationId: seeded.organizationId,
    marketplace: 'Trendyol',
    packageId: 'OTHER-PKG',
    provider: SURAT_PERSISTENCE_PROVIDER,
    source: 'local_create',
    status: 'VERIFIED',
    carrierPayloadEncrypted: encryption.encryptShipmentPayload({
      technicalZpl: TECHNICAL_ZPL,
      printZplArtifact: sourceOnlyArtifact(),
    }),
  })

  const report = await repair.repairSourceOnlyPrintZpl(db, {
    organizationId: seeded.organizationId,
    packageId: seeded.packageId,
  })
  assert.equal(report.scanned, 1, 'yalnız hedeflenen gönderi taranır')
  assert.equal(report.entries[0].packageId, seeded.packageId)
})

test('PR-9: rapor ham ZPL veya müşteri verisi TAŞIMAZ', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const report = await repair.repairSourceOnlyPrintZpl(
    db,
    { organizationId: seeded.organizationId },
    { apply: true },
  )
  const text = JSON.stringify(report)
  for (const forbidden of ['^XA', '^FD', '^FT', 'SENTETIK ALICI', TECHNICAL_ZPL]) {
    assert.equal(text.includes(forbidden), false, `sızıntı: ${forbidden.slice(0, 20)}`)
  }
})

test('PR-10: kaynak hash uyuşmazlığında ONARIM YAPILMAZ', async () => {
  const db = await makeDb()
  const seeded = await seed(db, {
    artifact: { ...sourceOnlyArtifact(), printZplSourceSha256: 'f'.repeat(64) },
  })
  const before = await readPayload(db, seeded.organizationId)
  const report = await repair.repairSourceOnlyPrintZpl(
    db,
    { organizationId: seeded.organizationId },
    { apply: true },
  )
  const after = await readPayload(db, seeded.organizationId)
  assert.equal(report.entries[0].outcome, 'source_hash_mismatch')
  assert.equal(report.repaired, 0)
  assert.equal(
    after.row.carrierPayloadEncrypted,
    before.row.carrierPayloadEncrypted,
  )
})

test('PR-11: CLI varsayılanı DRY-RUN ve apply jeton ister', () => {
  const cli = readFileSync(join(here, 'shipments/repairPrintZplCli.ts'), 'utf8')
  assert.match(cli, /if \(!hasFlag\('apply'\)\)/)
  assert.match(cli, /--apply için --confirmation-token zorunlu/)
  assert.match(cli, /--organization-id zorunlu/)
  // Provider çağrısı veya migration YOK.
  assert.equal(/SuratKargoProvider|fetch\(|drizzle-kit/.test(cli), false)
})
