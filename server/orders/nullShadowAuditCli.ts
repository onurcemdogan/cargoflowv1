// CLI: NULL-HESAP GÖLGE SATIRI KÖKEN/TEKRAR DENETİMİ — TAMAMEN SALT OKUNUR.
//
//   npm run orders:null-shadow:audit
//   npm run orders:null-shadow:audit -- --org <uuid> --sample 20
//
// YAPAR : `orders` / `order_lines` / `shipments` / `shipment_operations`
//         OKUR; zaman çizelgesi, sınıflandırma ve tekrar kararı üretir.
// YAPMAZ: DB update/insert/delete/archive · temizlik · Trendyol çağrısı ·
//         taşıyıcı (Sürat) çağrısı · runtime davranış değişikliği.
//
// PII YOK: müşteri/adres alanları okunmaz; satır içeriği yalnız KARŞILAŞTIRMA
// ANAHTARI olarak kullanılır, çıktıya yazılmaz.
import { and, eq } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { marketplaceAccounts } from '../db/schema.ts'
import { auditNullShadowRows } from './nullShadowAudit.ts'

/**
 * HESAP KAPSAMI DÜZELTMESİNİN COMMIT SINIRI.
 * `c34acbe` — "Arka plan Trendyol senkronu aktif hesap kapsamına yazar
 * (CASE B2-C)", commit tarihi 2026-08-11T16:42:24+03:00 (merge 0980dd5,
 * 16:44:57+03:00).
 *
 * DİKKAT: bu bir COMMIT sınırıdır, DEPLOY sınırı DEĞİLDİR. Üretime alınma
 * anı elimizde kanıtlı olmadığı için tahmin ÜRETİLMEZ; rapor `cutoffBasis`
 * alanında bunu açıkça bildirir.
 */
const ACCOUNT_SCOPE_FIX_COMMIT = 'c34acbe'
const ACCOUNT_SCOPE_FIX_COMMITTED_AT = '2026-08-11T16:42:24+03:00'

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
  const sampleLimit = Number(parseArg('sample') ?? 20)
  // Operatör gerçek deploy anını biliyorsa açıkça verebilir.
  const deployedAtArg = parseArg('deployed-at')
  const boundary = new Date(deployedAtArg ?? ACCOUNT_SCOPE_FIX_COMMITTED_AT)

  const db = getDb()
  const accountRows = (await db
    .select({
      id: marketplaceAccounts.id,
      isActive: marketplaceAccounts.isActive,
    })
    .from(marketplaceAccounts)
    .where(
      organizationId
        ? and(
            eq(marketplaceAccounts.organizationId, organizationId),
            eq(marketplaceAccounts.marketplace, 'Trendyol'),
          )
        : eq(marketplaceAccounts.marketplace, 'Trendyol'),
    )) as { id: string; isActive: boolean }[]
  const activeAccountIds = accountRows.filter((r) => r.isActive).map((r) => r.id)

  const report = await auditNullShadowRows(db, {
    organizationId,
    activeAccountIds,
    fixBoundary: boundary,
    sampleLimit,
  })

  console.log(
    JSON.stringify(
      {
        mode: 'read_only',
        accountScopeFixCommit: ACCOUNT_SCOPE_FIX_COMMIT,
        accountScopeFixCommittedAt: ACCOUNT_SCOPE_FIX_COMMITTED_AT,
        cutoffBasis: deployedAtArg
          ? 'operator_supplied_deploy_timestamp'
          : 'commit_boundary_only',
        activeAccountIds,
        ...report,
        cleanupPerformed: false,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((error) => {
    console.error('denetim başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
