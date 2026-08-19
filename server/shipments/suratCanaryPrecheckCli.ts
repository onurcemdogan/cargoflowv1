// KANARYA ÖN KONTROLÜ — SALT OKUNUR.
//
// Hiçbir yazma, hiçbir taşıyıcı çağrısı, hiçbir config değişikliği yapmaz.
// Credential DEĞERLERİ asla basılmaz; yalnız varlık + maskeli iz.
//
// Kullanım:
//   npm run surat:canary-precheck -- --org <organizationId>
import { sql } from 'drizzle-orm'
import { getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  isCredentialEncryptionConfigured,
  loadOrganizationIntegrationConfig,
} from '../integrations/credentialService.ts'
import {
  resolveCanonicalTenantSuratAccount,
  resolveSuratBillingParty,
  SURAT_CANONICAL_SERVICE_MODE,
} from './suratCanonicalCreateAdapter.ts'
import {
  SURAT_CANONICAL_LIVE_API_BASE_URL,
  SURAT_CANONICAL_CREATE_PATH,
} from './suratWebApiClient.ts'
import { SURAT_MARKETPLACE_REGISTRY } from './suratCanonicalGonderiModel.ts'
import { normalizeAuthoritativeSuratStore } from './suratCredentialSnapshot.ts'

const present = (value: unknown): string =>
  String(value ?? '').trim() ? 'YES' : 'NO'

function readArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

/** `org_…abcd` — tam kimlik basılmaz. */
function maskIdentifier(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 4) return '****'
  return `****${trimmed.slice(-4)}`
}

/**
 * Tenant adına göre SALT OKUNUR organization araması.
 *
 * Birden fazla aday bulunursa TAHMİN YAPILMAZ: adaylar maskeli listelenir
 * ve çağıran durur.
 */
async function findOrganizationByName(
  name: string,
): Promise<{ id: string; name: string; slug: string; status: string }[]> {
  const pattern = `%${name}%`
  const rows = await getDb().execute(
    sql`select id, name, slug, status from organizations
        where name ilike ${pattern} or slug ilike ${pattern}
        order by name`,
  )
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) ?? []
  return list as { id: string; name: string; slug: string; status: string }[]
}

