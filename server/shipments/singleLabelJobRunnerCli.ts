// KONTROLLÜ ÜRETİM KANARYASI — TEK PAKET, TEK CREATE.
//
//   npm run auto-label:job:run-once -- --name TarzimTuba --package 4110109345
//   npm run auto-label:job:run-once -- --name TarzimTuba --package 4110109345 \
//     --expect-desi 2
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • Organizasyon ve paket AÇIKÇA verilmelidir; varsayılan YOKTUR.
//   • Genel `claimLabelJobs` toplu sorgusu KULLANILMAZ.
//   • Yalnız `BLOCKED` durumdaki TEK satır, kimliğiyle talep edilir.
//   • `--allow-queued-canary` AÇIKÇA verilmedikçe `QUEUED` iş REDDEDİLİR;
//     verildiğinde bile yalnız `attempt_count=0` olan TEK satır alınır.
//   • Kapılardan biri kapalıysa `CARRIER_CALLS=0` ve HİÇBİR yazım yapılmaz.
//   • Taşıyıcı en fazla BİR KEZ çağrılır; ikinci create İMKÂNSIZDIR.
//   • Worker BAŞLATILMAZ; zamanlayıcı KURULMAZ.
import process from 'node:process'

// Uygulama modülü create orkestrasyonu için içe aktarılır; HTTP dinleyicisi
// AÇILMAMALIDIR. Bayrak içe aktarmadan ÖNCE kurulur.
process.env.CF_IMPORT_ONLY = '1'

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function fail(message: string): never {
  console.error(`[run-once] ${message}`)
  process.exit(1)
}

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')
const packageId = readFlag('package')
if (!packageId) fail('Paket ZORUNLU: --package 4110109345')
const expectDesiRaw = readFlag('expect-desi')
const expectedDesi = expectDesiRaw == null ? null : Number(expectDesiRaw)
if (expectedDesi != null && !Number.isFinite(expectedDesi)) {
  fail('--expect-desi sayisal olmalidir')
}

const [{ getDb }, catchup, runner, appModule] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('./singleLabelJobRunner.ts'),
  // Uygulama modulunun tip bildirimi yoktur (JS); yalnizca ihtiyac duyulan
  // disa aktarim daraltilir.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  import('../index.mjs' as any) as Promise<{
    runLabelJobViaCreateHandler: (job: unknown) => Promise<unknown>
  }>,
])
const db = getDb()
const resolved = await catchup.resolveOrganizationByName(db, name)
if (!resolved) fail(`Organizasyon bulunamadi: ${name}`)
const org = resolved

// Zımnî gevşetme YOK: bayrak yoksa QUEUED iş kapıda durur.
const allowQueuedCanary = process.argv.includes('--allow-queued-canary')

const report = await runner.runSingleLabelJob(db, {
  organizationId: org.id,
  packageId,
  workerId: `run-once@${process.pid}`,
  expectedDesi,
  allowQueuedCanary,
  // WORKER İLE AYNI create orkestrasyonu — ikinci uygulama YOK.
  runLabel: appModule.runLabelJobViaCreateHandler as never,
})

console.log('')
console.log(`ORGANIZATION                ${org.name} (${org.id})`)
console.log(`PACKAGE_ID                  ${report.packageId}`)
console.log(`JOB_ID                      ${report.jobId ?? '-'}`)
console.log(`STATUS_BEFORE               ${report.statusBefore ?? '-'}`)
console.log(`STATUS_AFTER                ${report.statusAfter ?? '-'}`)
console.log(`ATTEMPT_COUNT_BEFORE        ${String(report.attemptCountBefore)}`)
console.log(`ATTEMPT_COUNT_AFTER         ${String(report.attemptCountAfter)}`)
console.log('')
console.log(`TENANT_DESI                 ${String(report.tenantDesi)}`)
console.log(`RESOLVED_DESI               ${String(report.resolvedDesi)}`)
console.log(`SURAT_BIRIM_DESI            ${String(report.suratBirimDesi)}`)
console.log('')
console.log(`BILLING_PARTY               ${report.billingParty ?? '-'}`)
console.log(`EXPECTED_SURAT_WHO_PAYS     ${String(report.expectedSuratWhoPays)}`)
console.log(`CREDENTIAL_ROLE             ${report.credentialRole ?? '-'}`)
console.log('')
console.log(`CARRIER_CALL_STARTED        ${report.carrierCallStarted}`)
console.log(`CARRIER_CALLED              ${report.carrierCalled}`)
console.log(`CARRIER_CREATE_ATTEMPTS     ${report.carrierCreateAttempts}`)
console.log(`CARRIER_CODE                ${report.carrierCode ?? '-'}`)
console.log(`BUSINESS_RESULT             ${report.businessResult ?? '-'}`)
console.log(`TRACKING_PRESENT            ${report.trackingPresent}`)
console.log(`BARCODE_PRESENT             ${report.barcodePresent}`)
console.log(`ZPL_PRESENT                 ${report.zplPresent}`)
console.log(`ZPL_LENGTH                  ${report.zplLength}`)
console.log('')
console.log(`OTHER_QUEUED_JOBS_TOUCHED   ${report.otherQueuedJobsTouched}`)
console.log(`TOTAL_CARRIER_CALLS         ${report.totalCarrierCalls}`)
if (!report.gatesPassed) {
  console.log('')
  console.log(`BLOCKERS                    ${report.blockers.join(', ') || '-'}`)
  if (report.preflightFailureDetail) {
    console.log(`FAILURE_DETAIL              ${report.preflightFailureDetail}`)
  }
  console.log('')
  console.log('KAPI KAPALI. Tasiyiciya CIKILMADI, hicbir satir yazilmadi.')
}
process.exit(0)
