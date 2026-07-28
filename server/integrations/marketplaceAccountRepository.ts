// Pazaryeri hesabı (marketplace account) repository'si. Bir organization aynı
// marketplace'te birden fazla satıcı hesabı bağlayabilir; her hesap AYRI veri
// kapsamıdır. TÜM fonksiyonlarda organizationId ZORUNLUDUR.
//
// GÜVENLİK: providerAccountId = provider'ın kalıcı, GİZLİ OLMAYAN hesap kimliği
// (Trendyol için sellerId — API URL path'inde ve User-Agent'ta zaten açık geçer).
// API key/secret veya bunların hash'i ASLA hesap kimliği olarak kullanılmaz ve
// ASLA saklanmaz/loglanmaz. displayName yalnız güvenli, gösterilebilir bir
// etikettir.
import { and, eq, ne } from 'drizzle-orm'
import { marketplaceAccounts } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface MarketplaceAccount {
  id: string
  organizationId: string
  marketplace: string
  providerAccountId: string
  displayName: string | null
  isActive: boolean
  lastSuccessfulSyncAt: Date | null
  lastSyncStatus: string | null
}

// Provider credential'ından KALICI, gizli olmayan hesap kimliğini çözer.
// Trendyol sözleşmesi: sellerId (integration/order/sellers/{sellerId}/... path
// parametresi; User-Agent'ta da geçer). apiKey/apiSecret hesap kimliği DEĞİLDİR.
// Boş/eksikse null döner (hesap oluşturulamaz).
export function resolveProviderAccountId(
  marketplace: string,
  credentials: Record<string, unknown> | null | undefined,
): string | null {
  if (!credentials) return null
  if (String(marketplace) === 'Trendyol') {
    const sellerId = String((credentials as { sellerId?: unknown }).sellerId ?? '').trim()
    return sellerId || null
  }
  return null
}

// Güvenli gösterim etiketi. sellerId gizli değildir; yine de yalnız kısa,
// insan-okur bir etiket üretilir (ham credential/secret sızmaz).
export function buildAccountDisplayName(
  marketplace: string,
  providerAccountId: string,
): string {
  return `${marketplace} • ${providerAccountId}`
}

// (org, marketplace, providerAccountId) için hesabı bulur; yoksa OLUŞTURUR.
// Aynı provider hesap kimliği tekrar gelirse YENİ hesap oluşmaz (idempotent).
// Sonra bu hesabı AKTİF, aynı (org, marketplace) içindeki DİĞERLERİNİ pasif
// yapar (tek aktif hesap garantisi). Eski hesaplar SİLİNMEZ (verileri korunur).
// Aktif hale gelen hesabın satırını döner.
export async function resolveOrCreateActiveAccount(
  db: Db,
  organizationId: string,
  marketplace: string,
  providerAccountId: string,
): Promise<MarketplaceAccount> {
  const now = new Date()
  const displayName = buildAccountDisplayName(marketplace, providerAccountId)
  // 1) Hesabı garanti et (idempotent: aynı provider kimliği yeni hesap açmaz).
  const [row] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId,
      marketplace,
      providerAccountId,
      displayName,
      isActive: false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        marketplaceAccounts.organizationId,
        marketplaceAccounts.marketplace,
        marketplaceAccounts.providerAccountId,
      ],
      set: { displayName, updatedAt: now },
    })
    .returning({ id: marketplaceAccounts.id })
  const accountId = String(row.id)
  // 2) Diğer hesapları pasifleştir (tek aktif hesap: partial unique koruması —
  //    önce diğerlerini kapat, sonra hedefi aç → unique çakışması olmaz).
  await db
    .update(marketplaceAccounts)
    .set({ isActive: false, updatedAt: now })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.marketplace, marketplace),
        ne(marketplaceAccounts.id, accountId),
      ),
    )
  // 3) Hedefi aktifleştir.
  await db
    .update(marketplaceAccounts)
    .set({ isActive: true, updatedAt: now })
    .where(eq(marketplaceAccounts.id, accountId))
  const account = await getAccountById(db, organizationId, accountId)
  // getAccountById tenant-scoped okur; az önce yazıldığı için asla null olmaz.
  return account as MarketplaceAccount
}

// (org, marketplace, providerAccountId) hesabını READ-ONLY döner (yoksa null).
// Hiçbir şey OLUŞTURMAZ/aktifleştirmez — dry-run ve doğrulama için güvenli.
export async function getAccountByProviderAccountId(
  db: Db,
  organizationId: string,
  marketplace: string,
  providerAccountId: string,
): Promise<MarketplaceAccount | null> {
  const rows = await db
    .select()
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.marketplace, marketplace),
        eq(marketplaceAccounts.providerAccountId, providerAccountId),
      ),
    )
    .limit(1)
  return (rows[0] as MarketplaceAccount) ?? null
}

// Hesabı garanti eder ama AKTİFLİK durumuna DOKUNMAZ (aktifleştirmez/pasifleştirmez).
// Backfill hedef hesabı için: eski/pasif bir hesabı, aktif hesabı değiştirmeden
// oluşturabilmek/çözebilmek gerekir. resolveOrCreateActiveAccount'tan farkı budur.
export async function ensureAccount(
  db: Db,
  organizationId: string,
  marketplace: string,
  providerAccountId: string,
): Promise<MarketplaceAccount> {
  const existing = await getAccountByProviderAccountId(
    db,
    organizationId,
    marketplace,
    providerAccountId,
  )
  if (existing) return existing
  const now = new Date()
  const [row] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId,
      marketplace,
      providerAccountId,
      displayName: buildAccountDisplayName(marketplace, providerAccountId),
      isActive: false,
      updatedAt: now,
    })
    .returning({ id: marketplaceAccounts.id })
  const account = await getAccountById(db, organizationId, String(row.id))
  return account as MarketplaceAccount
}

// (org, marketplace) için TEK aktif hesabı döner (yoksa null). Reads/writes bu
// hesaba göre kapsamlanır.
export async function getActiveAccount(
  db: Db,
  organizationId: string,
  marketplace: string,
): Promise<MarketplaceAccount | null> {
  const rows = await db
    .select()
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.marketplace, marketplace),
        eq(marketplaceAccounts.isActive, true),
      ),
    )
    .limit(1)
  return (rows[0] as MarketplaceAccount) ?? null
}

// Tenant-scoped tekil hesap okuma (başka org'un hesabı ASLA dönmez).
export async function getAccountById(
  db: Db,
  organizationId: string,
  accountId: string,
): Promise<MarketplaceAccount | null> {
  const rows = await db
    .select()
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, accountId),
      ),
    )
    .limit(1)
  return (rows[0] as MarketplaceAccount) ?? null
}

export async function listAccounts(
  db: Db,
  organizationId: string,
  marketplace: string,
): Promise<MarketplaceAccount[]> {
  return db
    .select()
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.marketplace, marketplace),
      ),
    )
}

// Aktif hesabın sync metadata'sını günceller (yalnız 'success' son başarılı
// zamanı ilerletir; partial/failed BOZMAZ). integration_sync_state ile aynı
// no-regress sözleşmesi.
export async function updateAccountSyncMeta(
  db: Db,
  organizationId: string,
  accountId: string,
  entry: { status: 'success' | 'partial' | 'failed' },
): Promise<void> {
  const now = new Date()
  await db
    .update(marketplaceAccounts)
    .set({
      lastSyncStatus: entry.status,
      ...(entry.status === 'success' ? { lastSuccessfulSyncAt: now } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, accountId),
      ),
    )
}
