// GÜVENLİ MASKELEME CLI'I — npm run surat:zpl:mask
//
// Gerçek Sürat technicalZpl'ini READ-ONLY okur ve YAPISAL OLARAK BİREBİR,
// içinde hiçbir gerçek müşteri verisi kalmayan bir fixture üretir.
//
// GÜVENLİK SÖZLEŞMESİ (bu dosyada zorlanır):
//   - Ham ZPL stdout'a, loga veya hata mesajına YAZILMAZ.
//   - Ham ZPL git'e girmez (çıktı YALNIZ maskelenmiş dosyadır).
//   - Labelary veya herhangi bir harici servise çağrı YOKTUR.
//   - DB modu SALT OKUNUR: write yok, provider/marketplace çağrısı yok,
//     shipment oluşturma yok, printCount/labelStatus değişimi yok.
//   - Yapısal doğrulama VEYA PII taraması başarısızsa dosya YAZILMAZ.
//
// KULLANIM
//   A) Yerel dosya:
//      npm run surat:zpl:mask -- --input /secure/technical.zpl \
//        --output server/fixtures/real-template-masked.zpl
//   B) Mevcut shipment (salt okunur):
//      npm run surat:zpl:mask -- --organization-id <id> --package-id <id> \
//        [--marketplace Trendyol] [--provider surat-kargo] \
//        --output /secure/real-template-masked.zpl
//   Ek: --deny-token "<deger>" (tekrarlanabilir), --print-structure
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  maskZpl,
  verifyStructuralEquality,
  scanForPii,
  buildStructureReport,
  buildGbInventory,
  structuralHash,
} from './zplMasking.ts'

interface Options {
  input?: string
  output: string
  organizationId?: string
  packageId?: string
  marketplace: string
  provider: string
  denyTokens: string[]
  printStructure: boolean
  structureOut?: string
  gbOut?: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    output: 'server/fixtures/real-template-masked.zpl',
    marketplace: 'Trendyol',
    provider: 'surat-kargo',
    denyTokens: [],
    printStructure: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--input') options.input = next()
    else if (arg === '--output') options.output = next()
    else if (arg === '--organization-id') options.organizationId = next()
    else if (arg === '--package-id') options.packageId = next()
    else if (arg === '--marketplace') options.marketplace = next()
    else if (arg === '--provider') options.provider = next()
    else if (arg === '--deny-token') options.denyTokens.push(String(next() ?? ''))
    else if (arg === '--print-structure') options.printStructure = true
    else if (arg === '--structure-out') options.structureOut = next()
    else if (arg === '--gb-out') options.gbOut = next()
  }
  return options
}

/**
 * SALT OKUNUR shipment okuması. Yalnız READY/PRINTED (yazdırılabilir) kayıt
 * kabul edilir. Hiçbir yazma yapılmaz.
 */
async function readSourceFromDatabase(options: Options): Promise<string> {
  if (!options.organizationId || !options.packageId) {
    throw new Error('DB modu için --organization-id ve --package-id zorunlu.')
  }
  const { getDb } = await import('../db/client.ts')
  const { shipments } = await import('../db/schema.ts')
  const { decryptShipmentPayload } = await import('../shipments/shipmentEncryption.ts')
  const { and, eq } = await import('drizzle-orm')
  const db = getDb()
  const rows = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, options.organizationId),
        eq(shipments.marketplace, options.marketplace),
        eq(shipments.packageId, options.packageId),
        eq(shipments.provider, options.provider),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error('Kayıt bulunamadı (organization scope içinde).')
  const payload = (decryptShipmentPayload(row.carrierPayloadEncrypted ?? null) ??
    {}) as Record<string, unknown>
  // Gerçek payload'daki sıraya göre: technicalZpl → barcodeRaw → BarcodeRaw.
  const nested = (payload.shipment ?? {}) as Record<string, unknown>
  const candidates = ['technicalZpl', 'barcodeRaw', 'BarcodeRaw']
  for (const key of candidates) {
    for (const scope of [payload, nested]) {
      const value = scope[key]
      if (typeof value === 'string' && value.trim()) return value
    }
  }
  throw new Error('Kayıtta resmî ZPL alanı bulunamadı.')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  // NOT: `source` HAM gerçek ZPL'dir. Bu değişken HİÇBİR yere yazdırılmaz.
  const source = options.input
    ? readFileSync(resolve(options.input), 'utf8')
    : await readSourceFromDatabase(options)

  if (!source.trim()) throw new Error('Kaynak ZPL boş.')

  const result = maskZpl(source)
  const verification = verifyStructuralEquality(source, result.masked)
  const pii = scanForPii(result.masked, options.denyTokens)

  // Güvenli özet — ham ZPL veya ^FD değeri YOK.
  console.log('kaynak byte uzunlugu     :', Buffer.byteLength(source, 'utf8'))
  console.log('maskelenmis byte uzunlugu:', Buffer.byteLength(result.masked, 'utf8'))
  console.log('komut sayisi             :', verification.commandCount)
  console.log('^FD alan sayisi          :', result.fieldCount,
    '(maskelenen', result.maskedFieldCount + ', bos', result.emptyFieldCount + ')')
  console.log('^GB / ^BC / ^BX / ^BQ    :',
    verification.gbCount, '/', verification.bcCount, '/',
    verification.bxCount, '/', verification.bqCount)
  console.log('yapisal iskelet esit     :', verification.structuralHashMatches)
  console.log('komut dizisi esit        :', verification.commandSequenceMatches)
  console.log('satir sonu korundu       :', verification.lineEndingMatches)
  console.log('tek ^XA/^XZ              :', verification.singleLabel)
  console.log('yapisal hash (FD-siz)    :', structuralHash(result.masked))
  console.log('PII taramasi temiz       :', pii.ok,
    pii.ok ? '' : '(' + pii.findings.map((f) => f.rule).join(', ') + ')')

  if (!verification.ok) {
    throw new Error('Yapısal esitlik SAGLANAMADI: ' + verification.reasons.join('; '))
  }
  if (!pii.ok) {
    throw new Error(
      'Maskelenmis dosyada yasak kalip/token kaldi; fixture URETILMEDI.',
    )
  }

  const outputPath = resolve(options.output)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, result.masked, { encoding: 'utf8', mode: 0o600 })
  console.log('maskelenmis fixture      :', options.output)

  if (options.structureOut) {
    const structurePath = resolve(options.structureOut)
    mkdirSync(dirname(structurePath), { recursive: true })
    writeFileSync(
      structurePath,
      JSON.stringify(buildStructureReport(result.masked), null, 2),
      'utf8',
    )
    console.log('yapi raporu              :', options.structureOut)
  }
  if (options.gbOut) {
    const gbPath = resolve(options.gbOut)
    mkdirSync(dirname(gbPath), { recursive: true })
    writeFileSync(
      gbPath,
      JSON.stringify(buildGbInventory(result.masked), null, 2),
      'utf8',
    )
    console.log('^GB envanteri            :', options.gbOut)
  }
  if (options.printStructure) {
    console.log(JSON.stringify(buildStructureReport(result.masked).gb, null, 2))
  }
}

main().catch((error) => {
  // Hata mesajina HAM ZPL KOYULMAZ.
  console.error(
    'surat:zpl:mask basarisiz:',
    error instanceof Error ? error.message : 'bilinmeyen hata',
  )
  process.exitCode = 1
})
