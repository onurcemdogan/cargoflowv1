// TRENDYOL YÜKSEK HACİM İNGESTİYON ÖLÇÜMÜ — SENTETİK, AĞSIZ.
//
// NE ÖLÇER: stream sayfalarından gelen paketlerin tekilleştirme + yakınsama
// kararlarını ve bunun kaç YAZMAYA dönüştüğünü. Marketplace ağı ve gerçek
// Postgres BU ÖLÇÜMDE YOKTUR — bu yüzden çıktı "uçtan uca sync süresi" diye
// SUNULMAZ; ingestion karar hattının maliyetidir.
//
// AĞ YOK · DB YOK · TAŞIYICI YOK · GERÇEK PAKET YOK.
import {
  dedupeIncomingPackages,
  resolvePackageConvergence,
  type IncomingPackage,
  type StoredPackage,
} from './trendyolPackageConvergence.ts'
import { parseTrendyolStreamPage, TRENDYOL_STREAM_MAX_SIZE } from './trendyolOrderStream.ts'

const readArg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) ? value : fallback
}

/** Deterministik üretim — `Math.random` YOK (tekrar edilebilirlik). */
function syntheticPages(total: number, size: number): unknown[] {
  const pages: unknown[] = []
  for (let start = 0; start < total; start += size) {
    const content: IncomingPackage[] = []
    for (let i = start; i < Math.min(start + size, total); i += 1) {
      content.push({
        shipmentPackageId: `PKG-${i}`,
        orderNumber: `115${1_000_000 + Math.floor(i / 2)}`, // her 2 pakette 1 sipariş
        cargoTrackingNumber: `727${2_000_000 + i}`,
        status: i % 3 === 0 ? 'Created' : 'Picking',
        lastModifiedDate: 1_700_000_000_000 + i * 1_000,
      })
    }
    pages.push({
      content,
      nextCursor: start + size < total ? `CUR-${start + size}` : null,
      hasMore: start + size < total,
    })
  }
  return pages
}

export function runTrendyolSyncBenchmark(): number {
  const total = readArg('packages', 1_000)
  const size = Math.min(readArg('size', TRENDYOL_STREAM_MAX_SIZE), TRENDYOL_STREAM_MAX_SIZE)
  // Örtüşme: mutabakat pencereleri kasıtlı olarak çakışır. Tekilleştirme
  // bunu ZARARSIZ kılmalı.
  const overlapPct = readArg('overlap', 10)

  const pages = syntheticPages(total, size)
  const parseStart = performance.now()
  const parsed = pages.map((page) => parseTrendyolStreamPage(page))
  const parseMs = performance.now() - parseStart

  const incoming: IncomingPackage[] = []
  for (const page of parsed) incoming.push(...(page.packages as IncomingPackage[]))
  // Örtüşen pencerelerden gelen tekrarları ekle.
  const overlapCount = Math.floor((incoming.length * overlapPct) / 100)
  for (let i = 0; i < overlapCount; i += 1) incoming.push(incoming[i])

  const dedupeStart = performance.now()
  const deduped = dedupeIncomingPackages(incoming)
  const dedupeMs = performance.now() - dedupeStart

  // Yerel depo: paketlerin yarısı zaten var ve YARISI GÜNCEL (yazma
  // gerektirmez) — gerçekçi mutabakat koşusu.
  const stored = new Map<string, StoredPackage>()
  for (let i = 0; i < Math.floor(total / 2); i += 1) {
    stored.set(`PKG-${i}`, {
      packageId: `PKG-${i}`,
      orderNumber: `115${1_000_000 + Math.floor(i / 2)}`,
      cargoTrackingNumber: `727${2_000_000 + i}`,
      providerStatus: i % 3 === 0 ? 'Created' : 'Picking',
      marketplaceLastModifiedAt: 1_700_000_000_000 + i * 1_000,
    })
  }

  const decideStart = performance.now()
  const counts: Record<string, number> = {}
  for (const entry of deduped) {
    const packageId = String(entry.shipmentPackageId ?? '')
    const decision = resolvePackageConvergence({
      incoming: entry, stored: stored.get(packageId) ?? null,
    }).decision
    counts[decision] = (counts[decision] ?? 0) + 1
  }
  const decideMs = performance.now() - decideStart

  const writes = (counts.INSERT ?? 0) + (counts.UPDATE ?? 0)
  const skipped = (counts.SKIP_UNCHANGED ?? 0) + (counts.SKIP_STALE ?? 0)
  const totalMs = parseMs + dedupeMs + decideMs

  console.info('=== TRENDYOL INGESTION BENCHMARK (SENTETİK · AĞSIZ) ===')
  console.info('')
  console.info(`PACKAGES                 ${total}`)
  console.info(`STREAM_PAGE_SIZE         ${size}`)
  console.info(`STREAM_PAGES             ${pages.length}`)
  console.info(`MARKETPLACE_REQUESTS     ${pages.length}  (sayfa başına 1)`)
  console.info(`OVERLAP_DUPLICATES_IN    ${overlapCount}`)
  console.info(`AFTER_DEDUPE             ${deduped.length}`)
  console.info('')
  console.info(`DECISION_INSERT          ${counts.INSERT ?? 0}`)
  console.info(`DECISION_UPDATE          ${counts.UPDATE ?? 0}`)
  console.info(`DECISION_SKIP_UNCHANGED  ${counts.SKIP_UNCHANGED ?? 0}`)
  console.info(`DECISION_SKIP_STALE      ${counts.SKIP_STALE ?? 0}`)
  console.info(`DB_WRITES                ${writes}`)
  console.info(`WRITES_AVOIDED           ${skipped}`)
  console.info('')
  console.info(`PARSE_MS                 ${parseMs.toFixed(1)}`)
  console.info(`DEDUPE_MS                ${dedupeMs.toFixed(1)}`)
  console.info(`DECIDE_MS                ${decideMs.toFixed(1)}`)
  console.info(`TOTAL_MS                 ${totalMs.toFixed(1)}`)
  console.info(`PER_1K_MS                ${((totalMs / total) * 1000).toFixed(1)}`)
  console.info('')
  // Ölçümün SINIRI açıkça yazılır; "sync süresi" diye okunmasın.
  console.info('SCOPE  ingestion karar hattı (parse+dedupe+convergence).')
  console.info('SCOPE  Marketplace ağı ve Postgres BU ÖLÇÜMDE YOK.')
  console.info('NETWORK_CALLS 0 · DB_WRITES 0 · CARRIER_CALLS 0')
  return 0
}

const invokedDirectly = process.argv[1]?.includes('trendyolSyncBenchmarkCli')
if (invokedDirectly) process.exitCode = runTrendyolSyncBenchmark()
