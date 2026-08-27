// DASHBOARD TOPLAMALARI — POSTGRES İÇİNDE.
//
// ═══ KÖK NEDEN (ölçüldü, tahmin edilmedi) ════════════════════════════════
// Dashboard satış kartları, aralıktaki TÜM siparişleri Node'a çekip orada
// topluyordu. Ölçüm (PGlite, 2000 sipariş):
//
//   orders SELECT            35 ms
//   order_lines SELECT       31 ms
//   tam yol (map dâhil)      77 ms
//   istemciye giden yük    1933 KB
//
// Yani maliyetin neredeyse tamamı SATIR AKTARIMIDIR; eşleme ucuzdur. 25.000
// siparişte bu ~24 MB'lık bir yüke çıkar. Doğru düzeltme sorguyu
// hızlandırmak değil, SATIRLARI HİÇ TAŞIMAMAKTIR.
//
// ═══ ANLAM KORUNUR ═══════════════════════════════════════════════════════
// Toplama kuralları `dashboardSalesMetricDefinition` ile BİREBİR aynıdır:
//
//   PAKET   = DISTINCT package_id           (bölünmüş sevkiyat iki pakettir)
//   KALEM   = order_lines SATIR sayısı      (adet toplamı DEĞİL)
//   ADET    = order_lines.quantity toplamı
//   TUTAR   = total_amount (NULL → 0, mevcut davranış) → negatifse
//             Σ unit_price × quantity → satır da yoksa ÇÖZÜLEMEDİ
//   GÜN     = order_date'in UTC günü
//   EKSEN   = order_date (aktivite tarihi DEĞİL)
//
// Dispozisyon SQL'de YENİDEN HESAPLANMAZ: `orders.sales_disposition`
// kolonundan okunur ve o kolon yazım anında istemciyle AYNI saf fonksiyonla
// doldurulur. Tek uygulama → sessiz ayrışma yok.
//
// ═══ ÇİFT SAYIM YOK ══════════════════════════════════════════════════════
// Aynı siparişin iki paketi İKİ satış birimidir (dedupe anahtarı packageId).
// Kalem/adet toplamları ürün satırlarından AYRI bir alt sorguda hesaplanır;
// aksi hâlde orders×order_lines join'i tutarı satır sayısı kadar ÇOĞALTIRDI.

import { sql } from 'drizzle-orm'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type SalesDisposition = 'sale' | 'return' | 'cancel'

export interface DashboardAggregateBucket {
  /** UTC gün (YYYY-MM-DD). */
  readonly day: string
  readonly marketplace: string
  readonly disposition: SalesDisposition
  /** DISTINCT package_id — satış/operasyon birimi. */
  readonly packageCount: number
  /** order_lines satır sayısı. */
  readonly lineCount: number
  /** order_lines.quantity toplamı. */
  readonly unitCount: number
  /** Tutarı ÇÖZÜLEBİLEN paketlerin toplamı. */
  readonly amount: number
  /** Tutarı hiç çözülemeyen paket sayısı — "0 TL" ile karıştırılmaz. */
  readonly amountMissingCount: number
}

export interface DashboardAggregate {
  readonly buckets: readonly DashboardAggregateBucket[]
  /** Aralıktaki toplam paket sayısı (dispozisyon farkı gözetmeden). */
  readonly packageCount: number
}

export interface DashboardRange {
  readonly startMs: number
  readonly endMs: number
}

function toDisposition(value: unknown): SalesDisposition {
  const text = String(value ?? '')
  if (text === 'return' || text === 'cancel') return text
  // Kolon boşsa (0011 öncesi satır, backfill bekliyor) satış sayılır —
  // eski davranışla aynı varsayılan.
  return 'sale'
}

/**
 * Aralığın gün × pazaryeri × dispozisyon kovalarını POSTGRES'te üretir.
 *
 * Node'a dönen satır sayısı sipariş sayısından BAĞIMSIZDIR: en fazla
 * gün × pazaryeri × 3 kadardır.
 */
