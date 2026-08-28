// WORKER BOOTSTRAP ÖN KONTROLÜ — ÜRETİM ÇALIŞMA ZAMANINDA, SALT OKUNUR.
//
//   npm run auto-label:worker:preflight -- --name TarzimTuba --package <ID>
//
// ═══ NEDEN AYRI BİR KOMUT ════════════════════════════════════════════════
// Mevcut CLI'lar `tsx` ile çalışır; ÜRETİM sunucusu `node server/index.mjs`
// ile çalışır. Node'un ESM çözücüsü uzantısız göreli `.ts` import'unu
// ÇÖZMEZ, `tsx` çözer. Bu fark yüzünden aday seçici "her şey yolunda" derken
// worker hazırlığı `Cannot find module` ile patladı ve iş
// `SURAT_PREFLIGHT_FAILED` yazdı.
//
// Bu komut BİLEREK `tsx` DEĞİL, DÜZ `node` ile çalışır — worker'ın gördüğü
// ÇÖZÜCÜNÜN AYNISI. Ölçtüğümüz şey, üretimin çalıştırdığı şeydir.
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • İşin `QUEUED` olması GEREKMEZ; BLOCKED satırlarda da çalışır.
//   • Hiçbir satır YAZILMAZ, worker ÇALIŞTIRILMAZ, Sürat ÇAĞRILMAZ.
//   • Taşıyıcı ağının HEMEN ÖNCESİNDE durur.
//   • Sır BASILMAZ: kimlik yalnız `resolved` bayrağı ve rol olarak görünür.
import process from 'node:process'

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function fail(message: string): never {
  console.error(`[worker-preflight] ${message}`)
  process.exit(1)
}

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')
const packageId = readFlag('package')
if (!packageId) fail('Paket ZORUNLU: --package 4110965877')

// ═══ BOOTSTRAP — WORKER'IN YÜKLEDİĞİ MODÜLLERİN AYNISI ═══════════════════
let bootstrapOk = false
let bootstrapError: string | null = null
let getDb: (() => unknown) | null = null
let prepareLabelJob: unknown = null
let resolveOrganizationByName: unknown = null
try {
  const [client, preparation, catchup] = await Promise.all([
    import('../db/client.ts'),
    import('./labelJobPreparation.ts'),
    import('./autoLabelCatchup.ts'),
  ])
  getDb = client.getDb
  prepareLabelJob = preparation.prepareLabelJob
  resolveOrganizationByName = catchup.resolveOrganizationByName
  bootstrapOk = true
} catch (error) {
  bootstrapError = String((error as Error)?.message ?? error).split('\n')[0]
}

console.log('')
console.log(`PACKAGE_ID                  ${packageId}`)
console.log(`WORKER_BOOTSTRAP_OK         ${bootstrapOk}`)
if (!bootstrapOk) {
  console.log(`BOOTSTRAP_ERROR             ${bootstrapError}`)
  console.log('')
  console.log('NETWORK_CALLS=0')
  console.log('DB_WRITES=0')
  console.log('CARRIER_CALLS=0')
  console.log('')
  console.log('WORKER BAGIMLILIK GRAFI YUKLENEMEDI. Worker ACILMAMALIDIR.')
  process.exit(0)
}

