// KUYRUK NORMALİZASYONU — KOMUT SATIRI.
//
//   npm run auto-label:queue-normalize:inspect -- --name TarzimTuba
//   npm run auto-label:queue-normalize:apply   -- --name TarzimTuba
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • `inspect` HİÇBİR satır yazmaz.
//   • `apply` YALNIZ sınıflandırıcının GÜVENLİ dediği satırları,
//     tek işlemde ve koşullu güncellemeyle taşır.
//   • Taşıyıcı ÇAĞRILMAZ, ağa ÇIKILMAZ, worker ÇALIŞTIRILMAZ.
//   • Yeni iş/operasyon YARATILMAZ; `attempt_count` ve `created_at` KORUNUR.
//   • İkinci çalıştırma 0 yazım üretir.
//
// BİLEREK düz `node` ile çalışır: üretim çözücüsünün AYNISI.
import process from 'node:process'

// ═══ ORTAM PARİTESİ — SUNUCUYLA AYNI `.env` ══════════════════════════════
import { loadRepositoryEnv } from '../runtime/localEnv.ts'

loadRepositoryEnv()

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function fail(message: string): never {
  console.error(`[queue-normalize] ${message}`)
  process.exit(1)
}

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')
const apply = process.argv.includes('--apply')
const packageIds = process.argv
  .map((argument, index) => (argument === '--package' ? process.argv[index + 1] : null))
  .filter((value): value is string => Boolean(value))

const [{ getDb }, catchup, normalizer] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('./queueNormalizer.ts'),
])
const db = getDb()
const resolved = await catchup.resolveOrganizationByName(db, name)
if (!resolved) fail(`Organizasyon bulunamadi: ${name}`)
const org = resolved

function printReport(
  report: Awaited<ReturnType<typeof normalizer.inspectQueueNormalization>>,
): void {
  console.log('')
  console.log(`ORGANIZATION                ${org.name} (${org.id})`)
  console.log(`QUEUED_TOTAL                ${report.queuedTotal}`)
  console.log(`SAFE_TO_NORMALIZE_COUNT     ${report.safeCount}`)
  for (const candidate of report.candidates) {
    console.log('')
    console.log('────────────────────────────────────────────────────────────')
    console.log(`PACKAGE_ID                  ${candidate.packageId}`)
    console.log(`JOB_ID                      ${candidate.jobId}`)
    console.log(`ATTEMPT_COUNT               ${candidate.attemptCount}`)
    console.log(`LAST_ERROR_CODE             ${candidate.lastErrorCode ?? '-'}`)
    console.log('')
    console.log(`MARKETPLACE_STATUS          ${candidate.marketplaceStatus ?? '-'}`)
    console.log(`MARKETPLACE_LIFECYCLE       ${candidate.marketplaceLifecycle}`)
    console.log('')
    console.log(`CURRENT_PREFLIGHT_VALID     ${candidate.currentPreflightValid}`)
    console.log(`CURRENT_BLOCKERS            ${candidate.currentBlockers.join(', ') || '-'}`)
    console.log('')
    console.log(`CARRIER_CREATE_CALLED       ${candidate.carrierCreateCalled}`)
    console.log(`CARRIER_ARTIFACT_EXISTS     ${candidate.carrierArtifactExists}`)
    console.log(`READY_LABEL_EXISTS          ${candidate.readyLabelExists}`)
    console.log(`UNKNOWN_AFTER_NETWORK_EVIDENCE ${candidate.unknownAfterNetworkEvidence}`)
    console.log('')
    console.log(`CURRENT_DESI                ${String(candidate.currentDesi)}`)
    console.log(`CURRENT_CREDENTIAL_RESOLVED ${candidate.currentCredentialResolved}`)
    console.log('')
    console.log(`QUEUE_ORIGIN_CLASSIFICATION ${candidate.queueOrigin}`)
    console.log(`NORMALIZATION_VERDICT       ${candidate.verdict}`)
    console.log(`TARGET_STATE                ${candidate.targetState ?? '-'}`)
    console.log(`TARGET_ERROR_CODE           ${candidate.targetErrorCode ?? '-'}`)
    console.log(`REASON                      ${candidate.reason}`)
    console.log(`SAFE_TO_NORMALIZE=${candidate.safeToNormalize ? 'YES' : 'NO'}`)
  }
  console.log('')
  console.log('────────────────────────────────────────────────────────────')
  console.log(`NETWORK_CALLS=${report.networkCalls}`)
  console.log(`DB_WRITES=${report.dbWrites}`)
  console.log(`CARRIER_CALLS=${report.carrierCalls}`)
}

if (!apply) {
  printReport(await normalizer.inspectQueueNormalization(db, {
    organizationId: org.id,
  }))
  console.log('')
  console.log('SALT-OKUNUR inceleme. Hicbir satir yazilmadi.')
} else {
  const result = await normalizer.applyQueueNormalization(db, {
    organizationId: org.id,
    packageIds,
  })
  printReport(result.report)
  console.log('')
  console.log('════════════ UYGULANAN DEGISIKLIKLER ════════════')
  for (const change of result.applied) {
    console.log('')
    console.log(`PACKAGE        ${change.packageId}`)
    console.log(`FROM           ${change.from}`)
    console.log(`TO             ${change.to}`)
    console.log(`OLD_ERROR      ${change.oldError ?? '-'}`)
    console.log(`NEW_ERROR      ${change.newError ?? '-'}`)
    console.log(`ATTEMPT_COUNT  ${change.attemptCount}`)
    console.log(`REASON         ${change.reason}`)
  }
  console.log('')
  console.log('────────────────────────────────────────────────────────────')
  console.log(`NORMALIZED_COUNT            ${result.normalized}`)
  console.log(`SKIPPED_COUNT               ${result.skipped}`)
  console.log(`NETWORK_CALLS=${result.networkCalls}`)
  console.log(`CARRIER_CALLS=${result.carrierCalls}`)
  console.log('')
  console.log('is kimligi, attempt_count ve created_at KORUNDU.')
  console.log('Yeni is/operasyon YARATILMADI. Surat CAGRILMADI.')
}
process.exit(0)
