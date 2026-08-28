// CANLANDIRMA İNCELEYİCİSİ — KOMUT SATIRI, SALT OKUNUR.
//
//   npm run auto-label:revival:inspect -- --name TarzimTuba
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • HİÇBİR satır yazılmaz; bu araç TEŞHİS amaçlıdır.
//   • Sürat ÇAĞRILMAZ, Trendyol'a CANLI sorulmaz, worker ÇALIŞTIRILMAZ.
//   • Karar otoritesi paylaşılan hazırlıktır; ikinci kural YOKTUR.
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
  console.error(`[revival] ${message}`)
  process.exit(1)
}

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')

const [{ getDb }, catchup, inspector] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('./revivalInspector.ts'),
])
const db = getDb()
const resolved = await catchup.resolveOrganizationByName(db, name)
if (!resolved) fail(`Organizasyon bulunamadi: ${name}`)
const org = resolved

const report = await inspector.inspectRevivalCandidates(db, {
  organizationId: org.id,
})

console.log('')
console.log(`ORGANIZATION                ${org.name} (${org.id})`)
console.log(`BLOCKED_TOTAL               ${report.blockedTotal}`)
console.log(`SAFE_TO_REVIVE_COUNT        ${report.safeCount}`)

for (const candidate of report.candidates) {
  console.log('')
  console.log('────────────────────────────────────────────────────────────')
  console.log(`PACKAGE_ID                  ${candidate.packageId}`)
  console.log(`JOB_STATUS                  ${candidate.jobStatus}`)
  console.log(`ATTEMPT_COUNT               ${candidate.attemptCount}`)
  console.log(`LAST_ERROR_CODE             ${candidate.lastErrorCode ?? '-'}`)
  console.log(`MARKETPLACE_STATUS          ${candidate.marketplaceStatus ?? '-'}`)
  console.log(`MARKETPLACE_LIFECYCLE       ${candidate.marketplaceLifecycle}`)
  console.log('')
  console.log(`CARRIER_CREATE_CALLED       ${candidate.carrierCreateCalled}`)
  console.log(`ARTIFACT                    ${candidate.artifact}`)
  console.log(`UNKNOWN_EVIDENCE            ${candidate.unknownEvidence}`)
  console.log('')
  console.log(`CURRENT_PREFLIGHT_VALID     ${candidate.currentPreflightValid}`)
  console.log(`CURRENT_BLOCKERS            ${candidate.currentBlockers.join(', ') || '-'}`)
  console.log('')
  console.log(`REVIVAL_REASON              ${candidate.revivalReason}`)
  console.log(`SAFE_TO_REVIVE=${candidate.safeToRevive ? 'YES' : 'NO'}`)
}

console.log('')
console.log('────────────────────────────────────────────────────────────')
console.log(`NETWORK_CALLS=${report.networkCalls}`)
console.log(`DB_WRITES=${report.dbWrites}`)
console.log(`CARRIER_CALLS=${report.carrierCalls}`)
console.log('')
console.log('SALT-OKUNUR TESHIS. Hicbir satir yazilmadi.')
process.exit(0)
