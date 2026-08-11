// CLI: BOZUK SİPARİŞ KİMLİĞİ TANISI — TAMAMEN SALT OKUNUR.
//
//   npm run orders:malformed:check
//   npm run orders:malformed:check -- --limit 100 --sample 3
//
// YAPAR : `orders` (+ satır sayıları) OKUR, kalıcı ham yükün KİMLİK ŞEKLİNİ
//         çözer, kusurları sınıflandırır ve yazar imzasını raporlar.
// YAPMAZ: DB update/insert/delete · temizlik · sipariş senkronu · taşıyıcı
//         (Sürat) çağrısı · Trendyol çağrısı · etiket/ZPL üretimi.
//
// PII YOK: müşteri adı/adres/telefon, ürün adı ve tutarlar ASLA yazdırılmaz;
// ham yükten yalnız alan VARLIĞI ve TİPİ raporlanır.
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { orderLines, orders } from '../db/schema.ts'
import { decryptOrderPayload } from './orderEncryption.ts'
import {
  attributeWriter,
  classifyDecryptError,
  describeRawIdentityShape,
  findIdentityDefects,
  isMalformedIdentity,
  passesTrendyolPackagePredicate,
  resolveOrderKeySource,
} from './malformedOrderAudit.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }
  const limit = positiveInt(parseArg('limit'), 200)
  // Ham yük ŞEKLİ yalnız ilk N kayıt için çözülür (çözme maliyetli).
  const sampleSize = positiveInt(parseArg('sample'), 5)

  // Belirli bir satırı hedefleme (üretimdeki golden kayıt için).
  const targetPackageId = parseArg('package-id')
  const targetOrderNumber = parseArg('order-number')

  const db = getDb()

  // ── SALT OKUMA: kimlik açısından şüpheli kayıtlar ────────────────────────
  //
  // Ön filtre SQL'de dar tutulur (yer tutucu sipariş no / paket no ya da boş
  // pazaryeri statüsü); nihai sınıflandırma kodda yapılır.
  const rows = await db
    .select({
      id: orders.id,
      organizationId: orders.organizationId,
      marketplaceAccountId: orders.marketplaceAccountId,
      marketplace: orders.marketplace,
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
      orderDate: orders.orderDate,
      lastSeenAt: orders.lastSeenAt,
      firstSeenAt: orders.firstSeenAt,
      createdAt: orders.createdAt,
      archivedAt: orders.archivedAt,
      marketplaceLastModifiedAt: orders.marketplaceLastModifiedAt,
      rawPayloadEncrypted: orders.rawPayloadEncrypted,
    })
    .from(orders)
    .where(
      targetPackageId || targetOrderNumber
        ? sql`(
            ${orders.packageId} = ${targetPackageId ?? '__no_match__'}
            or ${orders.orderNumber} = ${targetOrderNumber ?? '__no_match__'}
          )`
        : sql`(
            ${orders.orderNumber} in ('0', '', 'null', 'undefined', 'NaN')
            or ${orders.packageId} in ('0', '', 'null', 'undefined', 'NaN')
            or ${orders.marketplaceStatus} is null
            or trim(${orders.marketplaceStatus}) = ''
            or ${orders.marketplaceStatus} = 'Unknown'
          )`,
    )
    .orderBy(desc(orders.createdAt))
    .limit(limit)

  const malformed = rows.filter((row) => isMalformedIdentity(row))
  const statusOnly = rows.filter((row) => !isMalformedIdentity(row))

  // Toplam sayım (limit'ten bağımsız) — "kaç tane" sorusunun cevabı.
  const [totals] = await db
    .select({ total: count() })
    .from(orders)
    .where(
      sql`${orders.orderNumber} in ('0', '', 'null', 'undefined', 'NaN')
          or ${orders.packageId} in ('0', '', 'null', 'undefined', 'NaN')`,
    )

  const lineCounts = new Map<string, number>()
  for (const row of malformed.slice(0, sampleSize)) {
    const [result] = await db
      .select({ total: count() })
      .from(orderLines)
      .where(
        and(
          eq(orderLines.organizationId, row.organizationId),
          eq(orderLines.orderId, row.id),
        ),
      )
    lineCounts.set(row.id, Number(result?.total ?? 0))
  }

  const describe = (row: (typeof rows)[number]) => ({
    id: row.id,
    organizationId: row.organizationId,
    marketplaceAccountId: row.marketplaceAccountId,
    marketplace: row.marketplace,
    packageId: row.packageId,
    orderNumber: row.orderNumber,
    marketplaceStatus: row.marketplaceStatus,
    operationStatus: row.operationStatus,
    orderDate: row.orderDate?.toISOString?.() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString?.() ?? null,
    firstSeenAt: row.firstSeenAt?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null,
    marketplaceLastModifiedAt:
      row.marketplaceLastModifiedAt?.toISOString?.() ?? null,
    archived: Boolean(row.archivedAt),
    defects: findIdentityDefects(row),
    writerHint: attributeWriter({
      marketplaceAccountId: row.marketplaceAccountId,
      rawPayloadPresent: Boolean(row.rawPayloadEncrypted),
    }),
    rawPayloadPresent: Boolean(row.rawPayloadEncrypted),
  })

  // ── HAM YÜK KİMLİK ŞEKLİ (yalnız örneklem) ───────────────────────────────
  const samples = malformed.slice(0, sampleSize).map((row) => {
    let raw: unknown = null
    let rawError: string | null = null
    try {
      // KANONİK çözücü — CLI'ye ÖZEL bir uygulama YOKTUR.
      raw = decryptOrderPayload(row.rawPayloadEncrypted)
    } catch (error) {
      // Çözülemeyen yük ham hâliyle RAPORLANMAZ; yalnız GÜVENLİ kategori.
      rawError = classifyDecryptError(error)
    }
    return {
      id: row.id,
      lineCount: lineCounts.get(row.id) ?? null,
      rawError,
      // KİMLİK ŞEKLİ — değer YOK, yalnız varlık/tip/sıfır bayrağı.
      rawIdentityShape: describeRawIdentityShape(raw),
      // Bu kayıt normalize filtresinden NASIL geçti?
      passesPackagePredicate: raw ? passesTrendyolPackagePredicate(raw) : null,
    }
  })

  const timestamps = malformed
    .map((row) => row.createdAt?.getTime?.())
    .filter((value): value is number => Number.isFinite(value))

  const report = {
    mode: 'read_only',
    // Hangi env ADI kullanıldı (DEĞER değil). `auth_tag_mismatch` +
    // CREDENTIAL_ENCRYPTION_KEY → kayıt ORDER_DATA_ENCRYPTION_KEY ile
    // yazılmış demektir; komutu o anahtar yüklüyken tekrar çalıştırın.
    encryptionKeySource: resolveOrderKeySource(),
    scannedRows: rows.length,
    scanLimit: limit,
    // Yer tutucu KİMLİKLİ kayıt sayısı (limit'ten bağımsız toplam).
    placeholderIdentityTotal: Number(totals?.total ?? 0),
    malformedCount: malformed.length,
    // Kimliği SAĞLAM ama pazaryeri statüsü boş kayıtlar — ayrı sinyal.
    statusOnlyCount: statusOnly.length,
    firstCreatedAt: timestamps.length
      ? new Date(Math.min(...timestamps)).toISOString()
      : null,
    lastCreatedAt: timestamps.length
      ? new Date(Math.max(...timestamps)).toISOString()
      : null,
    writerHintCounts: malformed.reduce<Record<string, number>>((acc, row) => {
      const hint = attributeWriter({
        marketplaceAccountId: row.marketplaceAccountId,
        rawPayloadPresent: Boolean(row.rawPayloadEncrypted),
      })
      acc[hint] = (acc[hint] ?? 0) + 1
      return acc
    }, {}),
    malformed: malformed.map(describe),
    statusOnly: statusOnly.slice(0, sampleSize).map(describe),
    samples,
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
