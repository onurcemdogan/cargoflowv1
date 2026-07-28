// CLI: account-scoped HISTORICAL order backfill. Trendyol'dan (READ-ONLY, tüm
// statüler, tam aralık, eksiksiz pagination, retry) çeker ve YALNIZ hedef
// marketplaceAccountId kapsamında yerel PostgreSQL'e idempotent upsert eder.
// Mevcut operationStatus/LABEL_READY/LABEL_PRINTED/reprint/desi EZİLMEZ;
// complete=false → reconcile/arşiv YOK. Dashboard'a provider fetch EKLEMEZ
// (bu ayrı, açık bir operasyon CLI'ıdır).
//
// TARİH EKSENİ AÇIK: --start/--end verilen tarihler Trendyol'da pratikte
// orderDate DEĞİL packageLastModifiedDate (MODIFIED aktivite) penceresidir.
// Bu yüzden açık isimlendirme tercih edilir: --modified-start/--modified-end.
// Eski --start/--end desteklenir ama açık UYARI verir; manifest her durumda
// dateBasis="marketplace_last_modified_at" damgalar.
//
//   npm run orders:reconcile -- --organization-id <org> --provider Trendyol \
//     --provider-account-id 277221 --modified-start 2026-06-01 \
//     --modified-end 2026-07-31 --dry-run
//   npm run orders:reconcile -- ... --apply --confirmation-token <TOKEN>
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  isCredentialEncryptionConfigured,
  loadOrganizationIntegrationConfig,
} from '../integrations/credentialService.ts'
import { getAccountByProviderAccountId } from '../integrations/marketplaceAccountRepository.ts'
import { fetchHistoricalOrders } from '../trendyol/historicalOrderFetch.ts'
import { applyBackfill, planBackfill } from './historicalOrderBackfill.ts'

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return undefined
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function parseDate(value: string | undefined, endOfDay = false): number | null {
  if (!value) return null
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}
function manifestDir(): string {
  return String(process.env.ORDER_BACKFILL_MANIFEST_DIR ?? process.cwd())
}
function log(obj: unknown): void {
  console.info(JSON.stringify(obj, null, 2))
}

