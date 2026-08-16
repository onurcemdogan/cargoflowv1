// GÖLGE MOTOR + KANARYA OKUMA MODLARI.
//
// GÖLGE: aynı istek hem ESKİ yolla hem PROJEKSİYON ön-elemesiyle çalıştırılır;
// kullanıcıya DÖNEN her zaman ESKİ sonuçtur. Projeksiyon yalnız karşılaştırma
// için koşar. Böylece parite kanıtlanmadan hiçbir kullanıcı etkilenmez.
//
// MOD SÖZLEŞMESİ (fail-safe):
//   LEGACY      → yalnız eski yol (VARSAYILAN)
//   SHADOW      → ikisi de koşar, ESKİ sonuç döner, fark kaydedilir
//   PROJECTION  → ön-elemeli yol döner (yalnız AÇIKÇA seçilmiş + HAZIR tenant)
// Bilinmeyen mod, hazır olmayan tenant ve hata → LEGACY.
//
// TELEMETRİ: organizasyon maskeli, sorgu parmak izi karma; sipariş kimlikleri
// karmalanır. PII, ham yük veya kimlik bilgisi ASLA yazılmaz.
import { createHash } from 'node:crypto'
import {
  listFilteredOrdersPage,
  loadFilteredProjection,
  type OrderListFilters,
} from './orderFilterProjection.ts'
import { resolvePageSize } from './orderRepository.ts'
import {
  buildCandidateIdCondition,
  planProjectionPrefilter,
  selectPrefilteredOrderIds,
} from './orderProjectionQuery.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const PROJECTION_READ_MODES = ['legacy', 'shadow', 'projection'] as const
export type ProjectionReadMode = (typeof PROJECTION_READ_MODES)[number]

/** Bilinmeyen/boş değer → LEGACY. Asla "belki projeksiyon" olmaz. */
export function resolveProjectionReadMode(value: unknown): ProjectionReadMode {
  const token = String(value ?? '').trim().toLowerCase()
  return (PROJECTION_READ_MODES as readonly string[]).includes(token)
    ? (token as ProjectionReadMode)
    : 'legacy'
}

/**
 * ETKİN MOD — hazır olmayan tenant PROJECTION'a GEÇEMEZ.
 * Anında geri alma: `mode` LEGACY'ye çevrildiği an kod dağıtımı gerekmeden
 * eski yola dönülür (projeksiyon verisi silinmez, migration geri alınmaz).
 */
export function resolveEffectiveReadMode(
  requested: unknown,
  readiness: { ready?: boolean } | null | undefined,
): ProjectionReadMode {
  const mode = resolveProjectionReadMode(requested)
  if (mode === 'projection' && !readiness?.ready) return 'legacy'
  return mode
}

const hash = (value: unknown): string =>
  createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12)

