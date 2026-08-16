// FATURALAMA TARAFI TEŞHİSİ (CLI) — SALT OKUNUR.
//
// Kullanım:
//   npm run surat:billing:inspect -- --org <organizationId> --package <packageId>
//   npm run surat:billing:inspect -- --org <organizationId> --package <packageId> --get-cargo
//
// VARSAYILAN OLARAK AĞA ÇIKMAZ. `--get-cargo` verilmedikçe yalnız yerel veriye
// bakar. Hiçbir yazma, hiçbir create, hiçbir config değişikliği yapmaz.
//
// GİZLİLİK: müşteri adı/adres/telefon/e-posta, kimlik bilgisi kullanıcı adı ve
// şifresi, ham şifreli yük ASLA basılmaz. Yalnız operasyonel payer metadatası.
import { and, eq } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { loadOrganizationIntegrationConfig } from '../integrations/credentialService.ts'
import { organizationSettings, shipments } from '../db/schema.ts'
import { decryptOrderPayload } from '../orders/orderEncryption.ts'
import { decryptShipmentPayload } from './shipmentEncryption.ts'
import {
  buildBillingObservation,
  inspectTrendyolBillingSource,
} from './suratBillingParty.ts'
import {
  getSuratCargoByParcelUniqueId,
  isGetCargoConfigured,
} from './suratGetCargoClient.ts'
import {
  maskIdentifier,
  resolveBillingInspectionTarget,
  resolveOrganizationByName,
} from './suratBillingScanner.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function readArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`)

