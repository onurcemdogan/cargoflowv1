// PROJEKSİYON ÖN-ELEMESİ — SQL'de DARALT, KANONİK JS'te KARAR VER.
//
// TASARIM SÖZLEŞMESİ: bu modül kanonik filtreyi YENİDEN YAZMAZ. Yalnız
// `order_filter_projection` üzerinden bir ADAY KÜMESİ üretir; nihai kararı her
// zaman `buildVisibleOrders` verir. Böylece sonuç kümesi tanım gereği eskisiyle
// AYNI kalır ve tek riskimiz yanlış NEGATİF olur.
//
// SAĞLAMLIK KURALI (soundness): bir yüklem ancak kanonik karşılığıyla BİREBİR
// aynı token üzerinde çalışıyorsa ön-elemeye alınır. Emin olunmayan hiçbir
// filtre buraya girmez — girmemesi yalnız "daha az hızlanma" demektir, yanlış
// sonuç değil.
//
// AYIRICI GÜVENLİĞİ: arama blob'ları U+0301 ile birleştirilir. `normalizedSearch`
// tüm birleştirici işaretleri sildiği için ne alan değeri ne kullanıcı sorgusu
// bu karakteri içerebilir; dolayısıyla blob üzerinde LIKE, alanları tek tek
// aramakla BİREBİR aynıdır (eşleşme alan sınırını AŞAMAZ).
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
import { normalizedToken } from '../../src/utils/orderClassification.ts'
import { orderFilterProjection, orders } from '../db/schema.ts'
import {
  buildSearchLikePattern,
  ORDER_FILTER_PROJECTION_VERSION,
} from './orderFilterProjectionBuilder.ts'
import type { OrderListFilters } from './orderFilterProjection.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Ön-elemeye alınabilen filtreler (kanonik karşılığı KANITLI olanlar). */
export const PREFILTERABLE_FILTERS = [
  'marketplace',
  'city',
  'district',
  'customerQuery',
  'orderNumberQuery',
  'cargoSlipQuery',
] as const

export type PrefilterableFilter = (typeof PREFILTERABLE_FILTERS)[number]

/**
 * ÖN-ELEMEYE ALINMAYANLAR ve NEDENLERİ — bilinçli kararlar, eksiklik değil.
 *
 *   tab/operationTab/cargo/action → sınıflandırıcı gönderi+operasyon durumunu
 *     birlikte değerlendirir; projeksiyonda karşılığı YOK.
 *   status → kanonik dört alanı (status/marketplaceStatus/operationStatus/
 *     labelStatus) birlikte tarar; tek kolonla eşdeğer DEĞİL.
 *   search/productQuery/multiProduct/sameProduct → sipariş satırları gerekir.
 *   datePreset → aralık takvim/zaman dilimi mantığıyla üretilir; SQL aralığı
 *     eşdeğerliği ayrıca kanıtlanana kadar kanonikte kalır.
 */
export const DEFERRED_FILTERS = [
  'tab', 'operationTab', 'status', 'cargo', 'action',
  'search', 'productQuery', 'multiProduct', 'sameProduct', 'datePreset',
] as const

/** `all`/boş → filtre YOK (kanonik `isAllFilter` ile aynı semantik). */
function isActive(value: unknown): boolean {
  const token = normalizedToken(value)
  return token !== '' && token !== 'all' && token !== 'tumu' && token !== 'tumtarihler'
}

export interface PrefilterPlan {
  usable: boolean
  applied: PrefilterableFilter[]
  deferred: string[]
}

/** Hangi filtrelerin SQL'de daraltılabildiğini belirler. */
export function planProjectionPrefilter(
  filters: OrderListFilters = {},
): PrefilterPlan {
  const applied = PREFILTERABLE_FILTERS.filter((key) =>
    isActive((filters as Record<string, unknown>)[key]),
  )
  const deferred = DEFERRED_FILTERS.filter((key) =>
    isActive((filters as Record<string, unknown>)[key]),
  )
  return { usable: applied.length > 0, applied: [...applied], deferred: [...deferred] }
}

