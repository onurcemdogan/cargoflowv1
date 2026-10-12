// KARGO OPERASYONLARI + GÖNDERİLER — SALT OKUNUR GÖRÜNÜMLER.
//
// İki ürün sorusunun sunucu kaynağı:
//   • Kargo Operasyonları — "Kargo üretim hattında şu anda ne oluyor?"
//     (kuyruk / hazırlanıyor / etiket hazır / kontrol gerekli, arka plan
//     hazırlama durumu, son işlemler, istisnalar)
//   • Gönderiler — "Kargoya çıktıktan sonra ne oldu?" (gönderi merkezli
//     defter; sipariş merkezli değil)
//
// YALNIZ yerel PostgreSQL okunur: taşıyıcıya/pazaryerine çağrı YOK, yazım YOK,
// create YOK. Her sorgu kiracı kapsamlıdır. Ham taşıyıcı yükü, ZPL, müşteri
// adı/adres/telefon bu yanıtlara GİRMEZ.
import { sql } from 'drizzle-orm'
import { resolveReportingRange } from '../../src/dashboard/reportingRange.ts'
import { isLabelWorkerEnabled } from './labelJobWorker.ts'
import { loadAutoLabelSettings } from './autoLabelProducer.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function rowsOf(result: unknown): Record<string, unknown>[] {
  const value = result as { rows?: Record<string, unknown>[] } | Record<string, unknown>[]
  return Array.isArray(value) ? value : (value?.rows ?? [])
}

