// Platform admin yönetim sorguları. Organization/kullanıcı hesaplarını YÖNETİR
// ama tenant VERİSİNE (sipariş/müşteri/credential secret) DOKUNMAZ — yalnız
// sayaç/durum özetleri döner. Secret/passwordHash/raw credential ASLA dönmez.
import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  integrationCredentials,
  orders,
  organizations,
  organizationSettings,
  productVariants,
  sessions,
  users,
} from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

export function resolvePageSize(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

function slugify(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[çÇ]/g, 'c')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[ıİiI]/g, 'i')
    .replace(/[öÖ]/g, 'o')
    .replace(/[şŞ]/g, 's')
    .replace(/[üÜ]/g, 'u')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'org'
}

async function countByOrg(
  db: Db,
  table: any,
  orgIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (orgIds.length === 0) return map
  const rows = await db
    .select({
      organizationId: table.organizationId,
      value: sql`count(*)::int`,
    })
    .from(table)
    .where(inArray(table.organizationId, orgIds))
    .groupBy(table.organizationId)
  for (const row of rows) map.set(String(row.organizationId), Number(row.value))
  return map
}

export async function listOrganizations(
  db: Db,
  filters: { search?: string; page?: unknown; pageSize?: unknown } = {},
): Promise<{
  organizations: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}> {
  const pageSize = resolvePageSize(filters.pageSize)
  const page = Math.max(1, Math.trunc(Number(filters.page ?? 1)) || 1)
  const search = String(filters.search ?? '').trim()
  const where = search
    ? or(
        ilike(organizations.name, `%${search}%`),
        ilike(organizations.slug, `%${search}%`),
        ilike(users.username, `%${search}%`),
      )
    : undefined

  const baseRows = await db
    .select({
      organizationId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      status: organizations.status,
      createdAt: organizations.createdAt,
      userId: users.id,
      username: users.username,
      userStatus: users.status,
      lastLoginAt: users.lastLoginAt,
    })
    .from(organizations)
    .leftJoin(users, eq(users.organizationId, organizations.id))
    .where(where)
    .orderBy(asc(organizations.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  const totalRows = await db
    .select({ value: sql`count(*)::int` })
    .from(organizations)
    .leftJoin(users, eq(users.organizationId, organizations.id))
    .where(where)

  const orgIds = baseRows.map((row: { organizationId: string }) => String(row.organizationId))

  const [productCounts, orderCounts, settingsRows, credentialRows, sessionRows] =
    await Promise.all([
      countByOrg(db, productVariants, orgIds),
      countByOrg(db, orders, orgIds),
      orgIds.length
        ? db
            .select({
              organizationId: organizationSettings.organizationId,
              onboardingCompleted: organizationSettings.onboardingCompleted,
            })
            .from(organizationSettings)
            .where(inArray(organizationSettings.organizationId, orgIds))
        : [],
      orgIds.length
        ? db
            .select({
              organizationId: integrationCredentials.organizationId,
              provider: integrationCredentials.provider,
            })
            .from(integrationCredentials)
            .where(inArray(integrationCredentials.organizationId, orgIds))
        : [],
      orgIds.length
        ? db
            .select({
              organizationId: sessions.organizationId,
              value: sql`count(*)::int`,
            })
            .from(sessions)
            .where(
              and(
                inArray(sessions.organizationId, orgIds),
                isNull(sessions.revokedAt),
                sql`${sessions.expiresAt} > now()`,
              ),
            )
            .groupBy(sessions.organizationId)
        : [],
    ])

  const onboardingByOrg = new Map<string, boolean>()
  for (const row of settingsRows) {
    onboardingByOrg.set(String(row.organizationId), Boolean(row.onboardingCompleted))
  }
  const trendyolByOrg = new Set<string>()
  const suratByOrg = new Set<string>()
  for (const row of credentialRows) {
    if (String(row.provider) === 'trendyol') trendyolByOrg.add(String(row.organizationId))
    if (String(row.provider) === 'surat') suratByOrg.add(String(row.organizationId))
  }
  const sessionByOrg = new Map<string, number>()
  for (const row of sessionRows) {
    sessionByOrg.set(String(row.organizationId), Number(row.value))
  }

  return {
    organizations: baseRows.map((row: Record<string, unknown>) => {
      const orgId = String(row.organizationId)
      return {
        organizationId: orgId,
        name: String(row.name),
        slug: String(row.slug),
        status: String(row.status),
        username: row.username ? String(row.username) : null,
        userId: row.userId ? String(row.userId) : null,
        userStatus: row.userStatus ? String(row.userStatus) : null,
        createdAt: row.createdAt ? new Date(String(row.createdAt)).toISOString() : null,
        lastLoginAt: row.lastLoginAt
          ? new Date(String(row.lastLoginAt)).toISOString()
          : null,
        onboardingCompleted: onboardingByOrg.get(orgId) ?? false,
        trendyolConfigured: trendyolByOrg.has(orgId),
        suratConfigured: suratByOrg.has(orgId),
        productCount: productCounts.get(orgId) ?? 0,
        orderCount: orderCounts.get(orgId) ?? 0,
        activeSessionCount: sessionByOrg.get(orgId) ?? 0,
      }
    }),
    total: Number(totalRows[0]?.value ?? 0),
    page,
    pageSize,
  }
}

// Tek transaction: organization + user + organization_settings. Yeni hesap
// ACTIVE org, ACTIVE user, onboarding_completed=false, boş katalog/sipariş.
export async function createOrganizationWithUser(
  db: Db,
  input: { organizationName: string; username: string; passwordHash: string },
): Promise<{ organizationId: string; userId: string }> {
  let result: { organizationId: string; userId: string } | null = null
  await db.transaction(async (tx: Db) => {
    const baseSlug = slugify(input.organizationName)
    let slug = baseSlug
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const clash = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1)
      if (clash.length === 0) break
      slug = `${baseSlug}-${suffix}`
    }
    const [organization] = await tx
      .insert(organizations)
      .values({ name: input.organizationName, slug, status: 'active' })
      .returning()
    const [user] = await tx
      .insert(users)
      .values({
        organizationId: String(organization.id),
        username: input.username,
        passwordHash: input.passwordHash,
        status: 'active',
      })
      .returning()
    await tx
      .insert(organizationSettings)
      .values({ organizationId: String(organization.id), onboardingCompleted: false })
      .onConflictDoNothing({ target: organizationSettings.organizationId })
    result = {
      organizationId: String(organization.id),
      userId: String(user.id),
    }
  })
  if (!result) throw new Error('Organization oluşturulamadı.')
  return result
}