async function main(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[orders:reconcile] DATABASE_URL tanımlı değil.')
    return 1
  }
  if (!isCredentialEncryptionConfigured()) {
    console.error('[orders:reconcile] CREDENTIAL_ENCRYPTION_KEY yapılandırılmamış.')
    return 1
  }
  const organizationId = parseArg('organization-id')
  const marketplace = parseArg('provider') ?? 'Trendyol'
  const providerAccountId = parseArg('provider-account-id')
  // Tarih ekseni: tercih edilen açık isimler --modified-start/--modified-end;
  // eski --start/--end desteklenir ama UYARI verir. --date-basis verilirse
  // yalnız 'modified' geçerlidir (fetch fiilen modified penceresi uygular).
  const modifiedStart = parseArg('modified-start')
  const modifiedEnd = parseArg('modified-end')
  const legacyStart = parseArg('start')
  const legacyEnd = parseArg('end')
  const dateBasisArg = parseArg('date-basis')
  if (dateBasisArg && dateBasisArg !== 'modified') {
    console.error(
      "[orders:reconcile] --date-basis yalnız 'modified' olabilir (fetch " +
        'penceresi marketplaceLastModifiedAt aktivitesidir, orderDate DEĞİL).',
    )
    return 1
  }
  const usingLegacyNames =
    modifiedStart == null && modifiedEnd == null && (legacyStart != null || legacyEnd != null)
  if (usingLegacyNames) {
    console.warn(
      '[orders:reconcile] UYARI: --start/--end bir MODIFIED aktivite penceresidir ' +
        '(marketplaceLastModifiedAt), sipariş AYI DEĞİL. Açık isim için ' +
        '--modified-start/--modified-end kullanın. Manifest dateBasis=' +
        '"marketplace_last_modified_at" damgalanır.',
    )
  }
  const startMs = parseDate(modifiedStart ?? legacyStart)
  const endMs = parseDate(modifiedEnd ?? legacyEnd, true)
  const apply = hasFlag('apply')
  if (!organizationId || !providerAccountId || startMs == null || endMs == null) {
    console.error(
      '[orders:reconcile] --organization-id, --provider-account-id ve ' +
        '--modified-start/--modified-end (veya eski --start/--end) zorunlu.',
    )
    return 1
  }
  const db = getDb()
  const account = await getAccountByProviderAccountId(
    db,
    organizationId,
    marketplace,
    providerAccountId,
  )
  if (!account) {
    console.error(
      `[orders:reconcile] Hesap bulunamadı: ${marketplace} providerAccountId=${providerAccountId}.`,
    )
    return 1
  }
  // Credential org config'ten çözülür; sellerId hedefle eşleşmeli (yanlış hesabın
  // verisini yanlış credential ile çekme). apiKey/apiSecret LOGLANMAZ.
  // CredentialDb yapısal arayüzüne cast (drizzle builder yapısal eşleşmiyor).
  const config = await loadOrganizationIntegrationConfig(
    db as unknown as Parameters<typeof loadOrganizationIntegrationConfig>[0],
    organizationId,
  )
  const credentials = config.trendyol as {
    sellerId?: string
    apiKey?: string
    apiSecret?: string
    environment?: string
  }
  if (!credentials?.sellerId || !credentials?.apiKey || !credentials?.apiSecret) {
    console.error('[orders:reconcile] Trendyol credential eksik (org config).')
    return 1
  }
  if (String(credentials.sellerId) !== String(providerAccountId)) {
    console.error(
      '[orders:reconcile] org config sellerId ile --provider-account-id EŞLEŞMİYOR; ' +
        'yanlış hesabın verisi çekilmesin diye durduruldu.',
    )
    return 1
  }

  const scope = { organizationId, marketplaceAccountId: account.id, startMs, endMs }
  console.info('[orders:reconcile] Trendyol\'dan tüm statüler READ-ONLY çekiliyor…')
  const fetched = await fetchHistoricalOrders(
    {
      sellerId: String(credentials.sellerId),
      apiKey: String(credentials.apiKey),
      apiSecret: String(credentials.apiSecret),
      environment: String(credentials.environment ?? 'prod'),
    },
    { startMs, endMs },
  )
  console.info(
    `[orders:reconcile] Çekim: ${fetched.fetchedPackageCount} paket, ` +
      `${fetched.requestedWindows} pencere, ${fetched.failedWindows} başarısız, ` +
      `complete=${fetched.complete}`,
  )
  if (fetched.failedWindows > 0) {
    console.error(
      '[orders:reconcile] UYARI: bazı pencereler başarısız (PARTIAL). Sonuç COMPLETE ' +
        'sayılmaz; apply eksik veri yazabilir. Aralığı daraltıp tekrar deneyin.',
    )
  }

  if (!apply) {
    const plan = await planBackfill(db, scope, fetched.orders)
    console.info('[orders:reconcile] DRY-RUN (DB değişmedi):')
    log({ ...plan, providerComplete: fetched.complete, failedWindows: fetched.failedWindows })
    console.info(
      `[orders:reconcile] Apply için: --apply --confirmation-token ${plan.confirmationToken}`,
    )
    return 0
  }

  const confirmationToken = parseArg('confirmation-token')
  if (!confirmationToken) {
    console.error('[orders:reconcile] --apply için --confirmation-token zorunlu.')
    return 1
  }
  const batchId = randomUUID()
  const appliedAt = new Date().toISOString()
  const manifest = await applyBackfill(
    db,
    {
      ...scope,
      confirmationToken,
      batchId,
      appliedAt,
      providerComplete: fetched.complete,
      failedWindows: fetched.failedWindows,
    },
    fetched.orders,
  )
  try {
    mkdirSync(manifestDir(), { recursive: true })
  } catch {
    // dizin zaten olabilir
  }
  const manifestPath = join(manifestDir(), `order-backfill-${batchId}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  console.info('[orders:reconcile] APPLY tamamlandı. Manifest:', manifestPath)
  log(manifest)
  if (!manifest.providerComplete) {
    console.error(
      '[orders:reconcile] NOT: provider PARTIAL idi; kalan pencereler için tekrar çalıştırın ' +
        '(idempotent).',
    )
  }
  return 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    '[orders:reconcile] Hata:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
