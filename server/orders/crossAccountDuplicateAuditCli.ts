// CLI: ÇAPRAZ HESAP TEKRARI TANISI — TAMAMEN SALT OKUNUR.
//
//   npm run orders:duplicates:check
//   npm run orders:duplicates:check -- --org <uuid> --sample 10
//
// YAPAR : marketplace_accounts ve orders tablolarını OKUR; aynı paket için
//         birden fazla hesap kapsamı taşıyan grupları sayar, sınıflandırır ve
//         bağımlılık (order_lines / shipments / shipment_operations)
//         sayımlarını raporlar.
// YAPMAZ: DB update/insert/delete · temizlik/arşivleme · Trendyol çağrısı ·
//         taşıyıcı (Sürat) çağrısı · credential/secret çıktısı.
//
// PII YOK: müşteri/adres/ürün alanları okunmaz; yalnız teknik kimlikler,
// statüler ve sayımlar raporlanır.
import { and, eq } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { marketplaceAccounts } from '../db/schema.ts'
import {
  auditCrossAccountDuplicates,
  countNullAccountRows,
} from './crossAccountDuplicateAudit.ts'
import { buildCleanupEligibilityReport } from './duplicateCleanupEligibility.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }
  const organizationId = parseArg('org') ?? null
  const sampleLimit = Number(parseArg('sample') ?? 10)
  const db = getDb()

  // ── §1 PAZARYERİ HESAPLARI (credential/secret OKUNMAZ) ───────────────────
  const accountRows = await db
    .select({
      id: marketplaceAccounts.id,
      organizationId: marketplaceAccounts.organizationId,
      marketplace: marketplaceAccounts.marketplace,
      isActive: marketplaceAccounts.isActive,
      lastSuccessfulSyncAt: marketplaceAccounts.lastSuccessfulSyncAt,
      lastSyncStatus: marketplaceAccounts.lastSyncStatus,
      createdAt: marketplaceAccounts.createdAt,
      updatedAt: marketplaceAccounts.updatedAt,
    })
    .from(marketplaceAccounts)
    .where(
      organizationId
        ? and(
            eq(marketplaceAccounts.organizationId, organizationId),
            eq(marketplaceAccounts.marketplace, 'Trendyol'),
          )
        : eq(marketplaceAccounts.marketplace, 'Trendyol'),
    )

  type AccountRow = {
    id: string
    organizationId: string
    marketplace: string
    isActive: boolean
    lastSuccessfulSyncAt: Date | null
    lastSyncStatus: string | null
    createdAt: Date | null
    updatedAt: Date | null
  }
  const accounts = accountRows.map((row: AccountRow) => ({
    accountId: row.id,
    organizationId: row.organizationId,
    marketplace: row.marketplace,
    isActive: Boolean(row.isActive),
    lastSyncStatus: row.lastSyncStatus ?? null,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null,
    updatedAt: row.updatedAt?.toISOString?.() ?? null,
  }))
  const activeAccountIds = accounts
    .filter((account: { isActive: boolean }) => account.isActive)
    .map((account: { accountId: string }) => account.accountId)

  // ── §2/§3/§4 TEKRAR SAYIMI + SINIF + BAĞIMLILIK ──────────────────────────
  const duplicates = await auditCrossAccountDuplicates(db, {
    organizationId,
    activeAccountIds,
    sampleLimit,
  })
  const nullAccountRowCount = await countNullAccountRows(db, organizationId)

  // ── TEMİZLİK UYGUNLUĞU (SALT SINIFLANDIRMA — SİLME YOK) ──────────────────
  const inactiveAccountIds = accounts
    .filter((account: { isActive: boolean }) => !account.isActive)
    .map((account: { accountId: string }) => account.accountId)
  const eligibility = await buildCleanupEligibilityReport(db, {
    organizationId,
    activeAccountIds,
    inactiveAccountIds,
    sampleLimit,
  })

  console.log(
    JSON.stringify(
      {
        mode: 'read_only',
        scope: organizationId ? { organizationId } : { organizationId: 'ALL' },
        accounts,
        activeAccountIds,
        nullAccountRowCount,
        inactiveAccountIds,
        ...duplicates,
        eligibility,
        // TEMİZLİK BU KOMUTUN İŞİ DEĞİLDİR (ayrı, onaylı tur).
        cleanupPerformed: false,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((error) => {
    console.error('tanı başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