export async function findUserByUsername(
  db: Db,
  username: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1)
  return rows[0] ?? null
}

export async function setOrganizationStatus(
  db: Db,
  organizationId: string,
  status: 'active' | 'suspended',
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .update(organizations)
    .set({ status, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id })
  return rows[0] ?? null
}

export async function setUserStatus(
  db: Db,
  userId: string,
  status: 'active' | 'disabled',
): Promise<{ userId: string; organizationId: string } | null> {
  const rows = await db
    .update(users)
    .set({ status, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id, organizationId: users.organizationId })
  const row = rows[0]
  return row ? { userId: String(row.id), organizationId: String(row.organizationId) } : null
}

export async function getUserById(
  db: Db,
  userId: string,
): Promise<{ userId: string; organizationId: string } | null> {
  const rows = await db
    .select({ id: users.id, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const row = rows[0]
  return row ? { userId: String(row.id), organizationId: String(row.organizationId) } : null
}

export async function updateUserPasswordHash(
  db: Db,
  userId: string,
  passwordHash: string,
): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id })
  return rows.length > 0
}

// Bir organization'ın TÜM aktif kullanıcı oturumlarını revoke eder. Veri
// SİLİNMEZ; yalnız session'lar sonlandırılır. Revoke edilen sayısı döner.
export async function revokeOrganizationSessions(
  db: Db,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.organizationId, organizationId),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id })
  return rows.length
}

export async function revokeUserSessions(
  db: Db,
  userId: string,
): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id })
  return rows.length
}

export interface AdminDashboardSummary {
  totalOrganizations: number
  activeOrganizations: number
  onboardingCompleted: number
  integrationIncomplete: number
}

export async function getDashboardSummary(db: Db): Promise<AdminDashboardSummary> {
  const totalRows = await db
    .select({ value: sql`count(*)::int` })
    .from(organizations)
  const activeRows = await db
    .select({ value: sql`count(*)::int` })
    .from(organizations)
    .where(eq(organizations.status, 'active'))
  const onboardingRows = await db
    .select({ value: sql`count(*)::int` })
    .from(organizationSettings)
    .where(eq(organizationSettings.onboardingCompleted, true))
  const total = Number(totalRows[0]?.value ?? 0)
  const onboardingCompleted = Number(onboardingRows[0]?.value ?? 0)
  return {
    totalOrganizations: total,
    activeOrganizations: Number(activeRows[0]?.value ?? 0),
    onboardingCompleted,
    // Entegrasyonu eksik ≈ onboarding tamamlamamış hesaplar.
    integrationIncomplete: Math.max(0, total - onboardingCompleted),
  }
}
