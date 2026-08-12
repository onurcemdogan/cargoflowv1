// YÜKSEK HACİM OKUMA ÖLÇÜMÜ — TAMAMEN SALT OKUNUR (üretim DB'sine DOKUNMAZ).
//
// Bu modül ÜRETİM kod yollarını (findOrders · listOrders · listOrdersForAnalytics)
// hermetik bir PGlite üzerinde çalıştırır ve gerçek süre/sorgu sayısı/payload
// boyutu üretir. Kendi şemasını migration dosyalarından kurar; DATABASE_URL'e
// BAĞLANMAZ, üretim verisi OKUMAZ/YAZMAZ.
//
// NEDEN HERMETİK: üretim DB'sine sentetik sipariş yazmak yasak. Ölçek etkisini
// (1k → 100k) görmenin tek güvenli yolu izole bir kopyada aynı sorguları
// çalıştırmaktır.
//
// GEÇERLİLİK SINIRI (rapora AYNEN taşınmalı): PGlite gerçek PostgreSQL'dir
// (aynı planlayıcı, aynı EXPLAIN) fakat WASM içinde ve ağ gecikmesi olmadan
// çalışır. MUTLAK ms değerleri üretimle birebir DEĞİLDİR; ÖLÇEKLENME EĞİLİMİ
// (O(n), O(n²), sorgu SAYISI, payload BOYUTU) taşınabilirdir. Ağ turu başına
// ek maliyet üretimde AYRICA vardır ve N+1'i daha da kötüleştirir.
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'

/** Ölçüm sırasında çalışan SQL sorgularını sayan sarmalayıcı. */
export interface QueryCounter {
  count: number
  reset(): void
}

/**
 * PGlite örneğini sayaçla sarar. drizzle tüm SQL'i `client.query` üzerinden
 * gönderir; bu yüzden N+1 sorgu sayısı BURADA kanıtlanabilir (tahmin değil).
 */
export function withQueryCounter<T extends object>(
  client: T,
): { client: T; counter: QueryCounter } {
  const counter: QueryCounter = {
    count: 0,
    reset() {
      counter.count = 0
    },
  }
  const proxy = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === 'query' && typeof value === 'function') {
        return (...args: unknown[]) => {
          counter.count += 1
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as T
  return { client: proxy, counter }
}

export interface SeedOptions {
  organizationId: string
  marketplaceAccountId: string
  count: number
  /** Kaç siparişin shipment kaydı var (0..1). Üretimde etiketi basılmış olanlar. */
  shipmentRatio?: number
  /** Shipment'ı olan paket başına shipment_operations satır sayısı. */
  operationsPerPackage?: number
  linesPerOrder?: number
  /** Siparişlerin yayıldığı gün sayısı (4.000/gün profili için count/4000). */
  spreadDays?: number
  batchSize?: number
}

type AnyDb = {
  execute: (query: unknown) => Promise<unknown>
}

const MARKETPLACE = 'Trendyol'
// KANONİK DB anahtarı (görünen ad değil): attachShipment bu değerle arar.
// Yanlış değer verilirse shipment BULUNAMAZ ve ölçüm N+1'i EKSİK gösterir.
const PROVIDER = 'surat'
const STATUSES = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'AtCollectionPoint',
  'Delivered',
  'Cancelled',
  'Returned',
]

/**
 * Üretim benzeri sipariş kütlesi üretir. Şifreli kolonlar GERÇEK şifreleme
 * yardımcılarıyla doldurulur ki okuma yolundaki decrypt maliyeti ölçüme dahil
 * olsun (aksi hâlde ölçüm iyimser çıkar).
 */