export async function runSuratCanaryPrecheck(): Promise<number> {
  // Yetkili veri kaynağını AÇIKÇA bildir. Bu betik `.env` yüklemediği için
  // aynı hostta `surat:billing:inspect` çalışırken burada DATABASE_URL
  // görünmüyordu; kök neden Postgres'in kapalı olması DEĞİLDİ.
  if (!isDatabaseConfigured()) {
    console.log('DATA_SOURCE                  : ÇÖZÜLEMEDİ')
    console.log('AUTHORITATIVE_SOURCE_RESOLVED: NO')
    console.log('')
    console.log('BLOCKED_EXTERNAL / CONFIG_NOT_FOUND')
    console.log(
      'DATABASE_URL bu süreçte görünmüyor. Aynı hostta '
      + '`npm run surat:billing:inspect` calisiyorsa neden Postgres degil, '
      + '.env yuklenmemesidir.',
    )
    return 1
  }
  console.log('DATA_SOURCE                  : POSTGRES')
  console.log('AUTHORITATIVE_SOURCE_RESOLVED: YES')
  let organizationId = readArg('org')
  const nameQuery = readArg('name')
  if (!organizationId && !nameQuery) {
    console.error('--org <organizationId> veya --name <tenant adı> zorunludur.')
    return 2
  }
  if (!organizationId && nameQuery) {
    const candidates = await findOrganizationByName(nameQuery)
    if (candidates.length === 0) {
      console.log(`ORGANIZATION FOUND : NO ("${nameQuery}" eşleşmedi)`)
      return 1
    }
    if (candidates.length > 1) {
      console.log(`ORGANIZATION FOUND : BELİRSİZ (${candidates.length} aday)`)
      for (const row of candidates) {
        console.log(
          `  - ${row.name} | slug=${row.slug} | status=${row.status} | id=${maskIdentifier(row.id)}`,
        )
      }
      console.log('\nTAHMİN YAPILMADI. Doğru adayın tam id\'siyle --org kullanın.')
      return 1
    }
    organizationId = candidates[0].id
    console.log(
      `ORGANIZATION FOUND : YES | ${candidates[0].name} | slug=${candidates[0].slug} | status=${candidates[0].status}`,
    )
    console.log(`ORG ID (masked)    : ${maskIdentifier(organizationId)}`)
    console.log('')
  }
  if (!isCredentialEncryptionConfigured()) {
    console.error('CREDENTIAL_ENCRYPTION_KEY tanımlı değil; ön kontrol yapılamaz.')
    return 2
  }
  // Repo deseni: drizzle istemcisi credential okuyucusunun dar sözleşmesine
  // aynı şekilde köprülenir (bkz. trendyolPackageIdentityTraceCli).
  const config = await loadOrganizationIntegrationConfig(
    getDb() as unknown as Parameters<typeof loadOrganizationIntegrationConfig>[0],
    organizationId,
  )
  const stored = (config?.surat ?? {}) as Record<string, unknown>
  // KAYITLI PAYLOAD ÇALIŞMA ZAMANI GİBİ TÜRETİLİR.
  // `loadOrganizationIntegrationConfig` şifresi çözülmüş HAM kaydı döner;
  // çalışma zamanında ise `tenantInjectCredentials` bunu normalizeSuratConfig
  // üzerinden geçirir ve `canonicalPrimary*` alanları orada doğar. Ön kontrol
  // normalizasyonu atlarsa kanonik hesabı ASLA göremez ve YANLIŞ BLOCKED
  // üretir. Bu yüzden aynı paylaşılan türev burada da uygulanır.
  // TEK NORMALIZASYON YOLU — canli create ile AYNI fonksiyon.
  const surat: Record<string, unknown> =
    normalizeAuthoritativeSuratStore(stored)

  // Kanonik yolun okuduğu hesap kümeleri — DEĞERLER BASILMAZ.
  const primary = resolveCanonicalTenantSuratAccount(surat, 'PRIMARY')
  const sellerPays = resolveCanonicalTenantSuratAccount(surat, 'SELLER_PAYS')
  const cod = resolveCanonicalTenantSuratAccount(surat, 'CASH_ON_DELIVERY')

  // Sıradan (COD olmayan, açık gönderici-öder işareti taşımayan) bir sipariş
  // hangi kümeyi seçerdi?
  const normalParty = resolveSuratBillingParty({ order: {}, cashOnDelivery: false })

  const serviceMode = String(surat.serviceMode ?? '')
  const canonicalSelected = serviceMode === SURAT_CANONICAL_SERVICE_MODE

  // Bu build kanonik modu tanıyor mu? (servis modu sabiti + kayıtlı
  // pazaryeri kaynağı). Tenant config'inden BAĞIMSIZ yapısal kontrol.
  const canonicalSupported = SURAT_CANONICAL_SERVICE_MODE === 'SURAT_CANONICAL_API'
  const trendyol = SURAT_MARKETPLACE_REGISTRY.TRENDYOL
  const trendyolReady =
    trendyol?.entegrasyonFirmasi === 'Trendyol' &&
    trendyol?.trackingSource === 'cargoTrackingNumber'

  // Env override kontrolü: kanonik yol bu değişkenleri OKUMAZ; burada
  // yalnız VARLIKLARI raporlanır (değerleri asla).
  const envPresent = [
    'SURAT_LIVE_KULLANICI_ADI', 'SURAT_LIVE_CARI_KODU', 'SURAT_LIVE_SIFRE',
    'SURAT_TEST_KULLANICI_ADI', 'SURAT_TEST_CARI_KODU', 'SURAT_TEST_SIFRE',
  ].filter((key) => String(process.env[key] ?? '').trim() !== '')

  const lines = [
    '=== SÜRAT KANARYA ÖN KONTROLÜ (SALT OKUNUR) ===',
    `TENANT                        : ${maskIdentifier(organizationId)}`,
    `ACTIVE SURAT INTEGRATION      : ${present(surat.kullaniciAdi) === 'YES' || primary ? 'YES' : 'NO'}`,
    `CURRENT SERVICE MODE          : ${serviceMode || '(tanımsız)'}`,
    `CANONICAL MODE SELECTED       : ${canonicalSelected ? 'YES' : 'NO'}`,
    '',
    `PRIMARY CUSTOMER CODE         : ${present(surat.canonicalPrimaryKullaniciAdi)}`,
    `PRIMARY SHIPPING PASSWORD     : ${present(surat.canonicalPrimarySifre)}`,
    `PRIMARY ACCOUNT FINGERPRINT   : ${primary?.accountFingerprint || '(çözülemedi)'}`,
    '',
    `SELLER-PAYS ACCOUNT CONFIGURED: ${sellerPays ? 'YES' : 'NO'}`,
    `COD ACCOUNT CONFIGURED        : ${cod ? 'YES' : 'NO'}`,
    `NORMAL SHIPMENT SELECTS       : ${normalParty}`,
    `NORMAL USES PRIMARY ONLY      : ${normalParty === 'PRIMARY' ? 'YES' : 'NO'}`,
    '',
    `CANONICAL SERVICE SUPPORTED   : ${canonicalSupported ? 'YES' : 'NO'}`,
    `MARKETPLACE SOURCE            : ${trendyolReady ? 'TRENDYOL_READY' : 'TRENDYOL_UNAVAILABLE'}`,
    `CANONICAL HOST                : ${SURAT_CANONICAL_LIVE_API_BASE_URL}`,
    `CANONICAL ENDPOINT            : ${SURAT_CANONICAL_CREATE_PATH}`,
    `ENV CREDENTIAL VARS PRESENT   : ${envPresent.length === 0 ? 'NONE' : envPresent.join(', ')}`,
    '  (kanonik yol bunları OKUMAZ; yalnız legacy dallar etkilenir)',
  ]
  console.log(lines.join('\n'))

  const blockers: string[] = []
  if (!primary) blockers.push('PRIMARY_ACCOUNT_MISSING')
  if (normalParty !== 'PRIMARY') blockers.push('NORMAL_SHIPMENT_NOT_PRIMARY')
  if (!canonicalSupported) blockers.push('CANONICAL_SERVICE_UNSUPPORTED')
  if (!trendyolReady) blockers.push('TRENDYOL_SOURCE_UNAVAILABLE')
  console.log('')
  console.log(
    blockers.length === 0
      ? 'CANARY PRECHECK: READY (config tarafı)'
      : `CANARY PRECHECK: BLOCKED → ${blockers.join(', ')}`,
  )
  return blockers.length === 0 ? 0 : 1
}

const invokedDirectly = process.argv[1]?.includes('suratCanaryPrecheckCli')
if (invokedDirectly) {
  runSuratCanaryPrecheck()
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      console.error('Ön kontrol başarısız:', error instanceof Error ? error.message : error)
      process.exitCode = 2
    })
}
