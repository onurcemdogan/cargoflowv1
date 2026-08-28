// KANARYA GÖZLEMCİSİ — SÜREYE DEĞİL TERMİNAL DURUMA BAKAR.
//
//   npm run auto-label:canary:observe -- --name TarzimTuba \
//     --package 4111289850 --timeout-seconds 300
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
// Önceki kanarya betiği şunu yapıyordu:
//     sleep 90 && pm2 restart
// Worker'ın poll turu talebi ~60 saniye geciktirdiği için işe yalnız ~37
// saniye kaldı ve süreç `PREPARING` iken öldürüldü. Ölçüm penceresi
// TALEPTEN ÖNCE başlamıştı; yani ölçtüğümüz şey işin süresi değil,
// betiğin sabırsızlığıydı.
//
// ═══ NE YAPAR ════════════════════════════════════════════════════════════
//   • Hedef paketi TERMİNAL duruma ulaşana kadar gözler:
//       READY · BLOCKED · UNKNOWN_AFTER_NETWORK
//   • `PREPARING` ve `carrier_create_called` alanlarını da izler.
//   • Zaman aşımı SÜRECİ ÖLDÜRMEZ. İş hâlâ `PREPARING` ise
//     `ACTIVE_JOB_AT_TIMEOUT` bildirir ve worker'a DOKUNMAZ.
//
// ═══ NE YAPMAZ ═══════════════════════════════════════════════════════════
// Worker'ı AÇMAZ/KAPATMAZ, PM2'yi yeniden BAŞLATMAZ, Sürat'i ÇAĞIRMAZ,
// hiçbir satır YAZMAZ. Yalnız gözler ve raporlar; kararı operatör verir.
//
// BİLEREK düz `node` ile çalışır: üretim çözücüsünün AYNISI.
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
  console.error(`[canary-observe] ${message}`)
  process.exit(1)
}

const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')
const packageArgument = readFlag('package')
if (!packageArgument) fail('Paket ZORUNLU: --package 4111289850')
const packageId: string = packageArgument
const timeoutSeconds = Number(readFlag('timeout-seconds') ?? 300)
const pollSeconds = Math.max(2, Number(readFlag('poll-seconds') ?? 5))

const TERMINAL = ['READY', 'BLOCKED', 'UNKNOWN_AFTER_NETWORK']

const [{ getDb }, catchup, schema, drizzleOrm] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('../db/schema.ts'),
  import('drizzle-orm'),
])
const { and, eq } = drizzleOrm
const db = getDb()
const resolved = await catchup.resolveOrganizationByName(db, name)
if (!resolved) fail(`Organizasyon bulunamadi: ${name}`)
const org = resolved

async function snapshot() {
  const jobs = await db
    .select()
    .from(schema.labelJobs)
    .where(
      and(
        eq(schema.labelJobs.organizationId, org.id),
        eq(schema.labelJobs.packageId, packageId),
      ),
    )
  const operations = await db
    .select({
      carrierCreateCalled: schema.shipmentOperations.carrierCreateCalled,
      createCallCount: schema.shipmentOperations.createCallCount,
      status: schema.shipmentOperations.status,
    })
    .from(schema.shipmentOperations)
    .where(
      and(
        eq(schema.shipmentOperations.organizationId, org.id),
        eq(schema.shipmentOperations.packageId, packageId),
      ),
    )
  const artifacts = await db
    .select({ id: schema.shipments.id })
    .from(schema.shipments)
    .where(
      and(
        eq(schema.shipments.organizationId, org.id),
        eq(schema.shipments.packageId, packageId),
      ),
    )
  const job = jobs[0] ?? null
  return {
    status: job ? String(job.status) : null,
    attemptCount: job ? Number(job.attemptCount ?? 0) : null,
    lockedBy: job?.lockedBy ? String(job.lockedBy) : null,
    lastErrorCode: job?.lastErrorCode ? String(job.lastErrorCode) : null,
    carrierCreateCalled: operations.some(
      (operation) => operation.carrierCreateCalled === true,
    ),
    createCallCount: operations.reduce(
      (total, operation) => total + Number(operation.createCallCount ?? 0), 0,
    ),
    artifactExists: artifacts.length > 0,
  }
}

console.log('')
console.log(`ORGANIZATION                ${org.name} (${org.id})`)
console.log(`TARGET_PACKAGE              ${packageId}`)
console.log(`TIMEOUT_SECONDS             ${timeoutSeconds}`)
console.log(`POLL_SECONDS                ${pollSeconds}`)
console.log('')

const deadline = Date.now() + timeoutSeconds * 1000
let last = ''
let final = await snapshot()

while (Date.now() < deadline) {
  final = await snapshot()
  const line =
    `status=${final.status} attempt=${final.attemptCount} `
    + `carrierCalled=${final.carrierCreateCalled} `
    + `createCallCount=${final.createCallCount} artifact=${final.artifactExists}`
  if (line !== last) {
    console.log(`[${new Date().toISOString()}] ${line}`)
    last = line
  }
  if (final.status && TERMINAL.includes(final.status)) break
  await new Promise((resolve) => {
    const handle = setTimeout(resolve, pollSeconds * 1000)
    handle.unref?.()
  })
}

const terminal = Boolean(final.status && TERMINAL.includes(final.status))
console.log('')
console.log(`FINAL_STATUS                ${final.status ?? '-'}`)
console.log(`ATTEMPT_COUNT               ${String(final.attemptCount)}`)
console.log(`LAST_ERROR_CODE             ${final.lastErrorCode ?? '-'}`)
console.log(`CARRIER_CREATE_CALLED       ${final.carrierCreateCalled}`)
console.log(`CREATE_CALL_COUNT           ${final.createCallCount}`)
console.log(`CARRIER_ARTIFACT_EXISTS     ${final.artifactExists}`)
console.log(`TERMINAL_STATE_REACHED      ${terminal ? 'YES' : 'NO'}`)
console.log('')

if (terminal) {
  console.log('TERMINAL DURUM KALICI. Worker guvenle kapatilabilir.')
} else if (final.status === 'PREPARING') {
  // ═══ ASLA ÖLDÜRME ═════════════════════════════════════════════════════
  console.log('ACTIVE_JOB_AT_TIMEOUT')
  console.log(`  Paket ${packageId} HALA PREPARING ve is CALISIYOR olabilir.`)
  console.log('  Sureci YENIDEN BASLATMA. Tasiyici sinirinin ortasinda')
  console.log('  oldurmek, sonucu BILINMEZ birakir.')
  console.log('  Zarif kapanis: pm2 sendSignal SIGTERM <app> (worker bosalir),')
  console.log('  ardindan: npm run auto-label:stale:inspect -- --name <org>')
} else {
  console.log('TERMINAL DURUMA ULASILMADI; is kuyrukta bekliyor olabilir.')
  console.log('Worker acik mi ve poll araligi ne kadar, kontrol et.')
}
console.log('')
console.log('NETWORK_CALLS=0')
console.log('DB_WRITES=0')
console.log('CARRIER_CALLS=0')
process.exit(0)