function accountClause(marketplaceAccountId: string | null | undefined) {
  if (marketplaceAccountId === undefined) return null
  return marketplaceAccountId === null
    ? isNull(orders.marketplaceAccountId)
    : eq(orders.marketplaceAccountId, marketplaceAccountId)
}

/** Blob kolonlarında LIKE — kaçırma `buildSearchLikePattern` ile yapılır. */
function likeAny(columns: unknown[], pattern: string): SQL | undefined {
  const clauses = columns.map(
    (column) => sql`coalesce(${column}, '') like ${pattern} escape '\\'`,
  )
  return clauses.length === 1 ? clauses[0] : or(...clauses)
}

/**
 * ADAY KİMLİKLERİ — projeksiyon üzerinden SQL ile daraltılmış küme.
 *
 * `null` döner: ön-eleme uygulanamıyor (çağıran ESKİ yolu kullanmalı).
 * Sıralama kanonik aday sırasıyla AYNIDIR (orderDate, sonra id).
 */
export async function selectPrefilteredOrderIds(
  db: Db,
  organizationId: string,
  filters: OrderListFilters = {},
  marketplaceAccountId?: string | null,
): Promise<string[] | null> {
  const plan = planProjectionPrefilter(filters)
  if (!plan.usable) return null

  const clauses: unknown[] = [
    eq(orderFilterProjection.organizationId, organizationId),
    // Yalnız GÜNCEL sürümlü satırlar: eski sürüm yanlış negatif üretebilir.
    eq(orderFilterProjection.projectionVersion, ORDER_FILTER_PROJECTION_VERSION),
  ]
  const scope = accountClause(marketplaceAccountId)
  if (scope) clauses.push(scope)

  if (plan.applied.includes('marketplace')) {
    clauses.push(
      eq(orderFilterProjection.marketplaceToken, normalizedToken(filters.marketplace)),
    )
  }
  if (plan.applied.includes('city')) {
    clauses.push(
      eq(orderFilterProjection.shippingCityToken, normalizedToken(filters.city)),
    )
  }
  if (plan.applied.includes('district')) {
    clauses.push(
      eq(
        orderFilterProjection.shippingDistrictToken,
        normalizedToken(filters.district),
      ),
    )
  }
  if (plan.applied.includes('customerQuery')) {
    const pattern = buildSearchLikePattern(filters.customerQuery)
    if (pattern) {
      clauses.push(likeAny([orderFilterProjection.customerSearchToken], pattern))
    }
  }
  if (plan.applied.includes('orderNumberQuery')) {
    const pattern = buildSearchLikePattern(filters.orderNumberQuery)
    if (pattern) {
      clauses.push(
        likeAny(
          [
            orderFilterProjection.orderNumberOrderToken,
            orderFilterProjection.orderNumberShipmentToken,
          ],
          pattern,
        ),
      )
    }
  }
  if (plan.applied.includes('cargoSlipQuery')) {
    const pattern = buildSearchLikePattern(filters.cargoSlipQuery)
    if (pattern) {
      clauses.push(
        likeAny(
          [
            orderFilterProjection.cargoSlipOrderToken,
            orderFilterProjection.cargoSlipShipmentToken,
            orderFilterProjection.cargoSlipOperationToken,
          ],
          pattern,
        ),
      )
    }
  }

  const orderBy =
    filters.sort === 'orderDateAsc'
      ? [asc(orders.orderDate), asc(orders.id)]
      : [desc(orders.orderDate), desc(orders.id)]

  const rows = (await db
    .select({ id: orders.id })
    .from(orderFilterProjection)
    .innerJoin(
      orders,
      and(
        eq(orders.id, orderFilterProjection.orderId),
        eq(orders.organizationId, orderFilterProjection.organizationId),
      ),
    )
    .where(and(...(clauses as SQL[])))
    .orderBy(...orderBy)) as { id: string }[]

  return rows.map((row) => String(row.id))
}
