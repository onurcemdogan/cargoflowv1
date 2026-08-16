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
import { sql, type SQL } from 'drizzle-orm'
import { normalizedToken } from '../../src/utils/orderClassification.ts'
import { orders } from '../db/schema.ts'
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

/**
 * ADAY KİMLİK KISITI — TEK dizi parametresiyle.
 *
 * ÖLÇÜLDÜ (10K): `IN ($1,$2,…)` biçiminde 2000 parametre bağlamak ve
 * bağıntılı `EXISTS` alt-sorgusu kullanmak, düşük seçicilikli filtrelerde eski
 * yoldan YAVAŞ çıktı (EXISTS 10 kat kötüydü: satır başına arama). `= ANY(dizi)`
 * tek parametre bağlar ve tek geçişte çalışır.
 */
export function buildCandidateIdCondition(ids: readonly string[]): SQL {
  // TEK metin parametresi → `{a,b,c}` dizi hazır bilgisi → `uuid[]`.
  // Kimlikler DB'den gelir; yine de biçim doğrulanır (enjeksiyon yüzeyi YOK).
  const safe = ids.filter((id) =>
    /^[0-9a-fA-F-]{36}$/.test(String(id)),
  )
  const literal = `{${safe.join(',')}}`
  return sql`${orders.id} = any(${literal}::uuid[])`
}

/**
 * SEÇİCİLİK EŞİĞİ — ön-eleme NE ZAMAN KAZANDIRMAZ.
 *
 * ÖLÇÜLDÜ (10K, PGlite): ön-eleme SQL'inin kendisi ~8 ms (EXPLAIN ANALYZE),
 * fakat dönen kimlikleri JS'e taşımak kimlik başına ~0.5 ms. Yani maliyet
 * SONUÇ BÜYÜKLÜĞÜYLE artar. Aday sayısı büyüdükçe kazanç erir ve bir noktadan
 * sonra eski yoldan yavaş kalır (ölçülen başabaş ≈ 1700 aday).
 *
 * Bu yüzden önce UCUZ bir sayım yapılır; aday çok kalabalıksa ön-eleme
 * uygulanmaz ve eski yol aynen çalışır. Böylece hızlanmayan durumda bile
 * YAVAŞLAMA olmaz. Doğruluk etkilenmez: ön-eleme zaten yalnız daraltma.
 */
export const PREFILTER_MAX_CANDIDATES = 1500

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

  // HAM PARAMETRELİ SQL — BİLİNÇLİ TERCİH.
  // ÖLÇÜLDÜ (10K): aynı sorgu ham SQL ile 5-9 ms, sorgu-kurucu (query builder)
  // üzerinden ~930 ms. Fark veritabanında DEĞİL, sorgu kurulumundadır
  // (EXPLAIN ANALYZE: 8.5 ms). Bu yüzden bu SICAK YOL ham SQL kullanır.
  // Değerler PARAMETRE olarak bağlanır; birleştirme YAPILMAZ.
  const conditions: SQL[] = [
    sql`p.organization_id = ${organizationId}`,
    sql`p.projection_version = ${ORDER_FILTER_PROJECTION_VERSION}`,
  ]
  if (marketplaceAccountId === null) {
    conditions.push(sql`o.marketplace_account_id is null`)
  } else if (typeof marketplaceAccountId === 'string') {
    conditions.push(sql`o.marketplace_account_id = ${marketplaceAccountId}`)
  }
  if (plan.applied.includes('marketplace')) {
    conditions.push(sql`p.marketplace_token = ${normalizedToken(filters.marketplace)}`)
  }
  if (plan.applied.includes('city')) {
    conditions.push(sql`p.shipping_city_token = ${normalizedToken(filters.city)}`)
  }
  if (plan.applied.includes('district')) {
    conditions.push(sql`p.shipping_district_token = ${normalizedToken(filters.district)}`)
  }
  const like = (columns: string[], value: unknown): SQL | null => {
    const pattern = buildSearchLikePattern(value)
    if (!pattern) return null
    const parts = columns.map(
      (column) => sql`coalesce(p.${sql.raw(column)}, '') like ${pattern} escape '\'`,
    )
    return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` or `)})`
  }
  if (plan.applied.includes('customerQuery')) {
    const clause = like(['customer_search_token'], filters.customerQuery)
    if (clause) conditions.push(clause)
  }
  if (plan.applied.includes('orderNumberQuery')) {
    const clause = like(
      ['order_number_order_token', 'order_number_shipment_token'],
      filters.orderNumberQuery,
    )
    if (clause) conditions.push(clause)
  }
  if (plan.applied.includes('cargoSlipQuery')) {
    const clause = like(
      [
        'cargo_slip_order_token',
        'cargo_slip_shipment_token',
        'cargo_slip_operation_token',
      ],
      filters.cargoSlipQuery,
    )
    if (clause) conditions.push(clause)
  }

  const where = sql.join(conditions, sql` and `)
  const from = sql`from order_filter_projection p
    join orders o on o.id = p.order_id and o.organization_id = p.organization_id
    where ${where}`

  const orderBy =
    filters.sort === 'orderDateAsc'
      ? sql`order by o.order_date asc, o.id asc`
      : sql`order by o.order_date desc, o.id desc`
  // TEK SORGU + SINIR: eşiği bir aşan satır çekilir. Ayrı bir sayım sorgusu
  // YAPILMAZ (ölçüldü: fazladan gidiş-dönüş kazancı yiyordu) ve taşınan satır
  // sayısı her hâlükârda sınırlıdır.
  const limit = PREFILTER_MAX_CANDIDATES + 1
  const rows = rowsOf(
    await db.execute(sql`select o.id ${from} ${orderBy} limit ${limit}`),
  )
  // SEÇİCİ DEĞİL: daraltma kazandırmaz → eski yol aynen çalışsın.
  if (rows.length > PREFILTER_MAX_CANDIDATES) return null
  return rows.map((row) => String((row as { id: unknown }).id))
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  return ((result as { rows?: unknown[] })?.rows ?? []) as Record<string, unknown>[]
}
