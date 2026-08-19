// SÜRAT TRACE V2 DENETÇİSİ — SALT OKUNUR.
//
// Kullanım:
//   npm run surat:trace:inspect -- --trace CF-4088105329
//   npm run surat:trace:inspect -- --org <organizationId> --list
//
// Hiçbir yazma, hiçbir taşıyıcı çağrısı, hiçbir mutasyon YAPMAZ.
// Kimlik DEĞERLERİ ve müşteri PII'si ASLA basılmaz.
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
// Başarısız kanonik denemenin GERÇEK tel isteğini görmek için yeni bir
// taşıyıcı çağrısına gerek YOK: iz artık `surat_trace_attempts` içinde
// kalıcı. Bu araç o kaydı okur ve alan-alan / TİP-TİP rapor üretir.

import { and, desc, eq } from 'drizzle-orm'
import { getDb, isDatabaseConfigured, closePool } from '../db/client.ts'
import { suratTraceAttempts } from '../db/schema.ts'
import { redactTraceValue } from './suratCreateTrace.ts'
import {
  projectActualWire,
  projectCarrierTruth,
} from './suratTraceProjection.ts'

/**
 * Bu CLI'ın KENDİ yan etkileri — okunan denemenin özelliği DEĞİL.
 *
 * Etiketler bilerek `INSPECTOR_` önekli: öneksiz `NETWORK_CALLS 0`, aynı iz
 * `carrierCalled=true` derken "taşıyıcıya gidilmedi" gibi okunuyordu.
 */
const INSPECTOR_SIDE_EFFECT_COUNTERS =
  'INSPECTOR_NETWORK_CALLS=0 · INSPECTOR_DB_WRITES=0 · INSPECTOR_CREATE_CALLS=0'