export async function loadDashboardAggregate(
  db: Db,
  organizationId: string,
  range: DashboardRange,
  marketplaceAccountId?: string | null,
): Promise<DashboardAggregate> {
  const start = new Date(range.startMs)
  const end = new Date(range.endMs)
  // Hesap kapsamı: verilmezse TÜM hesaplar (legacy davranış); verilirse
  // yalnız o hesap. `IS NOT DISTINCT FROM` NULL kapsamını da doğru eşler.
  const accountClause =
    marketplaceAccountId === undefined
      ? sql`true`
      : sql`o.marketplace_account_id IS NOT DISTINCT FROM ${marketplaceAccountId}`

  const rows = await db.execute(sql`
    WITH scoped AS (
      SELECT
        o.id,
        o.package_id,
        o.marketplace,
        COALESCE(o.sales_disposition, 'sale') AS disposition,
        to_char(o.order_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        o.total_amount
      FROM orders o
      WHERE o.organization_id = ${organizationId}
        AND ${accountClause}
        AND o.order_date >= ${start}
        AND o.order_date <= ${end}
    ),
    -- Ürün satırları AYRI toplanır: orders ile doğrudan join edilseydi
    -- total_amount satır sayısı kadar ÇOĞALIRDI.
    lines AS (
      SELECT
        l.order_id,
        COUNT(*)::int AS line_count,
        COALESCE(SUM(GREATEST(l.quantity, 0)), 0)::int AS unit_count,
        COALESCE(SUM(GREATEST(l.quantity, 0) * COALESCE(l.unit_price, 0)), 0) AS line_amount,
        COUNT(*) FILTER (WHERE l.unit_price IS NULL)::int AS priceless_lines
      FROM order_lines l
      WHERE l.organization_id = ${organizationId}
        AND l.order_id IN (SELECT id FROM scoped)
      GROUP BY l.order_id
    ),
    resolved AS (
      SELECT
        s.day,
        s.marketplace,
        s.disposition,
        s.package_id,
        COALESCE(ln.line_count, 0) AS line_count,
        COALESCE(ln.unit_count, 0) AS unit_count,
        -- ═══ TUTAR ÖNCELİĞİ — MEVCUT ANLAM AYNEN KORUNUR ═══════════
        --
        -- rowToOrder, NULL total_amount degerini Number(null) = 0 ile
        -- SIFIRA cevirir; yani bugunku dashboard "tutari yok" siparisi
        -- 0 TL sayar ve toplami GUVENILIR isaretler. Tartisilabilir bir
        -- davranistir ama BU TURUN ISI DEGILDIR: para anlamini
        -- degistirmemek icin SQL de aynisini yapar.
        --
        -- NEGATIF tutar (parsed >= 0) kontrolunden gecemez ve JS satir
        -- toplamina duser; satir da yoksa "cozulemedi" (NULL) olur.
        CASE
          WHEN COALESCE(s.total_amount, 0) >= 0 THEN COALESCE(s.total_amount, 0)
          WHEN ln.line_count > 0 THEN ln.line_amount
          ELSE NULL
        END AS amount
      FROM scoped s
      LEFT JOIN lines ln ON ln.order_id = s.id
    )
    SELECT
      day,
      marketplace,
      disposition,
      COUNT(DISTINCT package_id)::int AS package_count,
      COALESCE(SUM(line_count), 0)::int AS line_count,
      COALESCE(SUM(unit_count), 0)::int AS unit_count,
      COALESCE(SUM(amount), 0) AS amount,
      COUNT(*) FILTER (WHERE amount IS NULL)::int AS amount_missing_count
    FROM resolved
    GROUP BY day, marketplace, disposition
    ORDER BY day, marketplace, disposition
  `)

  const list = (Array.isArray(rows) ? rows : (rows?.rows ?? [])) as Record<
    string,
    unknown
  >[]
  const buckets = list.map((row) => ({
    day: String(row.day ?? ''),
    marketplace: String(row.marketplace ?? ''),
    disposition: toDisposition(row.disposition),
    packageCount: Number(row.package_count ?? 0),
    lineCount: Number(row.line_count ?? 0),
    unitCount: Number(row.unit_count ?? 0),
    amount: Number(row.amount ?? 0),
    amountMissingCount: Number(row.amount_missing_count ?? 0),
  }))
  return {
    buckets,
    packageCount: buckets.reduce((total, row) => total + row.packageCount, 0),
  }
}

export interface DashboardTotals {
  readonly salesAmount: number
  readonly salesAmountAvailable: boolean
  readonly orderCount: number
  readonly lineCount: number
  readonly productCount: number
  readonly returnAmount: number
  readonly returnAmountAvailable: boolean
  readonly returnCount: number
  readonly cancelAmount: number
  readonly cancelAmountAvailable: boolean
  readonly cancelCount: number
  readonly returnCancellationAmount: number
  readonly returnCancellationAmountAvailable: boolean
  readonly packageAverage: number
}

/**
 * Kovaları dashboard kart sözleşmesine indirger.
 *
 * `calculatePeriodTotals` ile ALAN ALAN aynı anlam: `orderCount` satış
 * PAKETİ sayısıdır, `lineCount` kalem sayısıdır, `productCount` adet
 * toplamıdır ve `packageAverage` = adet / paket.
 */
export function totalsFromBuckets(
  aggregate: DashboardAggregate,
): DashboardTotals {
  const pick = (disposition: SalesDisposition) =>
    aggregate.buckets.filter((bucket) => bucket.disposition === disposition)
  const sum = (
    rows: readonly DashboardAggregateBucket[],
    key: keyof DashboardAggregateBucket,
  ) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)

  const sales = pick('sale')
  const returns = pick('return')
  const cancels = pick('cancel')

  const salesCount = sum(sales, 'packageCount')
  const productCount = sum(sales, 'unitCount')
  // "Tutar yok" ile "tutar sıfır" ASLA aynı şey değildir.
  const available = (rows: readonly DashboardAggregateBucket[]) =>
    sum(rows, 'packageCount') === 0 || sum(rows, 'amountMissingCount') === 0
  const returnAvailable = available(returns)
  const cancelAvailable = available(cancels)

  return {
    salesAmount: sum(sales, 'amount'),
    salesAmountAvailable: available(sales),
    orderCount: salesCount,
    lineCount: sum(sales, 'lineCount'),
    productCount,
    returnAmount: sum(returns, 'amount'),
    returnAmountAvailable: returnAvailable,
    returnCount: sum(returns, 'packageCount'),
    cancelAmount: sum(cancels, 'amount'),
    cancelAmountAvailable: cancelAvailable,
    cancelCount: sum(cancels, 'packageCount'),
    returnCancellationAmount: sum(returns, 'amount') + sum(cancels, 'amount'),
    returnCancellationAmountAvailable: returnAvailable && cancelAvailable,
    packageAverage: salesCount > 0 ? productCount / salesCount : 0,
  }
}
