// BAYAT `PREPARING` İNCELEME + KURTARMA — KOMUT SATIRI.
//
//   npm run auto-label:stale:inspect -- --name TarzimTuba
//   npm run auto-label:stale:recover -- --name TarzimTuba --package 4111289850
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • `inspect` HİÇBİR satır yazmaz.
//   • `recover` yalnız AÇIKÇA verilen `--package` satırlarını ele alır;
//     paket verilmezse HİÇBİR ŞEY yapılmaz (toplu kurtarma YOKTUR).
//   • Karar SÜREYE değil TAŞIYICI KANITINA dayanır.
//   • Sürat ÇAĞRILMAZ, worker ÇALIŞTIRILMAZ, mükerrer iş YARATILMAZ.
//   • `attempt_count` KORUNUR; sıfırlanmaz/azaltılmaz.
//
// BİLEREK düz `node` ile çalışır: üretim çözücüsünün AYNISI.
import process from 'node:process'

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function fail(message: string): never {
  console.error(`[stale] ${message}`)
  process.exit(1)
}

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')
const recover = process.argv.includes('--recover')
const packageIds = process.argv
  .map((argument, index) => (argument === '--package' ? process.argv[index + 1] : null))
  .filter((value): value is string => Boolean(value))
if (recover && packageIds.length === 0) {
  fail('Kurtarma icin EN AZ BIR --package <ID> zorunludur.')
}
const staleAfterMs = Number(readFlag('stale-after-ms') ?? 10 * 60 * 1000)

const [{ getDb }, catchup, recovery] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('./staleJobRecovery.ts'),
])
const db = getDb()
const resolved = await catchup.resolveOrganizationByName(db, name)
if (!resolved) fail(`Organizasyon bulunamadi: ${name}`)
const org = resolved

function printReport(
  report: Awaited<ReturnType<typeof recovery.inspectStaleJobs>>,
): void {
  console.log('')
  console.log(`ORGANIZATION                ${org.name} (${org.id})`)
  console.log(`PREPARING_TOTAL             ${report.preparingTotal}`)
  console.log(`SAFE_TO_RECOVER_COUNT       ${report.safeCount}`)
  for (const candidate of report.candidates) {
    console.log('')
    console.log('────────────────────────────────────────────────────────────')
    console.log(`PACKAGE_ID                  ${candidate.packageId}`)
    console.log(`JOB_ID                      ${candidate.jobId}`)
    console.log(`ATTEMPT_COUNT               ${candidate.attemptCount}`)
    console.log(`LOCKED_AT                   ${candidate.lockedAt ?? '-'}`)
    console.log(`LOCKED_BY                   ${candidate.lockedBy ?? '-'}`)
    console.log(`LOCK_AGE_SECONDS            ${String(candidate.lockAgeSeconds)}`)
    console.log('')
    console.log(`OPERATION_STATUS            ${candidate.operationStatus ?? '-'}`)
    console.log(`CREATE_CALL_COUNT           ${candidate.createCallCount}`)
    console.log(`CARRIER_CREATE_CALLED       ${candidate.carrierCreateCalled}`)
    console.log('')
    console.log(`READY_LABEL_EXISTS          ${candidate.readyLabelExists}`)
    console.log(`CARRIER_ARTIFACT_EXISTS     ${candidate.carrierArtifactExists}`)
    console.log(`UNKNOWN_AFTER_NETWORK_EVIDENCE ${candidate.unknownAfterNetworkEvidence}`)
    console.log('')
    console.log(`CURRENT_RESOLVED_DESI       ${String(candidate.currentResolvedDesi)}`)
    console.log(`CURRENT_ELIGIBILITY         ${String(candidate.currentEligibility)}`)
    console.log(`CURRENT_PREFLIGHT_VALID     ${candidate.currentPreflightValid}`)
    console.log('')
    console.log(`VERDICT                     ${candidate.verdict}`)
    console.log(`TARGET_STATUS               ${candidate.targetStatus ?? '-'}`)
    console.log(`SAFE_TO_RECOVER             ${candidate.safeToRecover ? 'YES' : 'NO'}`)
    console.log(`REASON                      ${candidate.reason}`)
  }
  console.log('')
  console.log('────────────────────────────────────────────────────────────')
  console.log(`NETWORK_CALLS=${report.networkCalls}`)
  console.log(`DB_WRITES=${report.dbWrites}`)
  console.log(`CARRIER_CALLS=${report.carrierCalls}`)
}

if (!recover) {
  printReport(await recovery.inspectStaleJobs(db, {
    organizationId: org.id, staleAfterMs,
  }))
  console.log('')
  console.log('SALT-OKUNUR inceleme. Hicbir satir yazilmadi.')
} else {
  const result = await recovery.recoverStaleJobs(db, {
    organizationId: org.id, packageIds, staleAfterMs,
  })
  printReport(result.report)
  console.log('')
  console.log(`RECOVERED                    ${result.recovered}`)
  console.log(`SKIPPED (dokunulmadi)        ${result.skipped}`)
  console.log(`CARRIER_CALLS=${result.carrierCalls}`)
  console.log('')
  console.log('AYNI is satiri; attempt_count KORUNDU, bayat kilit TEMIZLENDI.')
  console.log('Worker CALISTIRILMADI, Surat CAGRILMADI.')
}
process.exit(0)
