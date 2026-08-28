// TEK SEFERLİK YAKALAMA — KOMUT SATIRI.
//
//   npm run auto-label:catchup:inspect -- --name TarzimTuba   (SALT-OKUNUR)
//   npm run auto-label:catchup:enqueue -- --name TarzimTuba   (İŞ YAZAR)
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • Organizasyon AÇIKÇA verilmelidir; varsayılan YOKTUR.
//   • Uygulama açılışına BAĞLI DEĞİLDİR; asla kendiliğinden çalışmaz.
//   • `inspect` hiçbir satır yazmaz, hiçbir ağ çağrısı yapmaz.
//   • `enqueue` YALNIZ LABEL_PREPARE işi yazar; SÜRAT'İ ÇAĞIRMAZ.
//   • Gerçek create'i üretimdeki AYNI worker yapar (paket başına 1 SOAP).
import process from 'node:process'

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function fail(message: string): never {
  console.error(`[catchup] ${message}`)
  process.exit(1)
}

const mode = process.argv.includes('--enqueue') ? 'enqueue' : 'inspect'
const name = readFlag('name')
if (!name) {
  fail('Organizasyon ZORUNLU: --name "TarzimTuba"')
}
const marketplace = readFlag('marketplace') ?? 'Trendyol'
const carrier = readFlag('carrier') ?? 'Surat'

const [{ getDb }, catchup] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
])
const db = getDb()
const org = await catchup.resolveOrganizationByName(db, name)
if (!org) fail(`Organizasyon bulunamadi: ${name}`)

const params = {
  organizationId: org.id,
  organizationName: org.name,
  marketplace,
  carrier,
}

function printReport(report: Awaited<ReturnType<typeof catchup.inspectCatchupCandidates>>) {
  console.log('')
  console.log(`ORGANIZATION           ${report.organizationName} (${report.organizationId})`)
  console.log(`MARKETPLACE            ${report.marketplace}`)
  console.log(`CARRIER                ${report.carrier}`)
  console.log('')
  console.log(`TOTAL_OPEN             ${report.totalOpen}`)
  console.log(`ELIGIBLE               ${report.eligible}`)
  console.log(`BLOCKED                ${report.blocked}`)
  console.log(`ALREADY_READY          ${report.alreadyReady}`)
  console.log(`PRIOR_ATTEMPT          ${report.priorAttempt}`)
  console.log(`UNKNOWN_AFTER_NETWORK  ${report.unknownAfterNetwork}`)
  console.log('')
  console.log(
    ['packageId', 'orderNumber', 'firstSeenAt', 'providerStatus',
      'localStatus', 'eligibilityResult', 'reason'].join('\t'),
  )
  for (const candidate of report.candidates) {
    console.log(
      [
        candidate.packageId, candidate.orderNumber, candidate.firstSeenAt,
        candidate.providerStatus, candidate.localStatus,
        candidate.eligibilityResult, candidate.reason,
      ].join('\t'),
    )
  }
  console.log('')
  console.log(`NETWORK_CALLS=${report.networkCalls}`)
  console.log(`DB_WRITES=${report.dbWrites}`)
  console.log(`CARRIER_CALLS=${report.carrierCalls}`)
}

if (mode === 'inspect') {
  printReport(await catchup.inspectCatchupCandidates(db, params))
  console.log('')
  console.log('SALT-OKUNUR inceleme. Hicbir is yazilmadi.')
} else {
  const result = await catchup.enqueueCatchupJobs(db, params)
  printReport(result.report)
  console.log('')
  console.log(`ENQUEUED               ${result.enqueued}`)
  console.log(`SKIPPED_EXISTING       ${result.skippedExisting}`)
  console.log(`CARRIER_CALLS=${result.carrierCalls}`)
  console.log('')
  console.log('Yalniz LABEL_PREPARE isi yazildi. Surat CAGRILMADI;')
  console.log('gercek create uretimdeki ayni worker tarafindan yapilir.')
}
process.exit(0)