const maskOrganization = (value: unknown): string => {
  const text = String(value ?? '')
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`
}

/** Sorgu parmak izi — filtre DEĞERLERİ değil, yalnız karma. */
export function queryFingerprint(filters: OrderListFilters): string {
  const normalized = Object.entries(filters as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== '' && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort()
    .join('&')
  return hash(normalized)
}

export interface ShadowComparison {
  organizationMasked: string
  queryFingerprint: string
  legacyCount: number
  projectionCount: number
  legacyDurationMs: number
  projectionDurationMs: number
  /** Eskide olup projeksiyonda OLMAYAN (yanlış negatif) — KARMALI. */
  missingHashed: string[]
  /** Projeksiyonda olup eskide OLMAYAN — KARMALI. */
  extraHashed: string[]
  orderMismatch: boolean
  parity: boolean
  prefilterApplied: string[]
  prefilterDeferred: string[]
  projectionVersion: number
}

const now = (): number => Number(process.hrtime.bigint() / 1000n) / 1000
const round = (value: number): number => Math.round(value * 100) / 100

/**
 * GÖLGE KARŞILAŞTIRMASI — kullanıcıya ESKİ sonuç döner.
 *
 * `null` döner: ön-eleme uygulanamıyor (karşılaştıracak bir şey yok).
 */
export async function compareProjectionShadow(
  db: Db,
  organizationId: string,
  filters: OrderListFilters = {},
  marketplaceAccountId?: string | null,
  externalProcessing?: { entries?: Record<string, unknown> } | null,
): Promise<ShadowComparison | null> {
  const plan = planProjectionPrefilter(filters)
  if (!plan.usable) return null

  const legacyStart = now()
  const legacy = await loadFilteredProjection(
    db, organizationId, filters, marketplaceAccountId, externalProcessing,
  )
  const legacyDurationMs = round(now() - legacyStart)

  const projectionStart = now()
  const candidateIds = await selectPrefilteredOrderIds(
    db, organizationId, filters, marketplaceAccountId,
  )
  const prefilter = candidateIds ? buildCandidateIdCondition(candidateIds) : null
  const projection = await loadFilteredProjection(
    db, organizationId, filters, marketplaceAccountId, externalProcessing,
    prefilter,
  )
  const projectionDurationMs = round(now() - projectionStart)

  const legacyIds = legacy.orderIds
  const projectionIds = projection.orderIds
  const projectionSet = new Set(projectionIds)
  const legacySet = new Set(legacyIds)
  const missing = legacyIds.filter((id) => !projectionSet.has(id))
  const extra = projectionIds.filter((id) => !legacySet.has(id))
  const orderMismatch =
    missing.length === 0 &&
    extra.length === 0 &&
    legacyIds.some((id, index) => projectionIds[index] !== id)

  return {
    organizationMasked: maskOrganization(organizationId),
    queryFingerprint: queryFingerprint(filters),
    legacyCount: legacyIds.length,
    projectionCount: projectionIds.length,
    legacyDurationMs,
    projectionDurationMs,
    missingHashed: missing.slice(0, 20).map(hash),
    extraHashed: extra.slice(0, 20).map(hash),
    orderMismatch,
    parity: missing.length === 0 && extra.length === 0 && !orderMismatch,
    prefilterApplied: plan.applied,
    prefilterDeferred: plan.deferred,
    projectionVersion: 1,
  }
}

/**
 * MOD FARKINDA SAYFA LİSTESİ.
 *
 * LEGACY/SHADOW → kullanıcıya ESKİ sonuç. PROJECTION → ön-elemeli sonuç.
 * Ön-elemeli yol TEKNİK olarak hata verirse ESKİ yola düşülür; fakat bu
 * SESSİZ değildir (`fallbackReason` döner) — yanlış SONUÇ asla gizlenmez,
 * yalnız teknik hata telafi edilir.
 */
export async function listOrdersWithReadMode(
  db: Db,
  organizationId: string,
  filters: OrderListFilters = {},
  marketplaceAccountId?: string | null,
  externalProcessing?: { entries?: Record<string, unknown> } | null,
  mode: ProjectionReadMode = 'legacy',
): Promise<{
  orders: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
  mode: ProjectionReadMode
  servedBy: 'legacy' | 'projection'
  fallbackReason?: string
  shadow?: ShadowComparison | null
}> {
  const pageSize = resolvePageSize(filters.pageSize)
  const page = Math.max(1, Math.trunc(Number(filters.page ?? 1)) || 1)

  if (mode === 'projection') {
    try {
      const candidateIds = await selectPrefilteredOrderIds(
        db, organizationId, filters, marketplaceAccountId,
      )
      const prefilter = candidateIds ? buildCandidateIdCondition(candidateIds) : null
      if (prefilter !== null) {
        const result = await loadFilteredProjection(
          db, organizationId, filters, marketplaceAccountId, externalProcessing,
          prefilter,
        )
        return {
          orders: result.visibleOrders.slice((page - 1) * pageSize, page * pageSize),
          total: result.total,
          page,
          pageSize,
          mode,
          servedBy: 'projection',
        }
      }
      // Desteklenmeyen filtre → HİBRİT: eski motor devralır (zorlama YOK).
      const legacy = await listFilteredOrdersPage(
        db, organizationId, filters, marketplaceAccountId, externalProcessing,
      )
      return { ...legacy, mode, servedBy: 'legacy', fallbackReason: 'UNSUPPORTED_FILTER' }
    } catch (error) {
      const legacy = await listFilteredOrdersPage(
        db, organizationId, filters, marketplaceAccountId, externalProcessing,
      )
      return {
        ...legacy,
        mode,
        servedBy: 'legacy',
        fallbackReason: `PROJECTION_ERROR:${
          error instanceof Error ? error.name : 'UNKNOWN'
        }`,
      }
    }
  }

  const legacy = await listFilteredOrdersPage(
    db, organizationId, filters, marketplaceAccountId, externalProcessing,
  )
  if (mode !== 'shadow') {
    return { ...legacy, mode, servedBy: 'legacy' }
  }
  // GÖLGE: karşılaştırma kullanıcıyı ETKİLEMEZ; hata da etkilememeli.
  let shadow: ShadowComparison | null = null
  try {
    shadow = await compareProjectionShadow(
      db, organizationId, filters, marketplaceAccountId, externalProcessing,
    )
  } catch {
    shadow = null
  }
  return { ...legacy, mode, servedBy: 'legacy', shadow }
}