export async function seedOrders(
  db: AnyDb,
  options: SeedOptions,
): Promise<{ orderIds: string[]; packageIds: string[] }> {
  const {
    organizationId,
    marketplaceAccountId,
    count,
    shipmentRatio = 0.45,
    operationsPerPackage = 2,
    linesPerOrder = 2,
    spreadDays = Math.max(1, Math.ceil(count / 4000)),
    batchSize = 1000,
  } = options
  const { encryptOrderPayload } = await import('../orders/orderEncryption.ts')
  const { encryptShipmentPayload } = await import(
    '../shipments/shipmentEncryption.ts'
  )

  // Şifreli gövdeler SABİT üretilir: amaç decrypt MALİYETİNİ ölçüme katmak,
  // rastgele içerik üretmek değil. (Date.now/Math.random kullanılmaz.)
  const addressCipher = encryptOrderPayload({
    fullAddress: 'Ornek Mah. Ornek Cad. No 1 Daire 2',
    city: 'Istanbul',
    district: 'Kadikoy',
    postalCode: '34000',
  })
  const rawCipher = encryptOrderPayload({
    shipmentAddress: { city: 'Istanbul', district: 'Kadikoy' },
    lines: Array.from({ length: linesPerOrder }, (_, index) => ({
      lineId: index,
      productName: 'Ornek Urun',
      quantity: 1,
    })),
    invoiceAddress: { city: 'Istanbul' },
  })
  const linePayloadCipher = encryptOrderPayload({ note: 'line' })
  // Taşıyıcı payload'u gerçekçi biçimde BÜYÜKTÜR (ZPL taşır) — decrypt maliyeti
  // sipariş payload'undan belirgin şekilde yüksektir.
  const carrierCipher = encryptShipmentPayload({
    labelStatus: 'READY',
    shipmentStatus: 'CREATED',
    technicalZpl: `^XA${'^FO50,50^A0N,30,30^FDCargoFlow^FS'.repeat(40)}^XZ`,
    ozelKargoTakipNo: '7270000000000',
  })

  const orderIds: string[] = []
  const packageIds: string[] = []
  const baseMs = Date.UTC(2026, 0, 1, 9, 0, 0)
  const dayMs = 86_400_000

  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset)
    const orderValues: string[] = []
    const lineValues: string[] = []
    const shipmentValues: string[] = []
    const operationValues: string[] = []

    for (let index = 0; index < size; index += 1) {
      const seq = offset + index
      const orderId = randomUUID()
      const packageId = `PKG${String(1_000_000_000 + seq)}`
      orderIds.push(orderId)
      packageIds.push(packageId)
      // Siparişler spreadDays boyunca eşit dağıtılır (4.000/gün profili).
      const dayIndex = Math.floor((seq * spreadDays) / Math.max(1, count))
      const orderDate = new Date(baseMs + dayIndex * dayMs + (seq % 3600) * 1000)
      const status = STATUSES[seq % STATUSES.length]
      const operationStatus =
        seq % 4 === 0 ? 'LABEL_PRINTED' : seq % 4 === 1 ? 'LABEL_READY' : 'NEW'
      orderValues.push(
        `('${orderId}','${organizationId}','${marketplaceAccountId}','${MARKETPLACE}',` +
          `'${packageId}','114${String(10_000_000 + seq)}','${packageId}',` +
          `'${status}','${operationStatus}','Ad${seq % 500}','Soyad${seq % 500}',` +
          `'${addressCipher}','Istanbul','Kadikoy','${rawCipher}',` +
          `${(100 + (seq % 900)).toFixed(2)},'TRY','${orderDate.toISOString()}')`,
      )
      for (let line = 0; line < linesPerOrder; line += 1) {
        lineValues.push(
          `('${randomUUID()}','${organizationId}','${orderId}','L${seq}-${line}',` +
            `'P${seq % 5000}','SKU${seq % 5000}','869${String(1_000_000 + (seq % 5000))}',` +
            `'Ornek Urun ${seq % 5000}',1,${(50 + (seq % 200)).toFixed(2)},` +
            `${(50 + (seq % 200)).toFixed(2)},'${linePayloadCipher}')`,
        )
      }
      // Gönderi taşıyan siparişler HER sayfaya dağılsın diye küçük periyot
      // kullanılır: yüzlük periyot + tarih sıralaması bazı sayfaları tamamen
      // gönderisiz bırakır ve N+1 maliyetini OLDUĞUNDAN AZ gösterirdi.
      if (seq % 20 < Math.round(shipmentRatio * 20)) {
        shipmentValues.push(
          `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
            `'114${String(10_000_000 + seq)}','${PROVIDER}','local_create','created',` +
            `'7270000${String(100000 + seq)}','SND${seq}','${carrierCipher}')`,
        )
        for (let op = 0; op < operationsPerPackage; op += 1) {
          operationValues.push(
            `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
              `'${PROVIDER}','create','idem-${seq}-${op}','succeeded','${carrierCipher}')`,
          )
        }
      }
    }

    await db.execute(
      sql.raw(
        `insert into orders (id, organization_id, marketplace_account_id, marketplace,
           package_id, order_number, external_order_id, marketplace_status,
           operation_status, customer_first_name, customer_last_name,
           shipping_address_encrypted, shipping_city, shipping_district,
           raw_payload_encrypted, total_amount, currency, order_date)
         values ${orderValues.join(',')}`,
      ),
    )
    if (lineValues.length) {
      await db.execute(
        sql.raw(
          `insert into order_lines (id, organization_id, order_id, external_line_id,
             product_id, merchant_sku, barcode, product_name, quantity, unit_price,
             line_total, raw_payload_encrypted)
           values ${lineValues.join(',')}`,
        ),
      )
    }
    if (shipmentValues.length) {
      await db.execute(
        sql.raw(
          `insert into shipments (id, organization_id, marketplace, package_id,
             order_number, provider, source, status, tracking_number, sender_number,
             carrier_payload_encrypted)
           values ${shipmentValues.join(',')}`,
        ),
      )
    }
    if (operationValues.length) {
      await db.execute(
        sql.raw(
          `insert into shipment_operations (id, organization_id, marketplace,
             package_id, provider, operation_type, idempotency_key, status,
             response_payload_encrypted)
           values ${operationValues.join(',')}`,
        ),
      )
    }
  }
  await db.execute(sql.raw('analyze'))
  return { orderIds, packageIds }
}