/** `****abcd` — tam kimlik BASILMAZ. */
const mask = (value: unknown): string => {
  const text = String(value ?? '').trim()
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`
}

const safe = (value: unknown): string => {
  const text = String(value ?? '').trim()
  return text || '—'
}

export interface BillingInspectionReport {
  organizationMasked: string
  /** Kimliğin hangi kanonik alanda bulunduğu (teşhis şeffaflığı). */
  matchedField: string
  packageIdMasked: string
  marketplace: string
  rawSourceField: string | null
  rawValue: string | null
  expectedBillingParty: string
  expectedBillingPartySource: string
  credentialClass: string
  parcelUniqueId: string | null
  shipmentIds: string[]
  getCargoRequested: boolean
  getCargoStatus: string
  actualSuratWhoPays: string | null
  actualBillingParty: string
  senderCode: string | null
  billingVerificationStatus: string
}

/**
 * Tek sipariş için teşhis — SALT OKUNUR.
 *
 * `credentialClass` yalnız SINIF adıdır (PRIMARY/SELLER_PAYS/COD); kullanıcı
 * adı veya şifre okunmaz ve basılmaz.
 */
export async function inspectOrderBilling(
  db: Db,
  organizationId: string,
  packageId: string,
  options: { getCargo?: boolean; getCargoConfig?: Record<string, unknown> } = {},
): Promise<BillingInspectionReport | null> {
  // ÇOK ALANLI ÇÖZÜM: tarayıcı aday olarak `cargoTrackingNumber` (727…) üretiyor;
  // tek alanlı `packageId` araması bu yüzden çalışmıyordu.
  const target = await resolveBillingInspectionTarget(db, organizationId, packageId)
  if (target.status === 'ambiguous') {
    // Yanlış siparişte faturalama teşhisi yanlış sonuç üretir.
    throw Object.assign(new Error('AMBIGUOUS_IDENTIFIER'), {
      matchedField: target.matchedField,
      matches: target.matches,
    })
  }
  if (target.status !== 'ok') return null
  const orderRow = target.order
  const matchedField = target.matchedField

  // Ham Trendyol yükü YALNIZ bu tek kayıt için çözülür (sınırlı teşhis).
  let rawOrder: Record<string, unknown> = {}
  try {
    const decrypted = decryptOrderPayload(
      orderRow.rawPayloadEncrypted as string | null,
    )
    if (decrypted && typeof decrypted === 'object') {
      rawOrder = decrypted as Record<string, unknown>
    }
  } catch {
    rawOrder = {}
  }

  const inspection = inspectTrendyolBillingSource({ ...orderRow, rawOrder })

  const shipmentRows = (await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.packageId, packageId),
      ),
    )) as Record<string, unknown>[]

  // Pazaryeri paket kimliği (727…) — kanonik `OzelKargoTakipNo` kaynağı.
  let parcelUniqueId = String(orderRow.cargoTrackingNumber ?? '').trim()
  for (const shipment of shipmentRows) {
    if (parcelUniqueId) break
    try {
      const payload = decryptShipmentPayload(
        shipment.carrierPayloadEncrypted as string | null,
      ) as Record<string, unknown> | null
      parcelUniqueId = String(payload?.ozelKargoTakipNo ?? '').trim()
    } catch {
      /* teşhis kırılmaz */
    }
  }

  let getCargoStatus = 'SKIPPED'
  let whoPays: string | null = null
  let senderCode: string | null = null
  if (options.getCargo) {
    const config = options.getCargoConfig ?? {}
    if (!isGetCargoConfigured(config)) {
      // TAHMİNİ ADRESE İSTEK YOK.
      getCargoStatus = 'NOT_CONFIGURED'
    } else {
      const outcome = await getSuratCargoByParcelUniqueId({
        parcelUniqueId,
        config,
      })
      getCargoStatus = outcome.status
      whoPays = outcome.record?.whoPays ?? null
      senderCode = outcome.record?.senderCode ?? null
    }
  }

  const observation = buildBillingObservation({
    order: { ...orderRow, rawOrder },
    suratWhoPays: whoPays,
    senderCode,
  })

  return {
    organizationMasked: mask(organizationId),
    matchedField,
    packageIdMasked: mask(orderRow.packageId),
    marketplace: String(orderRow.marketplace ?? ''),
    rawSourceField: inspection.sourceField,
    rawValue: inspection.rawValue,
    expectedBillingParty: observation.expectedBillingParty,
    expectedBillingPartySource: observation.expectedBillingPartySource,
    // Bugünkü üretim davranışı: açık satıcı-öder sinyali olmadığı sürece
    // birincil hesap kullanılır (forensic audit bulgusu). Bu tur bunu
    // DEĞİŞTİRMEZ; yalnız raporlar.
    credentialClass: 'PRIMARY',
    parcelUniqueId: parcelUniqueId || null,
    shipmentIds: shipmentRows.map((row) => mask(row.id)),
    getCargoRequested: Boolean(options.getCargo),
    getCargoStatus,
    actualSuratWhoPays: observation.actualSuratWhoPays,
    actualBillingParty: observation.actualBillingParty,
    senderCode: observation.senderCode,
    billingVerificationStatus: observation.billingVerificationStatus,
  }
}

export function formatBillingReport(report: BillingInspectionReport): string[] {
  return [
    `ORGANIZATION            ${report.organizationMasked}`,
    `ORDER_FOUND             YES`,
    `MATCHED_FIELD           ${report.matchedField}`,
    `PACKAGE                 ${report.packageIdMasked}`,
    `MARKETPLACE             ${safe(report.marketplace)}`,
    '',
    `RAW_PAYER_FIELD         ${safe(report.rawSourceField)}`,
    `RAW_PAYER_VALUE         ${safe(report.rawValue)}`,
    `EXPECTED_BILLING_PARTY  ${report.expectedBillingParty}`,
    `EXPECTED_SOURCE         ${report.expectedBillingPartySource}`,
    `CREDENTIAL_CLASS        ${report.credentialClass}`,
    '',
    `PARCEL_UNIQUE_ID        ${safe(report.parcelUniqueId)}`,
    `SHIPMENT_IDS            ${report.shipmentIds.join(', ') || '—'}`,
    '',
    `GET_CARGO_REQUESTED     ${report.getCargoRequested ? 'YES' : 'NO'}`,
    `GET_CARGO_STATUS        ${report.getCargoStatus}`,
    `ACTUAL_SURAT_WHO_PAYS   ${safe(report.actualSuratWhoPays)}`,
    `ACTUAL_BILLING_PARTY    ${report.actualBillingParty}`,
    `SENDER_CODE             ${safe(report.senderCode)}`,
    `VERIFICATION            ${report.billingVerificationStatus}`,
  ]
}

/**
 * getCargo YAPILANDIRMASI — İKİ KANITLI KAYNAK, TAHMİN YOK.
 *
 * BULGU (üretimde çöktü): önceki sürüm ham SQL ile `select settings from
 * organization_settings` yazıyordu; oysa kolonun gerçek adı `settings_json`.
 * Tablo üretimde VAR (migration 0004) — sorun tablo değil, YANLIŞ KOLONDU.
 * Artık tipli tablo referansı kullanılıyor, böylece kolon adı derleyici
 * tarafından kontrol ediliyor ve bir daha kayamaz.
 *
 * Sıra: (1) tenant Sürat entegrasyon yapılandırması — tarayıcının da kullandığı
 * kanonik kaynak, (2) organizasyon ayarlarındaki `suratGetCargo` bloğu.
 * Hiçbiri yoksa BOŞ döner ve çağıran NOT_CONFIGURED üretir; uydurma adres YOK.
 *
 * Bu fonksiyon HİÇBİR koşulda fırlatmaz: teşhis aracı şema farkı yüzünden
 * çökmemelidir.
 */
export async function resolveGetCargoConfig(
  db: Db,
  organizationId: string,
): Promise<Record<string, unknown>> {
  // (1) Tenant Sürat yapılandırması.
  try {
    const config = (await loadOrganizationIntegrationConfig(
      db as never,
      organizationId,
    )) as Record<string, unknown> | null
    const surat = (config?.surat ?? {}) as Record<string, unknown>
    const baseUrl = String(surat.getCargoBaseUrl ?? '').trim()
    const path = String(surat.getCargoPath ?? '').trim()
    if (baseUrl && path) {
      return { baseUrl, path, apiKey: surat.getCargoApiKey }
    }
  } catch {
    // Yapılandırma okunamadı → sonraki kaynağa geç (çökme YOK).
  }
  // (2) Organizasyon ayarları (`settings_json`).
  try {
    const rows = (await db
      .select({ settings: organizationSettings.settingsJson })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)) as { settings: unknown }[]
    const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>
    const block = (settings.suratGetCargo ?? {}) as Record<string, unknown>
    if (String(block.baseUrl ?? '').trim() && String(block.path ?? '').trim()) {
      return block
    }
  } catch {
    // Tablo/kolon farkı teşhisi DÜŞÜRMEZ.
  }
  return {}
}

/**
 * YAPILANDIRMA ANAHTARI KEŞFİ — SALT OKUNUR, DEĞER BASMAZ.
 *
 * getCargo sözleşmesi repoda YOK (git geçmişi, dist ve loglar tarandı). Bir
 * sonraki gerçek adım üretimdeki tenant yapılandırmasında hangi anahtarların
 * BULUNDUĞUNU görmek. Bu fonksiyon YALNIZ anahtar ADLARINI ve "dolu mu"
 * bilgisini üretir — DEĞERLER ASLA basılmaz.
 *
 * Host benzeri değerlerde yalnız alan adı gösterilir; URL'in kendisi bile
 * kimlik bilgisi taşıyabileceği için tam basılmaz.
 */
export function describeConfigKeys(
  config: Record<string, unknown> = {},
): { key: string; present: boolean; kind: string }[] {
  const secretish = /(sifre|password|secret|token|key|auth)/i
  return Object.keys(config)
    .sort()
    .map((key) => {
      const value = config[key]
      const filled =
        value !== null && value !== undefined && String(value).trim() !== ''
      return {
        key,
        present: filled,
        // Tür ipucu operatöre yeter; değer GEREKMEZ.
        kind: secretish.test(key)
          ? 'secret(masked)'
          : typeof value === 'object' && value !== null
            ? 'object'
            : typeof value,
      }
    })
}

/** Tenant Sürat yapılandırmasının anahtarlarını salt okunur listeler. */
export async function inspectConfigKeys(
  db: Db,
  organizationId: string,
): Promise<{ suratKeys: ReturnType<typeof describeConfigKeys>; settingsKeys: string[] }> {
  let suratKeys: ReturnType<typeof describeConfigKeys> = []
  try {
    const config = (await loadOrganizationIntegrationConfig(
      db as never,
      organizationId,
    )) as Record<string, unknown> | null
    suratKeys = describeConfigKeys((config?.surat ?? {}) as Record<string, unknown>)
  } catch {
    suratKeys = []
  }
  let settingsKeys: string[] = []
  try {
    const rows = (await db
      .select({ settings: organizationSettings.settingsJson })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)) as { settings: unknown }[]
    const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>
    settingsKeys = Object.keys(settings).sort()
  } catch {
    settingsKeys = []
  }
  return { suratKeys, settingsKeys }
}

/**
 * ÖZET İÇİN İZİN VERİLEN ALANLAR — BEYAZ LİSTE.
 *
 * Kara liste yerine beyaz liste: yeni bir kimlik alanı eklendiğinde otomatik
 * olarak DIŞARIDA kalır. Kara liste olsaydı yeni sır alanı sessizce sızardı.
 */
export const CONFIG_SUMMARY_ALLOWLIST = [
  'serviceMode',
  'serviceType',
  'createShipmentPath',
  'trackingServiceType',
  'trackingPath',
  'restSenderId',
  'firmaId',
  'entegrasyonFirmasi',
  'odemeTipi',
  'allowPreRegistrationRest',
] as const

/** Adı sır çağrıştıran her alan — DEĞERİ ASLA gösterilmez. */
const SECRETISH_KEY = /(kullaniciadi|username|sifre|password|webpassword|apikey|api_key|token|authorization|credential|secret|auth)/i

/** URL benzeri değerlerde kimlik/sorgu taşıyan kısımları TEMİZLER. */
export function redactUrlLike(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  try {
    const url = new URL(text)
    // userinfo (user:pass@) ve tüm sorgu dizesi ATILIR.
    return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?<redacted>' : ''}`
  } catch {
    return '<redacted-url>'
  }
}

