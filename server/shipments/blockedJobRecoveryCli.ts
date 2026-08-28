// BLOKE İŞ KURTARMA — KOMUT SATIRI.
//
//   npm run auto-label:blocked:inspect    -- --name TarzimTuba
//   npm run auto-label:blocked:reactivate -- --name TarzimTuba --package <ID>
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • `inspect` HİÇBİR satır yazmaz.
//   • `reactivate` yalnız KANITLANMIŞ ağ-öncesi satırları açar ve
//     `--package` verilmezse HİÇBİR ŞEY yapmaz (toplu açma YOKTUR).
//   • `UNKNOWN_AFTER_NETWORK` / `READY` sorgulanmaz bile.
//   • Worker ÇALIŞTIRILMAZ, Sürat ÇAĞRILMAZ, mükerrer iş YARATILMAZ.
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
  console.error(`[blocked] ${message}`)
  process.exit(1)
}

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')
const reactivate = process.argv.includes('--reactivate')
const packageIds = process.argv
  .map((argument, index) => (argument === '--package' ? process.argv[index + 1] : null))
  .filter((value): value is string => Boolean(value))
if (reactivate && packageIds.length === 0) {
  fail('Yeniden etkinlestirme icin EN AZ BIR --package <ID> zorunludur.')
}

const [{ getDb }, catchup, recovery] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('./blockedJobRecovery.ts'),
])
const db = getDb()
const resolved = await catchup.resolveOrganizationByName(db, name)
if (!resolved) fail(`Organizasyon bulunamadi: ${name}`)
const org = resolved

function printReport(
  report: Awaited<ReturnType<typeof recovery.inspectBlockedJobs>>,
): void {
  console.log('')
  console.log(`ORGANIZATION                ${org.name} (${org.id})`)
  console.log(`BLOCKED_TOTAL               ${report.blockedTotal}`)
  console.log(`SAFE_TO_REACTIVATE_COUNT    ${report.safeCount}`)
  for (const candidate of report.candidates) {
    console.log('')
    console.log('────────────────────────────────────────────────────────────')
    console.log(`PACKAGE                     ${candidate.packageId}`)
    console.log(`STATUS                      ${candidate.status}`)
    console.log(`ATTEMPT_COUNT               ${candidate.attemptCount}`)
    console.log(`LAST_ERROR_CODE             ${candidate.lastErrorCode ?? '-'}`)
    console.log(`CARRIER_CALLED              ${candidate.carrierCalled}`)
    console.log(`ARTIFACT                    ${candidate.artifact}`)
    console.log(`CURRENT_RESOLVED_DESI       ${String(candidate.currentResolvedDesi)}`)
    console.log(`CURRENT_ELIGIBILITY         ${String(candidate.currentEligibility)}`)
    console.log(`CURRENT_BLOCKER             ${candidate.currentBlockerCode ?? '-'}`)
    console.log(`SAFE_TO_REACTIVATE          ${candidate.safeToReactivate ? 'YES' : 'NO'}`)
    console.log(`REASON                      ${candidate.reason}`)
  }
  console.log('')
  console.log('────────────────────────────────────────────────────────────')
  console.log(`NETWORK_CALLS=${report.networkCalls}`)
  console.log(`DB_WRITES=${report.dbWrites}`)
  console.log(`CARRIER_CALLS=${report.carrierCalls}`)
}

if (!reactivate) {
  printReport(await recovery.inspectBlockedJobs(db, { organizationId: org.id }))
  console.log('')
  console.log('SALT-OKUNUR inceleme. Hicbir satir yazilmadi.')
} else {
  const result = await recovery.reactivateBlockedJobs(db, {
    organizationId: org.id,
    packageIds,
  })
  printReport(result.report)
  console.log('')
  console.log(`REACTIVATED (BLOCKED→QUEUED) ${result.reactivated}`)
  console.log(`SKIPPED (dokunulmadi)        ${result.skipped}`)
  console.log(`CARRIER_CALLS=${result.carrierCalls}`)
  console.log('')
  console.log('AYNI is satirlari kuyruga alindi. attempt_count KORUNDU.')
  console.log('Worker CALISTIRILMADI, Surat CAGRILMADI.')
}
process.exit(0)
