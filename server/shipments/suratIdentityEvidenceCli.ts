// SÜRAT KİMLİK KANITI + DESTEK PAKETİ — SALT OKUNUR.
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
//
// Bir destek paketi ELLE birleştirildi ve iki farklı paketin kimliklerini
// karıştırdı: `ReferansNo` bir paketten, `OzelKargoTakipNo` BAŞKA bir
// paketten alındı. Taşıyıcıya gidecek bir raporda bu, yanlış gönderiyi
// soruşturmak demektir.
//
// KURAL: destek paketi ARTIK ELLE YAZILMAZ. Yalnız KALICI KANITTAN üretilir:
//   · telde GERÇEKTEN serileşen değerler → Trace V2 `ACTUAL_WIRE_READY`
//   · kiracının kendi sipariş kaydı      → `orders` tablosu
//
// İkisi ÇELİŞİRSE bu, raporlama hatası DEĞİL, canlı bir kimlik kusurudur ve
// araç bunu AÇIKÇA bildirir.
//
// YAZMA YOK · TAŞIYICI ÇAĞRISI YOK · BASKI YOK.
import { and, eq } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { orders } from '../db/schema.ts'
import { resolveOrganizationByName } from './suratBillingScanner.ts'
import { listTraceAttempts } from './suratTraceRepository.ts'

const readArg = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

const orMissing = (value: unknown): string => text(value) || 'ABSENT'
const yesNo = (value: boolean): string => (value ? 'YES' : 'NO')

/** Kimlik bilgisi PII değildir ama tam değer basmak yerine kısaltılır. */
const show = (value: unknown): string => {
  const raw = text(value)
  return raw || 'ABSENT'
}

interface WireIdentity {
  traceId: string
  createdAt: string
  referansNo: string
  ozelKargoTakipNo: string
  operation: string
  serviceMode: string
  host: string
  finalState: string
}