// ═══ ORTAM ANAHTARLARI — DEĞER BASILMAZ, YALNIZ VARLIK ═══════════════════
const envPresence = {
  DATABASE_URL: Boolean(String(process.env.DATABASE_URL ?? '').trim()),
  ORDER_DATA_ENCRYPTION_KEY: Boolean(
    String(process.env.ORDER_DATA_ENCRYPTION_KEY ?? '').trim(),
  ),
  CREDENTIAL_ENCRYPTION_KEY: Boolean(
    String(process.env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim(),
  ),
}
console.log(`ENV_DATABASE_URL            ${envPresence.DATABASE_URL ? 'PRESENT' : 'MISSING'}`)
console.log(
  `ENV_ORDER_DATA_KEY          ${envPresence.ORDER_DATA_ENCRYPTION_KEY ? 'PRESENT' : 'MISSING'}`,
)
console.log(
  `ENV_CREDENTIAL_KEY          ${envPresence.CREDENTIAL_ENCRYPTION_KEY ? 'PRESENT' : 'MISSING'}`,
)

// Veritabani erisimi YOKSA yigin izi degil, KESIN teshis basilir.
let db: unknown
try {
  db = (getDb as () => unknown)()
} catch (error) {
  console.log('')
  console.log('PREPARATION_FAILURE_STAGE   BOOTSTRAP_DB')
  console.log('PREPARATION_FAILURE_TYPE    ' + ((error as Error)?.name ?? 'Error'))
  console.log(
    'PREPARATION_FAILURE_MESSAGE '
    + String((error as Error)?.message ?? error).split('\n')[0],
  )
  console.log('')
  console.log('NETWORK_CALLS=0')
  console.log('DB_WRITES=0')
  console.log('CARRIER_CALLS=0')
  console.log('')
  console.log('VERITABANI ERISIMI YOK. Worker ACILMAMALIDIR.')
  process.exit(0)
}

const org = await (resolveOrganizationByName as (
  database: unknown, value: string,
) => Promise<{ id: string; name: string } | null>)(db, name)
if (!org) fail(`Organizasyon bulunamadi: ${name}`)

// Hazirlik cikti tipi bilerek gevsek okunur: bu CLI yalniz RAPORLAR ve
// alanlarin varligina gore metin basar; is mantigi TASIMAZ.
const prepared = await (prepareLabelJob as (
  database: unknown,
  params: { organizationId: string; packageId: string },
) => Promise<Record<string, unknown> & {
  credentialSnapshot?: { resolved?: boolean }
  blockers: readonly string[]
}>)(db, {
  organizationId: org.id,
  packageId,
})

const failureStage = String(prepared.failureStage ?? '')
const stageOk = (stage: string): string => {
  if (failureStage === stage) return 'FAILED'
  const order = ['LOAD_ORDER', 'LOAD_SETTINGS', 'DESI', 'ELIGIBILITY', 'BILLING', 'CREDENTIALS']
  // Hata bir onceki asamada dogduysa bu asamaya HIC GELINMEDI.
  if (failureStage && order.indexOf(stage) > order.indexOf(failureStage)) {
    return 'NOT_REACHED'
  }
  return 'OK'
}

console.log('')
console.log(`ORGANIZATION                ${org.name} (${org.id})`)
console.log(`ORDER_NUMBER                ${prepared.orderNumber ?? '-'}`)
console.log(`MARKETPLACE_STATUS          ${prepared.marketplaceStatus ?? '-'}`)
console.log('')
console.log(`ORDER_LOAD_OK               ${prepared.order ? stageOk('LOAD_ORDER') : 'FAILED'}`)
console.log(`SETTINGS_LOAD_OK            ${prepared.tenantSettingsLoaded ? 'OK' : stageOk('LOAD_SETTINGS')}`)
console.log(`DESI_RESOLUTION_OK          ${prepared.resolvedDesi != null ? 'OK' : stageOk('DESI')}`)
console.log(`ELIGIBILITY_OK              ${prepared.eligibleForCreate === true ? 'OK' : stageOk('ELIGIBILITY')}`)
console.log(`BILLING_OK                  ${prepared.billingParty ? 'OK' : stageOk('BILLING')}`)
console.log(
  `CREDENTIAL_RESOLUTION_OK    ${prepared.credentialSnapshot?.resolved ? 'OK' : stageOk('CREDENTIALS')}`,
)
console.log('')
console.log(`TENANT_DESI                 ${String(prepared.tenantDesi)}`)
console.log(`RESOLVED_DESI               ${String(prepared.resolvedDesi)}`)
console.log(`SURAT_BIRIM_DESI            ${String(prepared.suratBirimDesi)}`)
console.log('')
console.log(`BILLING_PARTY               ${prepared.billingParty ?? '-'}`)
console.log(`EXPECTED_WHO_PAYS           ${String(prepared.expectedWhoPays)}`)
console.log(`CREDENTIAL_ROLE             ${prepared.credentialRole ?? '-'}`)
console.log(`CREDENTIAL_RESOLVED         ${Boolean(prepared.credentialSnapshot?.resolved)}`)
console.log('')
console.log(`PREFLIGHT_VALID             ${prepared.ok}`)
console.log(`WOULD_CALL_CARRIER          ${prepared.ok ? 'YES' : 'NO'}`)
console.log(`BLOCKERS                    ${prepared.blockers.join(', ') || '-'}`)
console.log('')
console.log(`PREPARATION_FAILURE_STAGE   ${prepared.failureStage ?? '-'}`)
console.log(`PREPARATION_FAILURE_TYPE    ${prepared.failureType ?? '-'}`)
console.log(`PREPARATION_FAILURE_CODE    ${prepared.blockerCode ?? '-'}`)
console.log(`PREPARATION_FAILURE_MESSAGE ${prepared.failureDetail ?? '-'}`)
console.log('')
console.log('NETWORK_CALLS=0')
console.log('DB_WRITES=0')
console.log('CARRIER_CALLS=0')
console.log('')
console.log('SALT-OKUNUR. Uretim cozucusuyle (node) calisti; Surat CAGRILMADI.')
process.exit(0)
