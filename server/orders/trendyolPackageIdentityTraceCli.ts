// CLI: TRENDYOL PAKET KİMLİĞİ İZİ — TAMAMEN SALT OKUNUR.
//
//   npm run trendyol:package-status:check -- \
//     --package-id 4065907241 --order-number 11493372619
//
// YAPAR : orders tablosunu OKUR · Trendyol sipariş ucunu GET ile OKUR.
// YAPMAZ: DB update/insert/delete · sipariş senkron kalıcılığı ·
//         shipment create/update/delete · taşıyıcı (Sürat) çağrısı ·
//         Trendyol write (paket statü güncelleme) · kimlik/secret loglama.
//
// Çıktı PII TAŞIMAZ: müşteri adı/adres/telefon/satır içeriği/tutar YOKTUR;
// yalnız teknik kimlikler, statüler ve zaman damgaları.
import { and, desc, eq } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { orders } from '../db/schema.ts'
import { getActiveAccount } from '../integrations/marketplaceAccountRepository.ts'
import {
  getIntegrationCredential,
  type CredentialDb,
} from '../integrations/credentialService.ts'
import {
  buildOrdersQueryUrl,
  classifyPackageIdentityCase,
  effectiveStatusOf,
  extractPackageIdentityFields,
  packagesOf,
  resolveTraceWindow,
  type PackageIdentityFields,
} from './trendyolPackageIdentityTrace.ts'

const PROD_BASE_URL =
  process.env.TRENDYOL_PROD_BASE_URL || 'https://apigw.trendyol.com'
const STAGE_BASE_URL =
  process.env.TRENDYOL_STAGE_BASE_URL || 'https://stageapigw.trendyol.com'
/** Tanı komutu için sert üst sınır: sonsuz sayfalama YOK. */
const MAX_PAGES = 5

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

function parseTimeArg(name: string): number | null {
  const raw = parseArg(name)
  if (!raw) return null
  const numeric = Number(raw)
  const time = Number.isFinite(numeric) ? numeric : Date.parse(raw)
  return Number.isFinite(time) ? time : null
}

/**
 * `index.mjs` → `fetchTrendyolJson` ile AYNI istek başlıkları (Basic auth +
 * `<sellerId> - CargoFlow` user-agent + opsiyonel storeFrontCode). YALNIZ GET.
 */