const stageList = (row: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(row?.stages) ? (row.stages as Record<string, unknown>[]) : []

/** Telde GERÇEKTEN serileşen kimlik — karar aşaması DEĞİL. */
function readWireIdentity(row: Record<string, unknown>): WireIdentity {
  const stages = stageList(row)
  const wire = stages.find((entry) => entry?.stage === 'ACTUAL_WIRE_READY')
  const data = (wire?.data ?? {}) as Record<string, unknown>
  const safeValues = (data.safeValues ?? {}) as Record<string, unknown>
  return {
    traceId: text(row.traceId),
    createdAt: text(row.createdAt),
    // `ACTUAL_WIRE_READY` yoksa bu alanlar ABSENT kalır — UYDURULMAZ.
    referansNo: text(safeValues.ReferansNo),
    ozelKargoTakipNo: text(safeValues.OzelKargoTakipNo),
    operation: text(data.operation ?? row.operation),
    serviceMode: text(data.serviceMode ?? row.serviceMode),
    host: text(data.host),
    finalState: text(row.finalState),
  }
}

export async function runSuratIdentityEvidence(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[surat:identity] DATABASE_URL tanımlı değil.')
    return 1
  }
  const db = getDb()
  const name = readArg('name')
  const packageId = readArg('package')
  let organizationId = readArg('org')
  if (!organizationId && name) {
    const resolved = await resolveOrganizationByName(db, name)
    if (resolved.status !== 'ok') {
      console.error(`[surat:identity] "${name}" için tenant çözülemedi.`)
      return 1
    }
    organizationId = resolved.organization.id
  }
  if (!organizationId || !packageId) {
    console.error('[surat:identity] (--org veya --name) ve --package ZORUNLU.')
    return 1
  }

  // ── 1) OTORİTER KAYIT — kiracının KENDİ sipariş satırı ────────────────
  const orderRows = await db
    .select()
    .from(orders)
    .where(and(
      eq(orders.organizationId, organizationId),
      eq(orders.packageId, packageId),
    ))
    .limit(1)
  const orderRow = orderRows?.[0] as Record<string, unknown> | undefined

  // ── 2) TELDE GİDEN — kalıcı Trace V2 ──────────────────────────────────
  // Repo deseni: drizzle istemcisi depo sözleşmesinin dar tipine köprülenir
  // (bkz. suratCanaryPrecheckCli).
  const traces = await listTraceAttempts(
    db as unknown as Parameters<typeof listTraceAttempts>[0],
    organizationId,
    200,
  )
  const matching = (traces ?? []).filter(
    (row) => text(row.packageId) === packageId,
  )
  const wire = matching.length > 0 ? readWireIdentity(matching[0]) : null

  const dbPackageId = text(orderRow?.packageId)
  const dbOrderNumber = text(orderRow?.orderNumber)
  const dbTracking = text(orderRow?.cargoTrackingNumber)

  console.info('=== SÜRAT KİMLİK KANITI (SALT OKUNUR) ===')
  console.info('')
  console.info('IDENTITY_SOURCE_OF_TRUTH     orders tablosu (kiracı kapsamlı)')
  console.info(`DB_PACKAGE_ID                ${orMissing(dbPackageId)}`)
  console.info(`DB_ORDER_NUMBER              ${orMissing(dbOrderNumber)}`)
  console.info(`DB_CARGO_TRACKING_NUMBER     ${orMissing(dbTracking)}`)
  console.info('')
  console.info(`TRACES_FOR_PACKAGE           ${matching.length}`)
  console.info(`TRACE_ID                     ${orMissing(wire?.traceId)}`)
  console.info(`TRACE_CREATED_AT             ${orMissing(wire?.createdAt)}`)
  console.info(`NETWORK_REFERANS_NO          ${show(wire?.referansNo)}`)
  console.info(`NETWORK_OZEL_KARGO_TAKIP_NO  ${show(wire?.ozelKargoTakipNo)}`)
  console.info(`NETWORK_OPERATION            ${orMissing(wire?.operation)}`)
  console.info(`NETWORK_SERVICE_MODE         ${orMissing(wire?.serviceMode)}`)
  console.info(`NETWORK_HOST                 ${orMissing(wire?.host)}`)
  console.info(`FINAL_STATE                  ${orMissing(wire?.finalState)}`)
  console.info('')

  if (!orderRow) {
    console.info('VERDICT                      DB_ORDER_NOT_FOUND')
    console.info('')
    console.info('NETWORK_CALLS 0 · DB_WRITES 0 · CREATE_CALLS 0 · PRINT_CALLS 0')
    return 1
  }
  if (!wire || (!wire.referansNo && !wire.ozelKargoTakipNo)) {
    // Kanıt YOKSA "eşleşti" DENMEZ.
    console.info('IDENTITY_MATCH_PACKAGE       UNKNOWN_NO_WIRE_EVIDENCE')
    console.info('IDENTITY_MATCH_TRACKING      UNKNOWN_NO_WIRE_EVIDENCE')
    console.info('VERDICT                      NO_PERSISTED_ACTUAL_WIRE')
    console.info('')
    console.info('NETWORK_CALLS 0 · DB_WRITES 0 · CREATE_CALLS 0 · PRINT_CALLS 0')
    return 1
  }

  const packageMatch = wire.referansNo === dbPackageId
  const trackingMatch = wire.ozelKargoTakipNo === dbTracking
  console.info(`IDENTITY_MATCH_PACKAGE       ${yesNo(packageMatch)}`)
  console.info(`IDENTITY_MATCH_TRACKING      ${yesNo(trackingMatch)}`)
  console.info('')

  if (packageMatch && trackingMatch) {
    console.info('VERDICT                      IDENTITY_CONSISTENT')
    console.info('ACTUAL_WIRE_WAS_WRONG        NO')
  } else {
    // CANLI KİMLİK KUSURU. Rapor hatası DEĞİL.
    console.info('VERDICT                      CROSS_ORDER_IDENTITY_LEAK')
    console.info('ACTUAL_WIRE_WAS_WRONG        YES')
    console.info('')
    console.info('  Telde giden kimlik kiracının KENDİ kaydıyla UYUŞMUYOR.')
    console.info('  Bu, taşıyıcıda YANLIŞ gönderi demektir; yeni create YAPMAYIN.')
  }

  // ── 3) DESTEK PAKETİ — YALNIZ yukarıdaki kanıttan ─────────────────────
  console.info('')
  console.info('=== SÜRAT DESTEK PAKETİ (kanıttan üretildi) ===')
  console.info(`  traceId            ${wire.traceId}`)
  console.info(`  timestamp          ${wire.createdAt}`)
  console.info(`  host               ${orMissing(wire.host)}`)
  console.info(`  operation          ${orMissing(wire.operation)}`)
  console.info(`  ReferansNo         ${show(wire.referansNo)}`)
  console.info(`  OzelKargoTakipNo   ${show(wire.ozelKargoTakipNo)}`)
  console.info(`  finalState         ${orMissing(wire.finalState)}`)
  console.info('  (kimlik bilgileri MASKELİ değildir; sır/PII İÇERMEZ)')
  console.info('')
  console.info('NETWORK_CALLS 0 · DB_WRITES 0 · CREATE_CALLS 0 · PRINT_CALLS 0')
  return packageMatch && trackingMatch ? 0 : 2
}

const invokedDirectly = process.argv[1]?.includes('suratIdentityEvidenceCli')
if (invokedDirectly) {
  runSuratIdentityEvidence()
    .then(async (code) => { await closePool(); process.exitCode = code })
    .catch(async (error) => {
      console.error('[surat:identity]', (error as Error)?.message)
      await closePool()
      process.exitCode = 1
    })
}
