// SÜRAT UÇ AİLESİ KARŞILAŞTIRICISI — SALT OKUNUR, AĞSIZ.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// api02'nin CANLI OpenAPI 3 sözleşmesi (docs/contracts/surat-web-api-swagger
// -v2.json) aynı `OrtakBarkod` etiketi altında DÖRT uç tanımlar. Bunlardan
// yalnız biri pazaryeri gönderisi içindir ve şu an KULLANDIĞIMIZ o DEĞİL.
//
// Bu araç, sentetik bir Trendyol paketi için her adayın gövdesini SÖZLEŞMEDEN
// üretir ve yan yana gösterir. Böylece uç seçimi canlı paket TÜKETMEDEN
// tartışılabilir.
//
// AĞ ÇAĞRISI YOK · DB YAZMA YOK · CREATE YOK.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readArg = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

interface SwaggerSchema {
  properties?: Record<string, Record<string, unknown>>
  'x-enumNames'?: string[]
  enum?: number[]
}

const SWAGGER_PATH = fileURLToPath(
  new URL('../../docs/contracts/surat-web-api-swagger-v2.json', import.meta.url),
)

/** Sözleşme DEPODAN okunur; ağdan çekilmez (yeniden üretilebilirlik). */
function loadContract(): {
  paths: Record<string, Record<string, unknown>>
  schemas: Record<string, SwaggerSchema>
} {
  const raw = JSON.parse(readFileSync(SWAGGER_PATH, 'utf8'))
  return { paths: raw.paths ?? {}, schemas: raw.components?.schemas ?? {} }
}

const refName = (node: unknown): string => {
  const record = node as Record<string, unknown> | undefined
  const direct = record?.$ref
  if (typeof direct === 'string') return direct.split('/').pop() ?? ''
  const oneOf = record?.oneOf as { $ref?: string }[] | undefined
  const first = oneOf?.[0]?.$ref
  return typeof first === 'string' ? (first.split('/').pop() ?? '') : ''
}

/** Ucun istek gövdesi şeması adı — TAHMİN EDİLMEZ, sözleşmeden okunur. */
function requestSchemaName(
  paths: Record<string, Record<string, unknown>>, route: string,
): string {
  const post = (paths[route] as Record<string, unknown> | undefined)
    ?.post as Record<string, unknown> | undefined
  const body = post?.requestBody as Record<string, unknown> | undefined
  const content = body?.content as Record<string, unknown> | undefined
  const json = content?.['application/json'] as Record<string, unknown> | undefined
  return refName(json?.schema)
}

function responseSchemaName(
  paths: Record<string, Record<string, unknown>>, route: string,
): string {
  const post = (paths[route] as Record<string, unknown> | undefined)
    ?.post as Record<string, unknown> | undefined
  const responses = post?.responses as Record<string, unknown> | undefined
  const ok = responses?.['200'] as Record<string, unknown> | undefined
  const content = ok?.content as Record<string, unknown> | undefined
  const json = content?.['application/json'] as Record<string, unknown> | undefined
  return refName(json?.schema)
}

/** Şemayı alan/tip satırlarına açar. İç içe şema adları İZLENİR. */
function describeSchema(
  schemas: Record<string, SwaggerSchema>, name: string, depth = 0,
): string[] {
  const schema = schemas[name]
  if (!schema) return [`${'  '.repeat(depth)}${name}: SÖZLEŞMEDE YOK`]
  const lines: string[] = []
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const nested = refName(value)
    const type = nested
      ? `→ ${nested}`
      : `${String(value.type ?? 'unknown')}${value.format ? `/${value.format}` : ''}`
    lines.push(`${'  '.repeat(depth + 1)}${key.padEnd(22)} ${type}`)
    if (nested && depth < 1) {
      const enumNames = schemas[nested]?.['x-enumNames']
      const enumValues = schemas[nested]?.enum
      if (enumNames && enumValues) {
        const pairs = enumNames
          .map((label, index) => `${label}=${enumValues[index]}`)
          .join(', ')
        lines.push(`${'  '.repeat(depth + 2)}enum: ${pairs}`)
      } else {
        lines.push(...describeSchema(schemas, nested, depth + 1))
      }
    }
  }
  return lines
}

