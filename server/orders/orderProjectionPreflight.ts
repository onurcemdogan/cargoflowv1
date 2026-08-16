// PROJEKSİYON ÖN KONTROLÜ — SALT OKUNUR.
//
// Üretimde "bu tenant projeksiyon okumasına hazır mı?" sorusunu YAZMA YAPMADAN
// yanıtlar. Hiçbir migration çalıştırmaz, hiçbir backfill tetiklemez, hiçbir
// taşıyıcı/pazaryeri çağrısı yapmaz.
//
// FAIL-CLOSED: şema beklenenden farklıysa hazırlık YOK sayılır. "Bilmiyorum"
// asla "hazır" anlamına gelmez.
//
// GİZLİLİK: rapora kimlik bilgisi, şifre, ham şifreli veri veya müşteri PII
// GİRMEZ. Organizasyon kimlikleri maskelenir.
import { getTableColumns, sql } from 'drizzle-orm'
import { orderFilterProjection } from '../db/schema.ts'
import { ORDER_FILTER_PROJECTION_VERSION } from './orderFilterProjectionBuilder.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

const PROJECTION_TABLE = 'order_filter_projection'

/** Şemadaki kolon adları — TEK doğruluk kaynağı `schema.ts`. */
export function expectedProjectionColumns(): string[] {
  return Object.values(getTableColumns(orderFilterProjection))
    .map((column) => String((column as { name: string }).name))
    .sort()
}

export const EXPECTED_PROJECTION_INDEXES = [
  'order_filter_projection_org_order_unique',
  'order_filter_projection_org_version_idx',
]

export interface TenantPreflight {
  organizationMasked: string
  orderCount: number
  activeOrderCount: number
  projectionCount: number
  versionDistribution: Record<string, number>
  /** Projeksiyonu eksik veya sürümü eski sipariş sayısı. */
  staleEstimate: number
  readinessCandidate: boolean
}

export interface ProjectionPreflightReport {
  databaseEngine: string
  schemaVersion: string
  migration0008Applied: boolean
  projectionTableExists: boolean
  projectionColumnsOk: boolean
  projectionIndexesOk: boolean
  projectionFkCascadeOk: boolean
  schemaOk: boolean
  organizationCount: number
  orderCount: number
  activeOrderCount: number
  projectionRowCount: number
  expectedProjectionVersion: number
  tenants: TenantPreflight[]
  problems: string[]
}