export interface ConfigSummary {
  allowed: { key: string; value: string }[]
  /** İzin listesinde OLMAYAN alanlar: yalnız ad + tür + doluluk. */
  unknown: { key: string; kind: string; present: boolean }[]
}

/**
 * SALT OKUNUR YAPILANDIRMA ÖZETİ.
 *
 * İzin listesindeki alanların DEĞERİ gösterilir (hiçbiri kimlik bilgisi
 * değildir); geri kalan her şey yalnız ad/tür/doluluk olarak listelenir.
 * Sır çağrıştıran adlar izin listesinde olsa bile değeri BASILMAZ.
 */
export function buildConfigSummary(
  config: Record<string, unknown> = {},
): ConfigSummary {
  const allowed: { key: string; value: string }[] = []
  for (const key of CONFIG_SUMMARY_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) continue
    if (SECRETISH_KEY.test(key)) continue
    const raw = config[key]
    if (raw === null || raw === undefined || String(raw).trim() === '') continue
    allowed.push({ key, value: redactUrlLike(raw) })
  }
  const allowSet = new Set<string>(CONFIG_SUMMARY_ALLOWLIST)
  const unknown = Object.keys(config)
    .filter((key) => !allowSet.has(key))
    .sort()
    .map((key) => {
      const raw = config[key]
      return {
        key,
        kind: SECRETISH_KEY.test(key)
          ? 'secret(masked)'
          : typeof raw === 'object' && raw !== null
            ? 'object'
            : typeof raw,
        present:
          raw !== null && raw !== undefined && String(raw).trim() !== '',
      }
    })
  return { allowed, unknown }
}

