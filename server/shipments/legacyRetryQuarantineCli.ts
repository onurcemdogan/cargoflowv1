// ESKİ KALINTI KARANTİNASI + TEK İŞ YENİDEN ETKİNLEŞTİRME — KOMUT SATIRI.
//
//   npm run auto-label:legacy-retry:inspect    -- --name TarzimTuba
//   npm run auto-label:legacy-retry:quarantine -- --name TarzimTuba
//   npm run auto-label:job:inspect             -- --name TarzimTuba --package 4110109345
//   npm run auto-label:job:reactivate          -- --name TarzimTuba --package 4110109345
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • Organizasyon AÇIKÇA verilmelidir; varsayılan YOKTUR.
//   • Uygulama açılışına BAĞLI DEĞİLDİR.
//   • `inspect` komutları HİÇBİR satır yazmaz.
//   • Hiçbir komut SÜRAT'İ ÇAĞIRMAZ ve worker'ı ÇALIŞTIRMAZ.
//   • Karantina yalnız KANITLANMIŞ kalıntıyı taşır; kanıtsız satır
//     DOKUNULMAZ (`HISTORY_UNPROVEN`).
import process from 'node:process'

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function fail(message: string): never {
  console.error(`[legacy] ${message}`)
  process.exit(1)
}

const mode = process.argv.includes('--quarantine')
  ? 'quarantine'
  : process.argv.includes('--reactivate')
    ? 'reactivate'
    : process.argv.includes('--job')
      ? 'job-inspect'
      : 'inspect'

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')
const packageId = readFlag('package')
if ((mode === 'reactivate' || mode === 'job-inspect') && !packageId) {
  fail('Paket ZORUNLU: --package 4110109345')
}

const [{ getDb }, catchup, legacy] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('./legacyRetryQuarantine.ts'),
])
const db = getDb()
const resolved = await catchup.resolveOrganizationByName(db, name)
if (!resolved) fail(`Organizasyon bulunamadi: ${name}`)
const org = resolved

function printInspect(report: Awaited<ReturnType<typeof legacy.inspectLegacyRetryJobs>>) {
  console.log('')
  console.log(`ORGANIZATION            ${org.name} (${org.id})`)
  console.log(`TOTAL_FAILED_SAFE_TO_RETRY  ${report.totalFailedSafeToRetry}`)
  console.log(`PROVEN_LEGACY_DESI          ${report.provenLegacy}`)
  console.log(`HISTORY_UNPROVEN            ${report.historyUnproven}`)
  console.log(`NOT_LEGACY_CANDIDATE        ${report.notLegacy}`)
  console.log('')
  console.log(
    ['packageId', 'attempts', 'lastErrorCode', 'carrierCalled',
      'createCalls', 'artifact', 'traceRows', 'verdict', 'reason'].join('\t'),
  )
  for (const candidate of report.candidates) {
    console.log(
      [
        candidate.packageId, candidate.attemptCount,
        candidate.lastErrorCode ?? '-', candidate.carrierCreateCalled,
        candidate.createCallCount, candidate.carrierArtifactPresent,
        candidate.recordedTraceAttempts, candidate.verdict, candidate.reason,
      ].join('\t'),
    )
  }
  console.log('')
  console.log(`NETWORK_CALLS=${report.networkCalls}`)
  console.log(`DB_WRITES=${report.dbWrites}`)
  console.log(`CARRIER_CALLS=${report.carrierCalls}`)
}

function printCheck(check: Awaited<ReturnType<typeof legacy.inspectSingleJobReactivation>>) {
  console.log('')
  console.log(`PACKAGE                     ${check.packageId}`)
  console.log(`JOB_ID                      ${check.jobId ?? '-'}`)
  console.log(`JOB_STATUS_IS_BLOCKED       ${check.jobStatusIsBlocked}`)
  console.log(`TENANT_DESI                 ${String(check.tenantDesiValue)}`)
  console.log(`MULTIPLY_BY_ITEM_QUANTITY   ${String(check.multiplyByItemQuantity)}`)
  console.log(`RESOLVER_DESI               ${String(check.resolverDesi)}`)
  console.log(`READY_LABEL_EXISTS          ${check.readyLabelExists}`)
  console.log(`CARRIER_ARTIFACT_EXISTS     ${check.carrierArtifactExists}`)
  console.log(`UNKNOWN_AFTER_NETWORK       ${check.unknownAfterNetworkExists}`)
  console.log(`CARRIER_CALL_RECORDED       ${check.carrierCallRecorded}`)
  console.log(`DUPLICATE_JOBS              ${check.duplicateJobs}`)
  console.log(`BLOCKERS                    ${check.blockers.join(', ') || '-'}`)
  console.log('')
  console.log(`SAFE_TO_REACTIVATE=${check.safeToReactivate ? 'YES' : 'NO'}`)
  console.log('CARRIER_CALLS=0')
}

if (mode === 'inspect') {
  printInspect(await legacy.inspectLegacyRetryJobs(db, { organizationId: org.id }))
  console.log('')
  console.log('SALT-OKUNUR inceleme. Hicbir satir yazilmadi.')
} else if (mode === 'quarantine') {
  const result = await legacy.quarantineLegacyRetryJobs(db, { organizationId: org.id })
  printInspect(result.report)
  console.log('')
  console.log(`QUARANTINED (→ BLOCKED)     ${result.quarantined}`)
  console.log(`SKIPPED (dokunulmadi)       ${result.skipped}`)
  console.log(`CARRIER_CALLS=${result.carrierCalls}`)
  console.log('')
  console.log('attempt_count KORUNDU. Satirlar SILINMEDI, ayni is kimligi durur.')
} else if (mode === 'job-inspect') {
  printCheck(
    await legacy.inspectSingleJobReactivation(db, {
      organizationId: org.id, packageId: packageId as string,
    }),
  )
  console.log('')
  console.log('SALT-OKUNUR inceleme. Hicbir satir yazilmadi.')
} else {
  const result = await legacy.reactivateSingleJob(db, {
    organizationId: org.id, packageId: packageId as string,
  })
  printCheck(result.check)
  console.log('')
  console.log(`REACTIVATED (BLOCKED→QUEUED) ${result.reactivated}`)
  console.log(`CARRIER_CALLS=${result.carrierCalls}`)
  if (!result.reactivated) {
    console.log('Guvenli DEGIL; hicbir satir degistirilmedi.')
  } else {
    console.log('AYNI is satiri kuyruga alindi. Worker CALISTIRILMADI.')
  }
}
process.exit(0)