export interface Sample {
  totalMs: number
  dbMs: number
  serializeMs: number
  rowCount: number
  payloadBytes: number
  queryCount: number
}

export interface Stats {
  p50: number
  p95: number
  max: number
  mean: number
}

export function stats(values: number[]): Stats {
  if (!values.length) return { p50: 0, p95: 0, max: 0, mean: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}

/**
 * TEK sayfa ölçümü — GET /api/orders'ın gövdesiyle AYNI servis çağrısı.
 * `dbMs` servis çağrısının tamamı (sorgu + decrypt + view-model), `serializeMs`
 * yanıtın JSON'a çevrilmesi, `payloadBytes` telde giden boyut.
 */
export async function measureOrdersPage(
  db: unknown,
  counter: QueryCounter,
  organizationId: string,
  marketplaceAccountId: string | null,
  options: { page: number; pageSize: number },
): Promise<Sample> {
  const { listOrders } = await import('../orders/orderPersistenceService.ts')
  counter.reset()
  const start = now()
  const result = await listOrders(
    db as never,
    organizationId,
    { page: options.page, pageSize: options.pageSize, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const afterDb = now()
  const payload = JSON.stringify({
    ok: true,
    orders: result.orders,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  })
  const end = now()
  return {
    totalMs: round(end - start),
    dbMs: round(afterDb - start),
    serializeMs: round(end - afterDb),
    rowCount: result.orders.length,
    payloadBytes: Buffer.byteLength(payload, 'utf8'),
    queryCount: counter.count,
  }
}

/**
 * FRONTEND'İN GERÇEK DAVRANIŞI: `loadOrdersFromServer` TÜM sayfaları çeker.
 * Bu ölçüm "20-50 satır göstermek için kaç satır getiriliyor" sorusunu
 * doğrudan cevaplar.
 */
export async function measureFullClientLoad(
  db: unknown,
  counter: QueryCounter,
  organizationId: string,
  marketplaceAccountId: string | null,
  options: { pageSize: number; maxPages: number },
): Promise<Sample & { pageCount: number; capExceeded: boolean }> {
  const { listOrders } = await import('../orders/orderPersistenceService.ts')
  counter.reset()
  const start = now()
  let serializeMs = 0
  let payloadBytes = 0
  let rowCount = 0
  const first = await listOrders(
    db as never,
    organizationId,
    { page: 1, pageSize: options.pageSize, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const totalPages = Math.max(1, Math.ceil(first.total / options.pageSize))
  const capExceeded = totalPages > options.maxPages
  const pagesToFetch = Math.min(totalPages, options.maxPages)
  const accumulate = (orders: unknown[]) => {
    const serializeStart = now()
    payloadBytes += Buffer.byteLength(JSON.stringify(orders), 'utf8')
    serializeMs += now() - serializeStart
    rowCount += orders.length
  }
  accumulate(first.orders)
  for (let page = 2; page <= pagesToFetch; page += 1) {
    const result = await listOrders(
      db as never,
      organizationId,
      { page, pageSize: options.pageSize, sort: 'orderDateDesc' },
      marketplaceAccountId,
    )
    accumulate(result.orders)
  }
  const end = now()
  return {
    totalMs: round(end - start),
    dbMs: round(end - start - serializeMs),
    serializeMs: round(serializeMs),
    rowCount,
    payloadBytes,
    queryCount: counter.count,
    pageCount: pagesToFetch,
    capExceeded,
  }
}

/** Dashboard satış analitiği: cap'siz aralık okuması. */
export async function measureAnalyticsRange(
  db: unknown,
  counter: QueryCounter,
  organizationId: string,
  marketplaceAccountId: string | null,
  range: { startMs: number; endMs: number },
): Promise<Sample> {
  const { listOrdersForAnalytics } = await import(
    '../orders/orderPersistenceService.ts'
  )
  counter.reset()
  const start = now()
  const rows = await listOrdersForAnalytics(
    db as never,
    organizationId,
    range,
    marketplaceAccountId,
  )
  const afterDb = now()
  const payload = JSON.stringify({ ok: true, orders: rows })
  const end = now()
  return {
    totalMs: round(end - start),
    dbMs: round(afterDb - start),
    serializeMs: round(end - afterDb),
    rowCount: rows.length,
    payloadBytes: Buffer.byteLength(payload, 'utf8'),
    queryCount: counter.count,
  }
}

/** Yalnız COUNT(*) maliyeti — her sayfa isteğinde tekrar çalışır. */
export async function measureCountOnly(
  db: AnyDb,
  organizationId: string,
  marketplaceAccountId: string | null,
): Promise<number> {
  const start = now()
  await db.execute(
    sql.raw(
      `select count(*)::int from orders where organization_id = '${organizationId}'` +
        (marketplaceAccountId
          ? ` and marketplace_account_id = '${marketplaceAccountId}'`
          : ''),
    ),
  )
  return round(now() - start)
}

/**
 * SERT SINIR SONDASI: `findLinesForOrders` tek sorguda `inArray(orderId, ids)`
 * kullanır. PostgreSQL genişletilmiş protokolü sorgu başına en fazla 65.535
 * bind parametresi taşır. Dashboard analitiği (`listOrdersForAnalytics`)
 * aralıktaki TÜM siparişlerin id'sini tek sorguya koyduğu için aralıkta
 * yeterince sipariş varsa endpoint HATA verir — yavaşlamaz, ÇÖKER.
 *
 * Bu sonda kimliklerin GERÇEK olmasına ihtiyaç duymaz: belirleyici olan
 * parametre SAYISIDIR. Salt okunur SELECT çalıştırır.
 */
export async function probeInArrayLimit(
  db: unknown,
  organizationId: string,
  candidates: number[],
): Promise<{ idCount: number; ok: boolean; error?: string }[]> {
  const { findLinesForOrders } = await import('../orders/orderRepository.ts')
  const out: { idCount: number; ok: boolean; error?: string }[] = []
  for (const idCount of candidates) {
    const ids = Array.from({ length: idCount }, () => randomUUID())
    try {
      await findLinesForOrders(db as never, organizationId, ids)
      out.push({ idCount, ok: true })
    } catch (error) {
      out.push({
        idCount,
        ok: false,
        error: String((error as Error).message).slice(0, 120),
      })
    }
  }
  return out
}

/** EXPLAIN (ANALYZE) — planı metin olarak döner. YAZMA YOK. */
export async function explain(
  db: AnyDb,
  statement: string,
): Promise<string[]> {
  const result = (await db.execute(
    sql.raw(`explain (analyze, buffers, timing) ${statement}`),
  )) as { rows?: Array<Record<string, string>> } | Array<Record<string, string>>
  const rows = Array.isArray(result) ? result : (result.rows ?? [])
  return rows.map((row) => String(Object.values(row)[0] ?? ''))
}