async function trendyolGet(
  url: string,
  credentials: Record<string, unknown>,
): Promise<{ ok: boolean; statusCode: number; data: unknown; error?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(
      `${credentials.apiKey}:${credentials.apiSecret}`,
    ).toString('base64')}`,
    'User-Agent': `${String(credentials.sellerId ?? '').trim() || 'CargoFlow'} - CargoFlow`,
    Accept: 'application/json',
  }
  if (credentials.storeFrontCode) {
    headers.storeFrontCode = String(credentials.storeFrontCode)
  }
  try {
    const response = await fetch(url, { method: 'GET', headers })
    const body = await response.text()
    let data: unknown = null
    try {
      data = body.trim() ? JSON.parse(body) : null
    } catch {
      // Ham gövde RAPORLANMAZ (secret/PII sızıntısı riski) — yalnız kategori.
      return {
        ok: false,
        statusCode: response.status,
        data: null,
        error: 'non_json_response',
      }
    }
    return { ok: response.ok, statusCode: response.status, data }
  } catch {
    return { ok: false, statusCode: 0, data: null, error: 'network_error' }
  }
}

async function main(): Promise<void> {
  const packageId = parseArg('package-id')
  const orderNumberArg = parseArg('order-number')
  if (!packageId && !orderNumberArg) {
    console.error(
      'Kullanım: --package-id <packageId> [--order-number <orderNumber>] ' +
        '[--window-days N] [--window-start <ms|ISO>] [--window-end <ms|ISO>]',
    )
    process.exitCode = 1
    return
  }
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }

  const db = getDb()

  // ── SALT OKUMA: EŞLEŞEN TÜM SATIRLAR ─────────────────────────────────────
  //
  // ÜRETİM HATASI (kanıtlandı): aynı paket BİRDEN FAZLA pazaryeri hesabı
  // kapsamında satır taşıyabiliyor (aktif hesap + eski/legacy hesap). Eski
  // sürüm hesap kapsamı belirtmeden `limit(1)` ile satır seçtiği için ESKİ
  // satırı "persisted" sanıp yanlış `B2_persistence_or_matching_bug` verdikti.
  // Artık TÜM eşleşmeler raporlanır, karar ise KANONİK (aktif hesap) satırla
  // verilir. UI de aynı kapsamı kullanır (findOrders → accountScope).
  const where = packageId
    ? eq(orders.packageId, packageId)
    : eq(orders.orderNumber, String(orderNumberArg))
  const orderRows = await db
    .select({
      id: orders.id,
      organizationId: orders.organizationId,
      marketplaceAccountId: orders.marketplaceAccountId,
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
      marketplace: orders.marketplace,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
      orderDate: orders.orderDate,
      marketplaceLastModifiedAt: orders.marketplaceLastModifiedAt,
      lastSeenAt: orders.lastSeenAt,
      archivedAt: orders.archivedAt,
    })
    .from(orders)
    .where(
      packageId && orderNumberArg
        ? and(where, eq(orders.orderNumber, orderNumberArg))
        : where,
    )
    .orderBy(desc(orders.lastSeenAt))

  // KANONİK SATIR: organizasyonun AKTİF Trendyol hesabı kapsamındaki satır.
  // Aktif hesap çözülemezse (veya o kapsamda satır yoksa) en son görülen
  // satıra düşülür ve bu durum raporda AÇIKÇA belirtilir.
  const organizationId = orderRows[0]?.organizationId ?? null
  const activeAccount = organizationId
    ? await getActiveAccount(db, organizationId, 'Trendyol')
    : null
  const activeAccountId = activeAccount?.id ?? null
  const scopedRow =
    orderRows.find(
      (row: Record<string, unknown>) =>
        String(row.marketplaceAccountId ?? '') === String(activeAccountId ?? ''),
    ) ?? null
  const persistedRow = scopedRow ?? orderRows[0] ?? null
  const canonicalSelection = scopedRow
    ? 'active_account_scope'
    : orderRows.length > 0
      ? 'fallback_most_recently_seen'
      : 'not_found'

  const orderNumber = String(
    orderNumberArg ?? persistedRow?.orderNumber ?? '',
  ).trim()
  const persistedPackageId = String(
    packageId ?? persistedRow?.packageId ?? '',
  ).trim()

  const summarizeRow = (row: Record<string, unknown> | null) =>
    row
      ? {
          id: row.id,
          marketplaceAccountId: row.marketplaceAccountId,
          isActiveAccountScope:
            String(row.marketplaceAccountId ?? '') ===
            String(activeAccountId ?? ''),
          packageId: row.packageId,
          orderNumber: row.orderNumber,
          marketplaceStatus: row.marketplaceStatus,
          operationStatus: row.operationStatus,
          lastSeenAt: (row.lastSeenAt as Date | null)?.toISOString?.() ?? null,
          marketplaceLastModifiedAt:
            (row.marketplaceLastModifiedAt as Date | null)?.toISOString?.() ??
            null,
          archived: Boolean(row.archivedAt),
        }
      : null

  const persisted = {
    found: Boolean(persistedRow),
    // KANONİK satırın hangi kurala göre seçildiği AÇIKÇA raporlanır.
    canonicalSelection,
    activeMarketplaceAccountId: activeAccountId,
    marketplaceAccountId: persistedRow?.marketplaceAccountId ?? null,
    packageId: persistedRow?.packageId ?? null,
    orderNumber: persistedRow?.orderNumber ?? null,
    marketplace: persistedRow?.marketplace ?? null,
    marketplaceStatus: persistedRow?.marketplaceStatus ?? null,
    operationStatus: persistedRow?.operationStatus ?? null,
    orderDate: persistedRow?.orderDate?.toISOString() ?? null,
    marketplaceLastModifiedAt:
      persistedRow?.marketplaceLastModifiedAt?.toISOString() ?? null,
    lastSeenAt: persistedRow?.lastSeenAt?.toISOString() ?? null,
    archived: Boolean(persistedRow?.archivedAt),
  }

  // ── SALT OKUMA: Trendyol sipariş numarası sorgusu ─────────────────────────
  //
  // TEK KANITLI SORGU SÖZLEŞMESİ: `orderNumber` parametresi. `status`
  // GÖNDERİLMEZ (ileri statüler de görülmeli). `shipmentPackageIds` gibi
  // KANITLANMAMIŞ bir parametre UYDURULMAZ.
  // `CredentialDb` yapısal (minimal) arayüzdür; drizzle sorgu kurucusu ile
  // aynı çalışma zamanı davranışını verir (index.mjs bu servisi aynı db ile
  // çağırıyor). Yalnız tip köprüsü — davranış değişmez.
  const credentials = persistedRow
    ? await getIntegrationCredential(
        db as unknown as CredentialDb,
        persistedRow.organizationId,
        'trendyol',
      )
    : null

  const window = resolveTraceWindow({
    nowMs: Date.now(),
    orderDateMs: persistedRow?.orderDate?.getTime() ?? null,
    windowDays: Number(parseArg('window-days') ?? 30),
    startOverrideMs: parseTimeArg('window-start'),
    endOverrideMs: parseTimeArg('window-end'),
  })

  const queryPackages: PackageIdentityFields[] = []
  let queryOk = false
  let queryError: string | null = null
  let pageRequests = 0
  let totalElements: number | null = null

  if (!orderNumber) {
    queryError = 'missing_order_number'
  } else if (!credentials || !Object.keys(credentials).length) {
    queryError = 'missing_trendyol_credentials'
  } else {
    const baseUrl =
      credentials.environment === 'stage' ? STAGE_BASE_URL : PROD_BASE_URL
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = buildOrdersQueryUrl({
        baseUrl,
        sellerId: String(credentials.sellerId ?? ''),
        orderNumber,
        startDate: window.startDate,
        endDate: window.endDate,
        page,
        size: 200,
      })
      pageRequests += 1
      const result = await trendyolGet(url, credentials)
      if (!result.ok) {
        queryError = result.error ?? `http_${result.statusCode}`
        break
      }
      queryOk = true
      const content = packagesOf(result.data)
      for (const item of content) {
        queryPackages.push(extractPackageIdentityFields(item))
      }
      const payload = (result.data ?? {}) as Record<string, unknown>
      if (totalElements === null && Number.isFinite(Number(payload.totalElements))) {
        totalElements = Number(payload.totalElements)
      }
      const totalPages = Number(payload.totalPages ?? 1)
      if (!Number.isFinite(totalPages) || page + 1 >= totalPages) break
    }
  }

  // Sipariş numarası filtresi uygulandığı için gelen tüm paketler AYNI
  // siparişe aittir; yine de kimlik karışmasın diye açıkça süzülür.
  const packages = queryPackages.filter(
    (pkg) => !pkg.orderNumber || !orderNumber || pkg.orderNumber === orderNumber,
  )
  const exact = packages.find((pkg) => pkg.packageId === persistedPackageId) ?? null
  const verdict = classifyPackageIdentityCase({
    persistedPackageId,
    packages,
    // KARAR KANONİK SATIRA GÖRE verilir (başka hesabın eski satırına DEĞİL).
    persistedMarketplaceStatus: persistedRow?.marketplaceStatus ?? null,
  })

  const report = {
    mode: 'read_only',
    generatedFor: { packageId: persistedPackageId, orderNumber },
    persisted,
    // TANI AMAÇLI: aynı paket/sipariş için TÜM satırlar (PII YOK). Çapraz
    // hesap tekrarı burada görünür; karar yine kanonik satırdan verilir.
    persistedMatches: orderRows.map((row: Record<string, unknown>) =>
      summarizeRow(row),
    ),
    query: {
      // Kanıtlanmış sözleşme: yalnız orderNumber ile sorgulanır.
      identity: 'orderNumber',
      statusFilterApplied: false,
      windowStart: new Date(window.startDate).toISOString(),
      windowEnd: new Date(window.endDate).toISOString(),
      windowBasis: window.basis,
      clampedTo30Days: window.clampedTo30Days,
      ok: queryOk,
      error: queryError,
      pageRequests,
      totalElements,
    },
    exactPackageQuery: {
      // AYRI bir "exact package" ucu KANITLANMADI; exact kimlik, orderNumber
      // sorgusunun sonucu içinde taranır.
      method: 'orderNumber_scan',
      found: Boolean(exact),
      packageId: exact?.packageId ?? null,
      status: exact?.status ?? null,
      shipmentPackageStatus: exact?.shipmentPackageStatus ?? null,
      packageStatus: exact?.packageStatus ?? null,
      effectiveStatus: exact ? effectiveStatusOf(exact) : null,
      lastModifiedDate: exact?.lastModifiedDate ?? null,
      lastModifiedAtMs: exact?.lastModifiedAtMs ?? null,
      originPackageIds: exact?.originPackageIds ?? null,
      rawIds: exact?.rawIds ?? null,
    },
    orderNumberQuery: {
      packageCount: packages.length,
      packages: packages.map((pkg) => ({
        packageId: pkg.packageId,
        rawIds: pkg.rawIds,
        orderNumber: pkg.orderNumber,
        status: pkg.status,
        shipmentPackageStatus: pkg.shipmentPackageStatus,
        packageStatus: pkg.packageStatus,
        effectiveStatus: effectiveStatusOf(pkg),
        lastModifiedDate: pkg.lastModifiedDate,
        lastModifiedAtMs: pkg.lastModifiedAtMs,
        originPackageIds: pkg.originPackageIds,
      })),
    },
    verdict,
  }
  console.log(JSON.stringify(report, null, 2))
}

main()
  .catch((error) => {
    console.error('tanı başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