/** `****abcd` — tam kimlik BASILMAZ. */
export function maskOrganization(value: unknown): string {
  const text = String(value ?? '').trim()
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`
}

const rowsOf = (result: unknown): Record<string, unknown>[] => {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const wrapped = (result as { rows?: unknown[] })?.rows
  return (wrapped ?? []) as Record<string, unknown>[]
}

const num = (value: unknown): number => Number(value ?? 0)

async function safeRows(db: Db, statement: string) {
  try {
    return rowsOf(await db.execute(sql.raw(statement)))
  } catch {
    return null
  }
}

/**
 * Salt okunur ön kontrol raporu üretir.
 *
 * `organizationId` verilirse yalnız o tenant incelenir (kanarya kapsamı).
 */
export async function buildProjectionPreflightReport(
  db: Db,
  options: { organizationId?: string } = {},
): Promise<ProjectionPreflightReport> {
  const problems: string[] = []

  const engineRow = await safeRows(db, 'select version() as version')
  const databaseEngine = String(engineRow?.[0]?.version ?? 'UNKNOWN').split(
    ' on ',
  )[0]

  // Uygulanmış migration defteri (drizzle runner'ın kendi tablosu).
  const applied = await safeRows(
    db,
    `select count(*)::int as n from drizzle.__drizzle_migrations`,
  )
  const schemaVersion = applied ? `${num(applied[0]?.n)} migrations` : 'UNKNOWN'

  const tableRow = await safeRows(
    db,
    `select table_name from information_schema.tables
     where table_schema='public' and table_name='${PROJECTION_TABLE}'`,
  )
  const projectionTableExists = (tableRow?.length ?? 0) > 0
  if (!projectionTableExists) problems.push('PROJECTION_TABLE_MISSING')

  let projectionColumnsOk = false
  let projectionIndexesOk = false
  let projectionFkCascadeOk = false

  if (projectionTableExists) {
    const columns = await safeRows(
      db,
      `select column_name from information_schema.columns
       where table_name='${PROJECTION_TABLE}' order by column_name`,
    )
    const actual = (columns ?? []).map((c) => String(c.column_name)).sort()
    const expected = expectedProjectionColumns()
    projectionColumnsOk =
      actual.length === expected.length &&
      expected.every((name, index) => actual[index] === name)
    if (!projectionColumnsOk) problems.push('PROJECTION_COLUMNS_MISMATCH')

    const indexes = await safeRows(
      db,
      `select indexname from pg_indexes where tablename='${PROJECTION_TABLE}'`,
    )
    const names = new Set((indexes ?? []).map((i) => String(i.indexname)))
    projectionIndexesOk = EXPECTED_PROJECTION_INDEXES.every((i) => names.has(i))
    if (!projectionIndexesOk) problems.push('PROJECTION_INDEXES_MISSING')

    const fks = await safeRows(
      db,
      `select rc.delete_rule, kcu.column_name
       from information_schema.table_constraints tc
         join information_schema.referential_constraints rc
           on rc.constraint_name = tc.constraint_name
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
       where tc.table_name='${PROJECTION_TABLE}'
         and tc.constraint_type='FOREIGN KEY'`,
    )
    projectionFkCascadeOk = (fks ?? []).some(
      (f) =>
        String(f.column_name) === 'order_id' &&
        String(f.delete_rule).toUpperCase() === 'CASCADE',
    )
    if (!projectionFkCascadeOk) problems.push('PROJECTION_FK_CASCADE_MISSING')
  }

  const migration0008Applied =
    projectionTableExists && projectionColumnsOk && projectionFkCascadeOk

  const scope = options.organizationId
    ? `where organization_id = '${options.organizationId}'`
    : ''

  const orgRows = await safeRows(
    db,
    options.organizationId
      ? `select count(*)::int as n from organizations where id='${options.organizationId}'`
      : 'select count(*)::int as n from organizations',
  )
  const orderRows = await safeRows(
    db,
    `select count(*)::int as total,
            count(*) filter (where archived_at is null)::int as active
     from orders ${scope}`,
  )
  const projectionRows = projectionTableExists
    ? await safeRows(
        db,
        `select count(*)::int as n from ${PROJECTION_TABLE} ${scope}`,
      )
    : null

  // Tenant kırılımı — kimlikler MASKELİ.
  const perTenant = await safeRows(
    db,
    `select organization_id,
            count(*)::int as total,
            count(*) filter (where archived_at is null)::int as active
     from orders ${scope}
     group by organization_id order by organization_id`,
  )
  const perTenantProjection = projectionTableExists
    ? await safeRows(
        db,
        `select organization_id, projection_version, count(*)::int as n
         from ${PROJECTION_TABLE} ${scope}
         group by organization_id, projection_version`,
      )
    : []

  const tenants: TenantPreflight[] = (perTenant ?? []).map((row) => {
    const organizationId = String(row.organization_id)
    const versionDistribution: Record<string, number> = {}
    let projectionCount = 0
    let currentVersion = 0
    for (const entry of perTenantProjection ?? []) {
      if (String(entry.organization_id) !== organizationId) continue
      const version = String(entry.projection_version)
      versionDistribution[version] = num(entry.n)
      projectionCount += num(entry.n)
      if (Number(version) === ORDER_FILTER_PROJECTION_VERSION) {
        currentVersion += num(entry.n)
      }
    }
    const total = num(row.total)
    // Eksik satır + eski sürümlü satır.
    const staleEstimate = Math.max(0, total - currentVersion)
    return {
      organizationMasked: maskOrganization(organizationId),
      orderCount: total,
      activeOrderCount: num(row.active),
      projectionCount,
      versionDistribution,
      staleEstimate,
      // ADAY ≠ HAZIR: gerçek hazırlık gölge pariteyi de gerektirir.
      readinessCandidate:
        migration0008Applied && projectionIndexesOk && staleEstimate === 0,
    }
  })

  return {
    databaseEngine,
    schemaVersion,
    migration0008Applied,
    projectionTableExists,
    projectionColumnsOk,
    projectionIndexesOk,
    projectionFkCascadeOk,
    schemaOk: problems.length === 0,
    organizationCount: num(orgRows?.[0]?.n),
    orderCount: num(orderRows?.[0]?.total),
    activeOrderCount: num(orderRows?.[0]?.active),
    projectionRowCount: num(projectionRows?.[0]?.n),
    expectedProjectionVersion: ORDER_FILTER_PROJECTION_VERSION,
    tenants,
    problems,
  }
}

export interface TenantReadiness {
  organizationMasked: string
  migrationCompatible: boolean
  coverageComplete: boolean
  versionCurrent: boolean
  staleCount: number
  backfillComplete: boolean
  shadowParityAccepted: boolean
  ready: boolean
  blockers: string[]
}

/**
 * TENANT HAZIRLIĞI — GLOBAL BAYRAK YOKTUR.
 *
 * Her tenant kendi başına değerlendirilir; biri diğerini ETKİLEMEZ. Gölge
 * parite kabulü DIŞARIDAN verilir ve varsayılanı FALSE'tur: hiçbir tenant
 * kendiliğinden "hazır" olamaz. Eksik bilgi = HAZIR DEĞİL.
 */
export async function evaluateTenantReadiness(
  db: Db,
  organizationId: string,
  options: { shadowParityAccepted?: boolean } = {},
): Promise<TenantReadiness> {
  const report = await buildProjectionPreflightReport(db, { organizationId })
  const tenant = report.tenants[0]
  const staleCount = tenant?.staleEstimate ?? 0
  // Tenant'ın hiç siparişi yoksa kapsama boş ama TAM sayılır.
  const coverageComplete = report.schemaOk && staleCount === 0
  const versionCurrent = Object.keys(tenant?.versionDistribution ?? {}).every(
    (version) => Number(version) === ORDER_FILTER_PROJECTION_VERSION,
  )
  const shadowParityAccepted = options.shadowParityAccepted === true

  const blockers: string[] = []
  if (!report.migration0008Applied) blockers.push('MIGRATION_NOT_APPLIED')
  if (!report.schemaOk) blockers.push('SCHEMA_NOT_COMPATIBLE')
  if (staleCount > 0) blockers.push('BACKFILL_INCOMPLETE')
  if (!versionCurrent) blockers.push('PROJECTION_VERSION_STALE')
  if (!shadowParityAccepted) blockers.push('SHADOW_PARITY_NOT_ACCEPTED')

  return {
    organizationMasked: maskOrganization(organizationId),
    migrationCompatible: report.migration0008Applied && report.schemaOk,
    coverageComplete,
    versionCurrent,
    staleCount,
    backfillComplete: staleCount === 0,
    shadowParityAccepted,
    ready: blockers.length === 0,
    blockers,
  }
}

/** Rapor satırları — CLI ve testler AYNI biçimi kullanır. */
export function formatPreflightReport(
  report: ProjectionPreflightReport,
): string[] {
  const lines = [
    `DATABASE_ENGINE            ${report.databaseEngine}`,
    `SCHEMA_VERSION             ${report.schemaVersion}`,
    `MIGRATION_0008_APPLIED     ${report.migration0008Applied ? 'YES' : 'NO'}`,
    `PROJECTION_TABLE_EXISTS    ${report.projectionTableExists ? 'YES' : 'NO'}`,
    `PROJECTION_COLUMNS_OK      ${report.projectionColumnsOk ? 'YES' : 'NO'}`,
    `PROJECTION_INDEXES_OK      ${report.projectionIndexesOk ? 'YES' : 'NO'}`,
    `PROJECTION_FK_CASCADE_OK   ${report.projectionFkCascadeOk ? 'YES' : 'NO'}`,
    '',
    `ORGANIZATION_COUNT         ${report.organizationCount}`,
    `ORDER_COUNT                ${report.orderCount}`,
    `ACTIVE_ORDER_COUNT         ${report.activeOrderCount}`,
    `PROJECTION_ROW_COUNT       ${report.projectionRowCount}`,
    `EXPECTED_VERSION           ${report.expectedProjectionVersion}`,
    '',
    'TENANTS (maskeli)',
  ]
  for (const tenant of report.tenants) {
    lines.push(
      `  ${tenant.organizationMasked}  orders=${tenant.orderCount}` +
        `  active=${tenant.activeOrderCount}` +
        `  projection=${tenant.projectionCount}` +
        `  versions=${JSON.stringify(tenant.versionDistribution)}` +
        `  stale=${tenant.staleEstimate}` +
        `  candidate=${tenant.readinessCandidate ? 'YES' : 'NO'}`,
    )
  }
  if (report.problems.length > 0) {
    lines.push('', `PROBLEMS  ${report.problems.join(', ')}`)
  }
  return lines
}