export function runSuratRouteInspect(): number {
  const { paths, schemas } = loadContract()

  // Sentetik — canlı paket DEĞİL.
  const pkg = {
    packageId: readArg('package') || '4190000001',
    orderNumber: readArg('order') || '11900000001',
    cargoTrackingNumber: readArg('tracking') || '7270099999999999',
    marketplace: 'Trendyol',
    desi: 2, adet: 1,
  }

  const CANDIDATES = [
    '/api/OrtakBarkodOlustur',
    '/api/PazaryeriOrtakBarkod',
    '/api/PazaryeriGonderi',
    '/api/CreateCommonBarcode',
  ]

  console.info('=== SÜRAT UÇ AİLESİ KARŞILAŞTIRMASI (SALT OKUNUR) ===')
  console.info('')
  console.info(`SÖZLEŞME        docs/contracts/surat-web-api-swagger-v2.json`)
  console.info(`SENTETİK PAKET  packageId=${pkg.packageId} · orderNumber=${pkg.orderNumber}`)
  console.info(`                cargoTrackingNumber=${pkg.cargoTrackingNumber}`)
  console.info('')

  for (const route of CANDIDATES) {
    const request = requestSchemaName(paths, route)
    const response = responseSchemaName(paths, route)
    const used = route === '/api/OrtakBarkodOlustur'
    console.info(`── ${route}${used ? '   ← ŞU AN KULLANILAN' : ''}`)
    console.info(`   istek  : ${request || 'UNKNOWN'}`)
    console.info(`   yanıt  : ${response || 'UNKNOWN'}`)
    if (request) {
      for (const line of describeSchema(schemas, request)) console.info(line)
    }
    // Adres alanı taşıyan gövde YENİ gönderi kurar; taşımayan MEVCUDU çağırır.
    const flattened = request ? describeSchema(schemas, request).join(' ') : ''
    const carriesAddress =
      /Adres|Alici|Gonderen|KisiKurum|Address|Recipient|Sender/i.test(flattened)
    console.info(
      `   semantik: ${carriesAddress
        ? 'ADRES TAŞIR → YENİ gönderi kurar'
        : 'ADRES TAŞIMAZ → MEVCUT kaydı referansla çağırır'}`,
    )
    console.info('')
  }

  console.info('── KARAR GİRDİLERİ (uygulama tarafı, DEĞİŞMEDİ)')
  console.info('   billingParty            TRENDYOL_PAYS')
  console.info('   expectedSuratWhoPays    3')
  console.info('   credentialRole          PRIMARY_MARKETPLACE')
  console.info('   ReferansNo kaynağı      packageId')
  console.info('   OzelKargoTakipNo kaynağı cargoTrackingNumber')
  console.info('')
  console.info('   Sözleşme çapraz kontrolü — MusteriEntegrasyonOdemeSekli:')
  const odeme = schemas.MusteriEntegrasyonOdemeSekli
  if (odeme?.['x-enumNames'] && odeme.enum) {
    odeme['x-enumNames'].forEach((label, index) => {
      const value = odeme.enum?.[index]
      const note = value === 3
        ? '   ← TRENDYOL_PAYS (expectedSuratWhoPays=3)'
        : value === 1 ? '   ← SELLER_PAYS (expectedSuratWhoPays=1)' : ''
      console.info(`     ${String(value).padEnd(3)} ${label}${note}`)
    })
  }
  console.info('')
  console.info('NETWORK_CALLS 0 · DB_WRITES 0 · CREATE_CALLS 0 · PRINT_CALLS 0')
  return 0
}

const invokedDirectly = process.argv[1]?.includes('suratRouteInspectCli')
if (invokedDirectly) process.exitCode = runSuratRouteInspect()