export function formatConfigSummary(summary: ConfigSummary): string[] {
  const lines = ['CONFIG_SUMMARY']
  if (summary.allowed.length === 0) lines.push('  —')
  for (const entry of summary.allowed) {
    lines.push(`  ${entry.key}=${entry.value}`)
  }
  lines.push('', 'UNKNOWN/DYNAMIC KEYS (deger BASILMAZ)')
  if (summary.unknown.length === 0) lines.push('  —')
  for (const entry of summary.unknown) {
    lines.push(
      `  ${entry.key.padEnd(32)} type=${entry.kind}  present=${entry.present ? 'YES' : 'NO'}`,
    )
  }
  return lines
}

export async function runSuratBillingInspect(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[surat:billing] DATABASE_URL tanımlı değil.')
    return 1
  }
  const db = getDb()
  const packageId = readArg('package')
  // `--name` ile tenant çözümü (UUID aramak gerekmez); `--org` GERİYE UYUMLU.
  let organizationId = readArg('org')
  const name = readArg('name')
  if (!organizationId && name) {
    const resolved = await resolveOrganizationByName(db, name)
    if (resolved.status === 'not_found') {
      console.error(`[surat:billing] "${name}" için tenant bulunamadı.`)
      return 1
    }
    if (resolved.status === 'ambiguous') {
      console.error('[surat:billing] BİRDEN FAZLA eşleşme — tahmin YOK:')
      for (const candidate of resolved.candidates) {
        console.error(`  ${maskIdentifier(candidate.id)}  ${candidate.name}`)
      }
      return 1
    }
    organizationId = resolved.organization.id
  }
  if (!organizationId || !packageId) {
    console.error('[surat:billing] (--org veya --name) ve --package ZORUNLU.')
    return 1
  }
  const getCargoConfig = hasFlag('get-cargo')
    ? await resolveGetCargoConfig(db, organizationId)
    : {}

  // YAPILANDIRMA ÖZETİ: izin listeli alanların değeri + diğerlerinin yalnız adı.
  if (hasFlag('config-summary')) {
    let surat: Record<string, unknown> = {}
    try {
      const config = (await loadOrganizationIntegrationConfig(
        db as never,
        organizationId,
      )) as Record<string, unknown> | null
      surat = (config?.surat ?? {}) as Record<string, unknown>
    } catch {
      surat = {}
    }
    console.info(`ORGANIZATION            ${mask(organizationId)}`)
    for (const line of formatConfigSummary(buildConfigSummary(surat))) {
      console.info(line)
    }
    return 0
  }

  // ANAHTAR KEŞFİ: getCargo sözleşmesini üretim yapılandırmasında aramak için.
  if (hasFlag('config-keys')) {
    const { suratKeys, settingsKeys } = await inspectConfigKeys(db, organizationId)
    console.info(`ORGANIZATION            ${mask(organizationId)}`)
    console.info('SURAT_CONFIG_KEYS (degerler BASILMAZ)')
    if (suratKeys.length === 0) console.info('  —')
    for (const entry of suratKeys) {
      console.info(
        `  ${entry.key.padEnd(32)} present=${entry.present ? 'YES' : 'NO'}  kind=${entry.kind}`,
      )
    }
    console.info('SETTINGS_JSON_KEYS')
    console.info(`  ${settingsKeys.join(', ') || '—'}`)
    return 0
  }

  let report
  try {
    report = await inspectOrderBilling(db, organizationId, packageId, {
      getCargo: hasFlag('get-cargo'),
      getCargoConfig,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'AMBIGUOUS_IDENTIFIER') {
      console.error(
        '[surat:billing] BELİRSİZ kimlik — birden fazla sipariş eşleşti; tahmin YOK.',
      )
      return 1
    }
    throw error
  }
  if (!report) {
    console.error('[surat:billing] Sipariş bulunamadı (tenant kapsamında).')
    return 1
  }
  for (const line of formatBillingReport(report)) console.info(line)
  if (report.billingVerificationStatus === 'MISMATCH') {
    // GÖZLEM: bu tur baskıyı/başarıyı ETKİLEMEZ, yalnız raporlar.
    console.info('')
    console.info('[surat:billing] BILLING_PARTY_MISMATCH — yalnız gözlem.')
  }
  return 0
}

const invokedDirectly = process.argv[1]?.includes('suratBillingInspectCli')
if (invokedDirectly) {
  runSuratBillingInspect()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(
        '[surat:billing] Teşhis başarısız:',
        error instanceof Error ? error.message : error,
      )
      process.exitCode = 2
    })
    .finally(() => closePool().catch(() => undefined))
}
