// KANARYA ADAYI SEÇİCİ — KOMUT SATIRI.
//
//   npm run auto-label:canary:candidates -- --name TarzimTuba
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • Organizasyon AÇIKÇA verilmelidir; varsayılan YOKTUR.
//   • SALT OKUNUR: hiçbir satır yazılmaz.
//   • Trendyol'a CANLI sorulmaz; uygunluk KALICI durumdan okunur.
//   • Sürat ÇAĞRILMAZ, worker ÇALIŞTIRILMAZ.
import process from 'node:process'

// ═══ ORTAM PARİTESİ — SUNUCUYLA AYNI `.env` ══════════════════════════════
// Sunucu açılışta depo kökündeki `.env`'i yükler. Bu araç yüklemezse
// üretimde SAĞLIKLI bir sistemi "ENV MISSING" diye raporlar ve operatörü
// yanlış yönlendirir. Tanımlı değerler EZİLMEZ.
import { loadRepositoryEnv } from '../runtime/localEnv.ts'

loadRepositoryEnv()

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function fail(message: string): never {
  console.error(`[canary] ${message}`)
  process.exit(1)
}

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')

const [{ getDb }, catchup, selector] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('./canaryCandidateSelector.ts'),
])
const db = getDb()
const resolved = await catchup.resolveOrganizationByName(db, name)
if (!resolved) fail(`Organizasyon bulunamadi: ${name}`)
const org = resolved

const report = await selector.selectCanaryCandidates(db, { organizationId: org.id })

console.log('')
console.log(`ORGANIZATION                ${org.name} (${org.id})`)
console.log(`QUEUED_TOTAL                ${report.queuedTotal}`)
console.log(`SAFE_CANARY_COUNT           ${report.safeCount}`)

for (const candidate of report.candidates) {
  console.log('')
  console.log('────────────────────────────────────────────────────────────')
  console.log(`PACKAGE_ID                  ${candidate.packageId}`)
  console.log(`JOB_ID                      ${candidate.jobId}`)
  console.log(`ATTEMPT_COUNT               ${candidate.attemptCount}`)
  console.log(`ORDER_NUMBER                ${candidate.orderNumber ?? '-'}`)
  console.log(`CURRENT_MARKETPLACE_STATUS  ${candidate.currentMarketplaceStatus ?? '-'}`)
  console.log('')
  console.log(`TENANT_DESI                 ${String(candidate.tenantDesi)}`)
  console.log(`RESOLVED_DESI               ${String(candidate.resolvedDesi)}`)
  console.log(`SURAT_BIRIM_DESI            ${String(candidate.suratBirimDesi)}`)
  console.log('')
  console.log(`BILLING_PARTY               ${candidate.billingParty ?? '-'}`)
  console.log(`EXPECTED_WHO_PAYS           ${String(candidate.expectedWhoPays)}`)
  console.log(`CREDENTIAL_ROLE             ${candidate.credentialRole ?? '-'}`)
  console.log(`CREDENTIAL_RESOLVED         ${candidate.credentialResolved}`)
  console.log('')
  console.log(`READY_LABEL_EXISTS          ${candidate.readyLabelExists}`)
  console.log(`CARRIER_ARTIFACT_EXISTS     ${candidate.carrierArtifactExists}`)
  console.log(`CARRIER_CALL_RECORDED       ${candidate.carrierCallRecorded}`)
  console.log(`UNKNOWN_AFTER_NETWORK_EVIDENCE ${candidate.unknownAfterNetworkEvidence}`)
  console.log(`DUPLICATE_JOB               ${candidate.duplicateJob}`)
  console.log('')
  console.log(`PREFLIGHT_VALID             ${candidate.preflightValid}`)
  console.log(`WOULD_CALL_CARRIER          ${candidate.wouldCallCarrier ? 'YES' : 'NO'}`)
  console.log(`BLOCKERS                    ${candidate.blockers.join(', ') || '-'}`)
  console.log('')
  console.log(`SAFE_CANARY=${candidate.safeCanary ? 'YES' : 'NO'}`)
}

console.log('')
console.log('────────────────────────────────────────────────────────────')
console.log(`NETWORK_CALLS=${report.networkCalls}`)
console.log(`DB_WRITES=${report.dbWrites}`)
console.log(`CARRIER_CALLS=${report.carrierCalls}`)
console.log('')
console.log('SALT-OKUNUR. Hicbir satir yazilmadi, Trendyol/Surat CAGRILMADI.')
process.exit(0)