const readArg = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`)

/** SIR/PII ASLA basılmaz — yalnız VARLIK ve TİP raporlanır. */
const SECRET_KEYS = /sifre|password|kullaniciadi|username|token|secret|apikey/i
const PII_KEYS = /adres|address|telefon|phone|email|kisikurum|alici|receiver|name/i

/** Değerin çalışma zamanı tipi — sözleşme karşılaştırmasının ÇEKİRDEĞİ. */
function runtimeType(value: unknown): string {
  if (value === undefined) return 'absent'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Güvenli gösterim: sır/PII maskeli, diğerleri tip + değer. */
function describeField(key: string, value: unknown): string {
  const type = runtimeType(value)
  // ALAN YOK ile "alan var, degeri undefined" AYNI SEY DEGILDIR; rapor bunu
  // acikca soyler (sozlesme karsilastirmasinin en kritik ayrimi).
  if (type === 'absent') return 'absent · ABSENT'
  if (SECRET_KEYS.test(key)) {
    return `${type} · ${value === undefined ? 'ABSENT' : 'PRESENT (masked)'}`
  }
  if (PII_KEYS.test(key)) {
    return `${type} · ${value === undefined ? 'ABSENT' : 'PRESENT (pii-masked)'}`
  }
  if (type === 'object' || type === 'array') {
    const keys = Object.keys(value as object)
    return `${type} · ${keys.length} alan [${keys.slice(0, 12).join(', ')}]`
  }
  return `${type} · ${JSON.stringify(value)}`
}

/** Tel isteğinde ÖZELLİKLE denetlenen alanlar (görev listesi). */
const AUDITED_WIRE_FIELDS = [
  'KullaniciAdi', 'Sifre', 'Gonderi',
  'KisiKurum', 'AliciAdresi', 'Il', 'Ilce', 'Email',
  'KargoTuru', 'OdemeTipi', 'ReferansNo', 'OzelKargoTakipNo', 'Adet',
  'KapidanOdemeTahsilatTipi', 'KapidanOdemeTutari',
  'TasimaSekli', 'TeslimSekli', 'SevkAdresi', 'GonderiSekli',
  'Pazaryerimi', 'EntegrasyonFirmasi', 'Iademi',
  'WhoPays', 'KimOder', 'FirmaId',
] as const

const stageOf = (
  stages: Array<Record<string, unknown>>, stage: string,
): Record<string, unknown> => {
  const found = [...stages].reverse().find((entry) => entry.stage === stage)
  return (found?.data ?? {}) as Record<string, unknown>
}

function report(row: Record<string, unknown>): void {
  const stages = Array.isArray(row.stages)
    ? (row.stages as Array<Record<string, unknown>>)
    : []
  const summary = (row.summary ?? {}) as Record<string, unknown>

  console.info('═══ TRACE ═══════════════════════════════════════════════')
  console.info(`traceId      ${row.traceId}`)
  console.info(`createdAt    ${row.createdAt}`)
  console.info(`orderNumber  ${row.orderNumber ?? '-'}`)
  console.info(`packageId    ${row.packageId ?? '-'}`)
  console.info(`marketplace  ${row.marketplace ?? '-'}`)
  console.info(`serviceMode  ${row.serviceMode ?? '-'}`)
  console.info(`operation    ${row.operation ?? '-'}`)
  console.info(`finalState   ${row.finalState ?? '-'}`)
  console.info(`schemaVer    ${row.schemaVersion}`)
  console.info(`stages       ${stages.map((s) => s.stage).join(' → ') || '-'}`)

  const pre = stageOf(stages, 'PRE_FLIGHT')
  const routing = stageOf(stages, 'ROUTING')
  const request = stageOf(stages, 'REQUEST_READY')
  const response = stageOf(stages, 'CARRIER_RESPONSE')
  const final = stageOf(stages, 'FINAL')

  console.info('\n═══ KARAR / MAPPING ═════════════════════════════════════')
  for (const key of [
    'billingParty', 'expectedSuratWhoPays', 'credentialRole', 'credentialSource',
    'odemeTipi', 'codEnabled', 'codCollectionType',
    'pazaryerimi', 'entegrasyonFirmasi',
    'marketplaceIdentitySource', 'marketplaceIdentityPresent',
    'preflightValid',
  ]) {
    const value = pre[key] ?? routing[key] ?? summary[key]
    console.info(`${key.padEnd(28)} ${describeField(key, value)}`)
  }

  // KAYIT KİMLİĞİ — hangi organizasyonun hangi satırı okundu?
  //
  // Kanarya AYNI alanları basar. ****2622 ile ****0944 ayrışması ancak bu iki
  // çıktı yan yana konduğunda KANITLANABİLİR; kimlik görünmezse iki taraf da
  // "kiracı deposundan okudum" der ve çelişki ölçülemez kalır.
  console.info('\n═══ KAYIT KİMLİĞİ ═══════════════════════════════════════')
  for (const key of [
    'tenantOrganizationIdMasked', 'tenantIntegrationIdMasked',
    'tenantIntegrationConfigured',
  ]) {
    const value = routing[key] ?? summary[key]
    console.info(
      `${key.padEnd(28)} ${value === undefined ? 'UNKNOWN' : describeField(key, value)}`,
    )
  }

  console.info('\n═══ KİMLİK PARİTESİ ═════════════════════════════════════')
  for (const key of [
    'resolverAccountFingerprint', 'wireAccountFingerprint', 'credentialMatch',
    'maskedAccount', 'credentialResolved',
  ]) {
    const value = routing[key] ?? request[key] ?? summary[key]
    console.info(`${key.padEnd(28)} ${describeField(key, value)}`)
  }

  console.info(String.fromCharCode(10) + '═══ ACTUAL_WIRE — NIHAI GOVDEDEN ═══════════════════════')
  // ÖLÇÜLEN KUSUR (CF-4088628726): burada `REQUEST_READY` okunuyor ve ham
  // `Gonderi`/`OdemeTipi` anahtarları aranıyordu; yakalama ise
  // `ACTUAL_WIRE_READY` aşamasına `gonderiFieldTypes`/`safeValues` yazıyor.
  // Sonuç: iz DOLUYKEN denetçi her alanı ABSENT gösteriyordu.
  const wire = projectActualWire(stages)
  if (wire.status === 'STAGE_MISSING') {
    // "Aşama yok" ile "alan yok" AYNI ŞEY DEĞİLDİR.
    console.info('ACTUAL_WIRE                  STAGE_MISSING (aga cikilmadi)')
  } else {
    console.info(`rootRuntimeType              ${wire.rootRuntimeType}`)
    console.info(`gonderiRuntimeType           ${wire.gonderiRuntimeType}`)
    console.info(`serializedLength             ${String(wire.serializedLength)}`)
    for (const [field, view] of Object.entries(wire.fields)) {
      console.info(
        `${field.padEnd(28)} ${view.runtimeType} · ${String(view.value)}`,
      )
    }
  console.info(String.fromCharCode(10) + '--- alan calisma zamani tipleri ---')
    for (const [field, type] of Object.entries(wire.fieldRuntimeTypes)) {
      console.info(`${field.padEnd(28)} ${type}`)
    }
  console.info(String.fromCharCode(10) + '--- kimlik parmak izleri ---')
    for (const [key, value] of Object.entries(wire.credential)) {
      console.info(`${key.padEnd(34)} ${String(value)}`)
    }
  }

  console.info(String.fromCharCode(10) + '═══ TASIYICI GERCEGI (izden) ════════════════════════════')
  for (const [key, value] of Object.entries(projectCarrierTruth(stages))) {
    console.info(`${key.padEnd(28)} ${String(value)}`)
  }

  console.info('\n═══ CARRIER RESPONSE ════════════════════════════════════')
  for (const key of [
    'httpStatus', 'businessResult', 'carrierCode', 'carrierMessage',
    'trackingPresent', 'barcodePresent', 'zplPresent',
    'carrierCalled', 'carrierCreateStatus', 'carrierCreateAttempts',
    'carrierExceptionSummary',
  ]) {
    const value = response[key] ?? final[key] ?? summary[key]
    console.info(`${key.padEnd(28)} ${describeField(key, value)}`)
  }

  console.info('\n═══ FINAL ═══════════════════════════════════════════════')
  console.info(JSON.stringify(redactTraceValue(final), null, 2))
  // ═══ SAYAÇLAR DENETÇİYE AİTTİR ═══════════════════════════════════════
  // ÖLÇÜLEN KUSUR: geçmiş bir deneme için `NETWORK_CALLS 0` basılıyordu ve
  // AYNI iz `carrierCalled=true` diyordu. Okuyan kişi bunu DENEMENİN özelliği
  // sanıyordu. Sayaçlar bu CLI'ın KENDİ yan etkileridir; taşıyıcı gerçeği
  // yukarıdaki "TASIYICI GERCEGI" bölümündedir.
  console.info('\n' + INSPECTOR_SIDE_EFFECT_COUNTERS)
}

async function main(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[surat:trace] DATABASE_URL tanımlı değil.')
    return 1
  }
  const traceId = readArg('trace')
  const org = readArg('org')
  const db = getDb()

  if (hasFlag('list') || !traceId) {
    if (!org) {
      console.error('[surat:trace] --trace <traceId> VEYA --org <id> --list gerekli.')
      return 1
    }
    const rows = await db.select().from(suratTraceAttempts)
      .where(eq(suratTraceAttempts.organizationId, org))
      .orderBy(desc(suratTraceAttempts.createdAt))
      .limit(200)
    console.info(`TRACE_COUNT=${rows.length}`)
    for (const row of rows as Record<string, unknown>[]) {
      console.info(
        `${String(row.createdAt)}  ${String(row.traceId).padEnd(20)} `
        + `${String(row.orderNumber ?? '-').padEnd(14)} ${String(row.finalState ?? '-')}`,
      )
    }
    return 0
  }

  const where = org
    ? and(
        eq(suratTraceAttempts.organizationId, org),
        eq(suratTraceAttempts.traceId, traceId),
      )
    : eq(suratTraceAttempts.traceId, traceId)
  const rows = await db.select().from(suratTraceAttempts).where(where).limit(1)
  const row = (rows as Record<string, unknown>[])[0]
  if (!row) {
    console.error(`[surat:trace] iz bulunamadı: ${traceId}`)
    return 1
  }
  report(row)
  return 0
}

const invokedDirectly = process.argv[1]?.includes('suratTraceInspectCli')
if (invokedDirectly) {
  const code = await main().catch((error) => {
    console.error(
      '[surat:trace] hata:',
      error instanceof Error ? error.message : String(error),
    )
    return 1
  })
  await closePool().catch(() => undefined)
  process.exit(code)
}

export { describeField, runtimeType, AUDITED_WIRE_FIELDS }