function iso(value: unknown): string | null {
  if (value == null || value === '') return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function requireOrg(value: unknown): string {
  const organizationId = String(value ?? '').trim()
  if (!organizationId) throw new Error('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  return organizationId
}

/** Kontrol gerektiren kanonik sipariş operasyon durumları. */
export const ATTENTION_OPERATION_STATUSES = [
  'ERROR',
  'SURAT_BARCODE_FAILED',
  'SURAT_DISPATCH_REJECTED',
  'SURAT_TRACKING_MISSING',
  'LABEL_CREATED_UNVERIFIED',
  'LABEL_CREATED_NOT_REGISTERED',
  'CREATE_ACCEPTED_UNCONFIRMED',
] as const

const PRINTED_STATUSES = ['LABEL_PRINTED', 'HANDED_TO_CARGO', 'DELIVERED', 'DELIVERED_SPECIAL', 'RETURNING']

const CARRIER_LABEL: Record<string, string> = { surat: 'Sürat Kargo', aras: 'Aras Kargo' }
export const carrierLabel = (provider: unknown) =>
  CARRIER_LABEL[String(provider ?? '').toLowerCase()] ?? String(provider ?? '—')

const PAYER_LABEL: Record<string, string> = {
  MARKETPLACE_PAYS: 'Pazaryeri öder',
  SELLER_PAYS: 'Satıcı öder',
}

/** İş/işlem hata kodlarının sade Türkçe karşılığı (bilinmeyen kod: kod + özet). */
const REASON_TEXT: Record<string, string> = {
  UNKNOWN_AFTER_NETWORK: 'Taşıyıcı sonucu kesinleşmedi; mükerrer gönderi olmaması için yeniden denenmez. Mutabakat gerekli.',
  TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS: 'Trendyol paket statüsü gönderi oluşturmaya uygun değil.',
  TRENDYOL_PICKING_UPDATE_FAILED: 'Trendyol paketi "İşleme Al" statüsüne alınamadı.',
  SURAT_PREFLIGHT_DESI_MISSING: 'Desi bilgisi eksik.',
  SURAT_CREDENTIAL_CONFIG_INVALID: 'Sürat kimlik ayarı geçersiz.',
  PRIMARY_CREDENTIAL_NOT_CONFIGURED: 'Sürat ana kimliği tanımlı değil.',
  SHIPMENT_PREFLIGHT_BLOCKED: 'Gönderi ön kontrolü tamamlanmadı (kargo hesabı / ödeyen / doğrulama).',
  BILLING_CONTEXT_INVALID: 'Kargo ücretini kimin ödeyeceği belirlenemedi.',
  LABEL_WORKER_EXCEPTION: 'Arka plan hazırlama beklenmeyen hata verdi; sonuç belirsiz sayıldı.',
  // Kanonik sipariş operasyon durumları (ATTENTION_OPERATION_STATUSES).
  ERROR: 'Gönderi işleminde hata oluştu; sipariş detayını kontrol edin.',
  SURAT_BARCODE_FAILED: 'Sürat barkodu alınamadı.',
  SURAT_DISPATCH_REJECTED: 'Sürat gönderi isteğini reddetti.',
  SURAT_TRACKING_MISSING: 'Sürat takip numarası alınamadı.',
  LABEL_CREATED_UNVERIFIED: 'Etiket oluştu ancak Sürat kaydı doğrulanamadı.',
  LABEL_CREATED_NOT_REGISTERED: 'Etiket oluştu ancak Sürat kaydı bulunamadı.',
  CREATE_ACCEPTED_UNCONFIRMED: 'Sürat isteği kabul etti ancak sonuç doğrulanmadı.',
}

function reasonFor(code: unknown, summary: unknown): string {
  const key = String(code ?? '').trim()
  if (key && REASON_TEXT[key]) return REASON_TEXT[key]
  const text = String(summary ?? '').trim().slice(0, 240)
  if (text) return text
  return key ? `Kontrol gerekli (${key}).` : 'Kontrol gerekli.'
}

function istanbulTodayStart(now: Date): Date {
  return resolveReportingRange('today', now, 'Europe/Istanbul').start
}

/* ═══ KARGO OPERASYONLARI ═══════════════════════════════════════════════ */

export interface PipelineAttentionRow {
  kind: 'BLOCKED' | 'UNKNOWN_AFTER_NETWORK' | 'OPERATION_FAILED' | 'OPERATION_UNCERTAIN' | 'UNVERIFIED'
  orderId: string | null
  orderNumber: string
  packageId: string
  marketplace: string
  reason: string
  updatedAt: string | null
}

export interface PipelineRecentRow {
  orderId: string | null
  orderNumber: string
  packageId: string
  marketplace: string
  carrier: string
  stage: string
  stageTone: 'success' | 'warning' | 'danger' | 'neutral'
  labelState: 'ready' | 'printed' | 'none'
  trackingNumber: string | null
  updatedAt: string | null
  canReprint: boolean
  /** Bu paket için gönderi kaydı var mı ("Gönderiyi görüntüle" yalnız o zaman). */
  hasShipment: boolean
}

export interface ShippingPipeline {
  summary: {
    queued: number
    preparing: number
    labelReady: number
    needsAttention: number
    createdToday: number
    handedToday: number
  }
  worker: {
    /** Arka plan hazırlama bu sunucuda açık mı (dağıtım ayarı). */
    backgroundEnabled: boolean
    /** Bu çalışma alanı için otomatik etiket açık mı. */
    workspaceEnabled: boolean
    counts: Record<'QUEUED' | 'PREPARING' | 'READY' | 'BLOCKED' | 'UNKNOWN_AFTER_NETWORK' | 'FAILED_SAFE_TO_RETRY', number>
    lastPreparedAt: string | null
    /** Son 7 günde hazırlanan işlerin ortalama süresi (sn); örnek yoksa null. */
    averagePrepSeconds: number | null
    sampleSize: number
  }
  attention: PipelineAttentionRow[]
  recent: PipelineRecentRow[]
}

export async function loadShippingPipeline(
  db: Db,
  params: { organizationId: string; now?: Date; env?: Record<string, string | undefined> },
): Promise<ShippingPipeline> {
  const organizationId = requireOrg(params.organizationId)
  const now = params.now ?? new Date()
  const todayStart = istanbulTodayStart(now).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  const attentionStatuses = sql.join(ATTENTION_OPERATION_STATUSES.map((s) => sql`${s}`), sql`, `)

  const [jobCounts, prep, orderCounts, shipmentToday, settings] = await Promise.all([
    db.execute(sql`SELECT status, count(*)::int AS n FROM label_jobs
      WHERE organization_id = ${organizationId} GROUP BY status`),
    db.execute(sql`SELECT max(updated_at) AS last_ready,
        avg(EXTRACT(EPOCH FROM (updated_at - created_at))) FILTER (WHERE updated_at >= ${weekAgo}) AS avg_seconds,
        count(*) FILTER (WHERE updated_at >= ${weekAgo})::int AS samples
      FROM label_jobs WHERE organization_id = ${organizationId} AND status = 'READY'`),
    db.execute(sql`SELECT
        count(*) FILTER (WHERE operation_status = 'LABEL_READY')::int AS label_ready,
        count(*) FILTER (WHERE operation_status = 'HANDED_TO_CARGO' AND last_operational_activity_at >= ${todayStart})::int AS handed_today
      FROM orders WHERE organization_id = ${organizationId} AND archived_at IS NULL`),
    db.execute(sql`SELECT count(*)::int AS n FROM shipments
      WHERE organization_id = ${organizationId} AND source = 'local_create' AND created_at >= ${todayStart}`),
    loadAutoLabelSettings(db, organizationId).catch(() => null),
  ])

  const counts = { QUEUED: 0, PREPARING: 0, READY: 0, BLOCKED: 0, UNKNOWN_AFTER_NETWORK: 0, FAILED_SAFE_TO_RETRY: 0 }
  for (const row of rowsOf(jobCounts)) {
    const key = String(row.status) as keyof typeof counts
    if (key in counts) counts[key] = Number(row.n ?? 0)
  }
  const prepRow = rowsOf(prep)[0] ?? {}
  const orderRow = rowsOf(orderCounts)[0] ?? {}

  // ── İstisnalar: iş kuyruğu + işlem kaydı + doğrulanamayan gönderi ─────
  const attentionRows = rowsOf(await db.execute(sql`
    WITH job_issues AS (
      SELECT j.package_id, j.marketplace, j.status AS kind, j.last_error_code AS code,
             j.last_error_summary AS summary, j.updated_at
      FROM label_jobs j
      WHERE j.organization_id = ${organizationId} AND j.status IN ('BLOCKED', 'UNKNOWN_AFTER_NETWORK')
    ),
    op_issues AS (
      SELECT so.package_id, so.marketplace,
             CASE WHEN so.status = 'failed' THEN 'OPERATION_FAILED' ELSE 'OPERATION_UNCERTAIN' END AS kind,
             so.error_code AS code, NULL::text AS summary, so.updated_at
      FROM shipment_operations so
      WHERE so.organization_id = ${organizationId}
        AND (so.status = 'failed' OR (so.status = 'pending' AND so.carrier_create_called = true))
        AND NOT EXISTS (SELECT 1 FROM job_issues ji WHERE ji.package_id = so.package_id)
    ),
    order_issues AS (
      SELECT o.package_id, o.marketplace, 'UNVERIFIED' AS kind, o.operation_status AS code,
             NULL::text AS summary, o.updated_at
      FROM orders o
      WHERE o.organization_id = ${organizationId} AND o.archived_at IS NULL
        AND o.operation_status IN (${attentionStatuses})
        AND NOT EXISTS (SELECT 1 FROM job_issues ji WHERE ji.package_id = o.package_id)
        AND NOT EXISTS (SELECT 1 FROM op_issues oi WHERE oi.package_id = o.package_id)
    ),
    issues AS (
      SELECT * FROM job_issues UNION ALL SELECT * FROM op_issues UNION ALL SELECT * FROM order_issues
    )
    SELECT i.*, o.id AS order_id, o.order_number
    FROM issues i
    LEFT JOIN LATERAL (
      SELECT id, order_number FROM orders o
      WHERE o.organization_id = ${organizationId} AND o.package_id = i.package_id AND o.marketplace = i.marketplace
      ORDER BY o.updated_at DESC LIMIT 1
    ) o ON true
    ORDER BY i.updated_at DESC NULLS LAST
    LIMIT 100`))
  const attention: PipelineAttentionRow[] = attentionRows.map((row) => ({
    kind: String(row.kind) as PipelineAttentionRow['kind'],
    orderId: row.order_id ? String(row.order_id) : null,
    orderNumber: String(row.order_number ?? row.package_id ?? ''),
    packageId: String(row.package_id ?? ''),
    marketplace: String(row.marketplace ?? ''),
    reason: row.kind === 'UNKNOWN_AFTER_NETWORK' || row.kind === 'OPERATION_UNCERTAIN'
      ? REASON_TEXT.UNKNOWN_AFTER_NETWORK
      : reasonFor(row.code, row.summary),
    updatedAt: iso(row.updated_at),
  }))
  const totalAttention = Number(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM (
      SELECT package_id FROM label_jobs WHERE organization_id = ${organizationId} AND status IN ('BLOCKED', 'UNKNOWN_AFTER_NETWORK')
      UNION
      SELECT package_id FROM shipment_operations WHERE organization_id = ${organizationId}
        AND (status = 'failed' OR (status = 'pending' AND carrier_create_called = true))
      UNION
      SELECT package_id FROM orders WHERE organization_id = ${organizationId} AND archived_at IS NULL
        AND operation_status IN (${attentionStatuses})
    ) x`))[0]?.n ?? 0)

  // ── Son işlemler (gönderi oluşturma kayıtları) ───────────────────────
  const recentRows = rowsOf(await db.execute(sql`
    SELECT so.package_id, so.marketplace, so.provider, so.status, so.carrier_create_called, so.updated_at,
           o.id AS order_id, o.order_number, o.operation_status, s.id AS shipment_id, s.tracking_number
    FROM shipment_operations so
    LEFT JOIN LATERAL (
      SELECT id, order_number, operation_status FROM orders o
      WHERE o.organization_id = so.organization_id AND o.package_id = so.package_id AND o.marketplace = so.marketplace
      ORDER BY o.updated_at DESC LIMIT 1
    ) o ON true
    LEFT JOIN shipments s
      ON s.organization_id = so.organization_id AND s.package_id = so.package_id AND s.marketplace = so.marketplace
    WHERE so.organization_id = ${organizationId} AND so.operation_type = 'CREATE'
    ORDER BY so.updated_at DESC
    LIMIT 30`))
  const recent: PipelineRecentRow[] = recentRows.map((row) => {
    const status = String(row.status ?? '')
    const crossed = row.carrier_create_called === true
    const stage = status === 'succeeded'
      ? { stage: 'Gönderi oluşturuldu', stageTone: 'success' as const }
      : status === 'failed'
        ? { stage: 'Taşıyıcı reddetti', stageTone: 'danger' as const }
        : status === 'blocked'
          ? { stage: 'Ön kontrolde durdu', stageTone: 'warning' as const }
          : crossed
            ? { stage: 'Sonuç kesinleşmedi', stageTone: 'danger' as const }
            : { stage: 'Hazırlanıyor', stageTone: 'neutral' as const }
    const operation = String(row.operation_status ?? '')
    const labelState: PipelineRecentRow['labelState'] = PRINTED_STATUSES.includes(operation)
      ? 'printed'
      : operation === 'LABEL_READY'
        ? 'ready'
        : 'none'
    return {
      orderId: row.order_id ? String(row.order_id) : null,
      orderNumber: String(row.order_number ?? row.package_id ?? ''),
      packageId: String(row.package_id ?? ''),
      marketplace: String(row.marketplace ?? ''),
      carrier: carrierLabel(row.provider),
      ...stage,
      labelState,
      trackingNumber: row.tracking_number ? String(row.tracking_number) : null,
      updatedAt: iso(row.updated_at),
      canReprint: status === 'succeeded' && labelState !== 'none' && Boolean(row.order_id),
      hasShipment: Boolean(row.shipment_id),
    }
  })

  return {
    summary: {
      queued: counts.QUEUED + counts.FAILED_SAFE_TO_RETRY,
      preparing: counts.PREPARING,
      labelReady: Number(orderRow.label_ready ?? 0),
      needsAttention: totalAttention,
      createdToday: Number(rowsOf(shipmentToday)[0]?.n ?? 0),
      handedToday: Number(orderRow.handed_today ?? 0),
    },
    worker: {
      backgroundEnabled: isLabelWorkerEnabled(params.env ?? process.env),
      workspaceEnabled: settings?.enabled === true,
      counts,
      lastPreparedAt: iso(prepRow.last_ready),
      averagePrepSeconds: prepRow.avg_seconds == null ? null : Math.round(Number(prepRow.avg_seconds)),
      sampleSize: Number(prepRow.samples ?? 0),
    },
    attention,
    recent,
  }
}

/* ═══ GÖNDERİLER (DEFTER) ═══════════════════════════════════════════════ */

export const SHIPMENT_TABS = ['all', 'label_ready', 'in_transit', 'delivered', 'attention'] as const
export type ShipmentTab = (typeof SHIPMENT_TABS)[number]

export interface ShipmentLedgerFilters {
  tab?: ShipmentTab
  provider?: string
  marketplace?: string
  labelState?: 'ready' | 'printed' | 'none'
  search?: string
  /** YYYY-MM-DD (İstanbul günü) — gönderi oluşturulma tarihi. */
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

export interface ShipmentLedgerRow {
  shipmentId: string
  orderId: string | null
  orderNumber: string
  packageId: string
  marketplace: string
  carrier: string
  trackingNumber: string | null
  lifecycle: Exclude<ShipmentTab, 'all'> | 'created'
  lifecycleLabel: string
  labelState: 'ready' | 'printed' | 'none'
  payer: string
  carrierAccount: string | null
  createdAt: string | null
  lastActivityAt: string | null
  /** Hazır/basılmış etiket var → yeniden yazdırma (create DEĞİL) mümkün. */
  canReprint: boolean
}

const LIFECYCLE_LABEL: Record<ShipmentLedgerRow['lifecycle'], string> = {
  created: 'Oluşturuldu',
  label_ready: 'Etiketi hazır',
  in_transit: 'Kargoda',
  delivered: 'Teslim edildi',
  attention: 'Kontrol gerekli',
}

function istanbulDayBound(value: string | undefined, end: boolean): string | null {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 3 * 3_600_000
  return new Date(end ? startMs + 86_400_000 - 1 : startMs).toISOString()
}

export async function listShipmentLedger(
  db: Db,
  params: { organizationId: string; filters?: ShipmentLedgerFilters },
): Promise<{ rows: ShipmentLedgerRow[]; total: number; counts: Record<ShipmentTab, number>; page: number; pageSize: number }> {
  const organizationId = requireOrg(params.organizationId)
  const filters = params.filters ?? {}
  const pageSize = Math.min(Math.max(Number(filters.pageSize ?? 25) || 25, 1), 100)
  const page = Math.max(Number(filters.page ?? 1) || 1, 1)
  const attentionStatuses = sql.join(ATTENTION_OPERATION_STATUSES.map((s) => sql`${s}`), sql`, `)
  const printed = sql.join(PRINTED_STATUSES.map((s) => sql`${s}`), sql`, `)

  // Sekme dışı filtreler (sayaçlar da bunlarla daraltılır).
  const conditions = [sql`s.organization_id = ${organizationId}`]
  if (filters.provider) conditions.push(sql`s.provider = ${String(filters.provider).toLowerCase()}`)
  if (filters.marketplace) conditions.push(sql`lower(s.marketplace) = ${String(filters.marketplace).toLowerCase()}`)
  const search = String(filters.search ?? '').trim()
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    conditions.push(sql`(s.tracking_number ILIKE ${like} OR s.package_id ILIKE ${like}
      OR COALESCE(o.order_number, s.order_number) ILIKE ${like})`)
  }
  const from = istanbulDayBound(filters.from, false)
  const to = istanbulDayBound(filters.to, true)
  if (from) conditions.push(sql`s.created_at >= ${from}`)
  if (to) conditions.push(sql`s.created_at <= ${to}`)

  const base = sql`
    SELECT s.id AS shipment_id, s.package_id, s.marketplace, s.provider, s.tracking_number, s.created_at,
           s.payer_type, COALESCE(o.order_number, s.order_number) AS order_number,
           o.id AS order_id, o.operation_status, o.marketplace_status, o.last_operational_activity_at,
           ca.display_name AS carrier_account_name,
           CASE
             WHEN o.operation_status IN (${attentionStatuses}) THEN 'attention'
             WHEN EXISTS (SELECT 1 FROM shipment_operations so
                           WHERE so.organization_id = s.organization_id AND so.package_id = s.package_id
                             AND so.status = 'pending' AND so.carrier_create_called = true) THEN 'attention'
             WHEN o.operation_status IN ('DELIVERED', 'DELIVERED_SPECIAL') OR o.marketplace_status = 'Delivered' THEN 'delivered'
             WHEN o.operation_status IN ('HANDED_TO_CARGO', 'RETURNING')
               OR o.marketplace_status IN ('Shipped', 'AtCollectionPoint') THEN 'in_transit'
             WHEN o.operation_status IN ('LABEL_READY', 'LABEL_PRINTED') THEN 'label_ready'
             ELSE 'created'
           END AS lifecycle,
           CASE
             WHEN o.operation_status IN (${printed}) THEN 'printed'
             WHEN o.operation_status = 'LABEL_READY' THEN 'ready'
             ELSE 'none'
           END AS label_state
    FROM shipments s
    LEFT JOIN LATERAL (
      SELECT id, order_number, operation_status, marketplace_status, last_operational_activity_at
      FROM orders o
      WHERE o.organization_id = s.organization_id AND o.marketplace = s.marketplace AND o.package_id = s.package_id
      ORDER BY (o.marketplace_account_id IS NOT DISTINCT FROM s.marketplace_account_id) DESC, o.updated_at DESC
      LIMIT 1
    ) o ON true
    LEFT JOIN carrier_accounts ca ON ca.id = s.carrier_account_id AND ca.organization_id = s.organization_id
    WHERE ${sql.join(conditions, sql` AND `)}`

  const countRows = rowsOf(await db.execute(sql`SELECT lifecycle, count(*)::int AS n FROM (${base}) l GROUP BY lifecycle`))
  const counts: Record<ShipmentTab, number> = { all: 0, label_ready: 0, in_transit: 0, delivered: 0, attention: 0 }
  for (const row of countRows) {
    const n = Number(row.n ?? 0)
    counts.all += n
    const key = String(row.lifecycle) as ShipmentTab
    if (key in counts && key !== 'all') counts[key] += n
  }

  const outer = [sql`TRUE`]
  if (filters.tab && filters.tab !== 'all') outer.push(sql`l.lifecycle = ${filters.tab}`)
  if (filters.labelState) outer.push(sql`l.label_state = ${filters.labelState}`)
  const where = sql.join(outer, sql` AND `)
  const total = Number(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM (${base}) l WHERE ${where}`))[0]?.n ?? 0)
  const rows = rowsOf(await db.execute(sql`SELECT * FROM (${base}) l WHERE ${where}
    ORDER BY l.created_at DESC NULLS LAST LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`))

  return {
    rows: rows.map((row) => {
      const lifecycle = String(row.lifecycle) as ShipmentLedgerRow['lifecycle']
      const labelState = String(row.label_state) as ShipmentLedgerRow['labelState']
      return {
        shipmentId: String(row.shipment_id),
        orderId: row.order_id ? String(row.order_id) : null,
        orderNumber: String(row.order_number ?? row.package_id ?? ''),
        packageId: String(row.package_id ?? ''),
        marketplace: String(row.marketplace ?? ''),
        carrier: carrierLabel(row.provider),
        trackingNumber: row.tracking_number ? String(row.tracking_number) : null,
        lifecycle,
        // Basılmış ama henüz kargoya verilmemiş etiket "hazır" değil "basıldı" yazar.
        lifecycleLabel:
          lifecycle === 'label_ready' && labelState === 'printed'
            ? 'Etiket basıldı'
            : (LIFECYCLE_LABEL[lifecycle] ?? lifecycle),
        labelState,
        payer: PAYER_LABEL[String(row.payer_type ?? '')] ?? '—',
        carrierAccount: row.carrier_account_name ? String(row.carrier_account_name) : null,
        createdAt: iso(row.created_at),
        lastActivityAt: iso(row.last_operational_activity_at),
        canReprint: labelState !== 'none' && lifecycle !== 'attention' && Boolean(row.order_id),
      }
    }),
    total,
    counts,
    page,
    pageSize,
  }
}
