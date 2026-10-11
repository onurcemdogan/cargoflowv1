// ÇALIŞMA ALANI (WORKSPACE) + ÜYELİK.
//
// Erişim yetkisinin kaynağı `organization_members`'tır. `users.organization_id`
// yalnız BİRİNCİL çalışma alanıdır: oturum açılınca hangi firmanın seçileceği.
//
// Self-service: e-postasını doğrulamış ve henüz HİÇBİR üyeliği olmayan kullanıcı
// TEK bir çalışma alanı oluşturur ve onun `owner`ı olur. İkinci çalışma alanı
// (çoklu firma) bu sürümde açılmaz — veri modeli engellemez.
import { and, asc, eq, isNull } from 'drizzle-orm'
import {
  organizationMembers,
  organizationSettings,
  organizations,
  sessions,
  users,
} from '../db/schema.ts'
import { hashSessionToken } from './session.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type MemberRole = 'owner' | 'admin' | 'member'

export const WORKSPACE_NAME_MAX = 120

export function slugifyWorkspaceName(value: string): string {
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

export async function uniqueOrganizationSlug(tx: Db, name: string): Promise<string> {
  const baseSlug = slugifyWorkspaceName(name)
  let slug = baseSlug
  for (let suffix = 2; suffix < 200; suffix += 1) {
    const clash = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1)
    if (clash.length === 0) return slug
    slug = `${baseSlug}-${suffix}`
  }
  return `${baseSlug}-${Date.now()}`
}

export async function addOrganizationMember(
  tx: Db,
  organizationId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await tx
    .insert(organizationMembers)
    .values({ organizationId, userId, role })
    .onConflictDoNothing({ target: [organizationMembers.organizationId, organizationMembers.userId] })
}

export async function listUserMemberships(
  db: Db,
  userId: string,
): Promise<Array<{ organizationId: string; role: MemberRole; active: boolean }>> {
  const rows = await db
    .select({
      organizationId: organizationMembers.organizationId,
      role: organizationMembers.role,
      status: organizations.status,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizationMembers.createdAt))
  return rows.map((row: Record<string, unknown>) => ({
    organizationId: String(row.organizationId),
    role: String(row.role) as MemberRole,
    active: String(row.status) === 'active',
  }))
}

export async function findMembershipRole(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<MemberRole | null> {
  const rows = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    .limit(1)
  return rows[0] ? (String(rows[0].role) as MemberRole) : null
}

/**
 * Oturum açılırken seçilecek çalışma alanı:
 *   1) birincil firma ÜYELİKLE doğrulanıyorsa o;
 *   2) değilse en eski AKTİF üyelik; yoksa en eski üyelik (askıdaki firma
 *      seçilir ki oturum doğrulaması onu yine REDDETSİN — askıya alınmış
 *      firmanın kullanıcısı "çalışma alanı yok" durumuna DÜŞMEZ);
 *   3) hiç üyelik yoksa ve birincil firma varsa: ESKİ hesap (üyelik tablosundan
 *      önce açılmış). Owner üyeliği yazılır ve o firma seçilir;
 *   4) hiçbiri yoksa null → çalışma alanı oluşturma ekranı.
 */
export async function resolveSessionOrganization(
  db: Db,
  userId: string,
  primaryOrganizationId: string | null,
): Promise<string | null> {
  const memberships = await listUserMemberships(db, userId)
  if (primaryOrganizationId && memberships.some((entry) => entry.organizationId === primaryOrganizationId)) {
    return primaryOrganizationId
  }
  if (memberships.length > 0) {
    return (memberships.find((entry) => entry.active) ?? memberships[0]).organizationId
  }
  if (primaryOrganizationId) {
    await addOrganizationMember(db, primaryOrganizationId, userId, 'owner')
    return primaryOrganizationId
  }
  return null
}

export type CreateWorkspaceResult =
  | { ok: true; organizationId: string; name: string; slug: string }
  | { ok: false; code: 'WORKSPACE_EXISTS' | 'INVALID_NAME' }

export function normalizeWorkspaceName(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Self-service çalışma alanı oluşturma — tek işlem:
 *   organizations + organization_members(owner) + organization_settings +
 *   users.organization_id (birincil) + mevcut oturumun organizasyonu.
 * Kullanıcının zaten bir üyeliği varsa oluşturulmaz (WORKSPACE_EXISTS).
 */
export async function createWorkspaceForUser(
  db: Db,
  params: { userId: string; sessionToken: string; name: unknown },
): Promise<CreateWorkspaceResult> {
  const name = normalizeWorkspaceName(params.name)
  if (name.length < 2 || name.length > WORKSPACE_NAME_MAX) return { ok: false, code: 'INVALID_NAME' }
  let result: CreateWorkspaceResult = { ok: false, code: 'WORKSPACE_EXISTS' }
  await db.transaction(async (tx: Db) => {
    // Aynı kullanıcının eşzamanlı iki isteği: kullanıcı satırı kilitlenir.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, params.userId)).for('update')
    const existing = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, params.userId))
      .limit(1)
    if (existing.length > 0) return
    const slug = await uniqueOrganizationSlug(tx, name)
    const [organization] = await tx
      .insert(organizations)
      .values({ name, slug, status: 'active' })
      .returning({ id: organizations.id })
    const organizationId = String(organization.id)
    await addOrganizationMember(tx, organizationId, params.userId, 'owner')
    await tx
      .insert(organizationSettings)
      .values({ organizationId, onboardingCompleted: false })
      .onConflictDoNothing({ target: organizationSettings.organizationId })
    await tx
      .update(users)
      .set({ organizationId, updatedAt: new Date() })
      .where(and(eq(users.id, params.userId), isNull(users.organizationId)))
    await tx
      .update(sessions)
      .set({ organizationId })
      .where(and(eq(sessions.tokenHash, hashSessionToken(params.sessionToken)), eq(sessions.userId, params.userId)))
    result = { ok: true, organizationId, name, slug }
  })
  return result
}

/* ─── İşletme profili ────────────────────────────────────────────────── */

export interface OrganizationProfile {
  name: string
  contactPhone: string | null
  addressLine: string | null
  city: string | null
  district: string | null
}

export const PROFILE_FIELD_LIMITS = {
  name: WORKSPACE_NAME_MAX,
  contactPhone: 32,
  addressLine: 300,
  city: 80,
  district: 80,
} as const

/** "İşletmenizi oluşturun" adımı: tüm zorunlu alanlar dolu mu? */
export function isOrganizationProfileComplete(profile: Partial<OrganizationProfile> | null | undefined): boolean {
  if (!profile) return false
  const filled = (value: unknown) => String(value ?? '').trim().length > 0
  const phoneDigits = String(profile.contactPhone ?? '').replace(/\D/g, '')
  return (
    filled(profile.name) &&
    phoneDigits.length >= 10 &&
    filled(profile.addressLine) &&
    filled(profile.city) &&
    filled(profile.district)
  )
}

export async function getOrganizationProfile(db: Db, organizationId: string): Promise<OrganizationProfile | null> {
  const rows = await db
    .select({
      name: organizations.name,
      contactPhone: organizations.contactPhone,
      addressLine: organizations.addressLine,
      city: organizations.city,
      district: organizations.district,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const text = (value: unknown) => (value == null ? null : String(value))
  return {
    name: String(row.name),
    contactPhone: text(row.contactPhone),
    addressLine: text(row.addressLine),
    city: text(row.city),
    district: text(row.district),
  }
}

export type ProfileValidation = { ok: true; profile: OrganizationProfile } | { ok: false; field: keyof OrganizationProfile; message: string }

export function validateOrganizationProfile(input: Record<string, unknown>): ProfileValidation {
  const clean = (value: unknown) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    return text.length === 0 ? null : text
  }
  const profile: OrganizationProfile = {
    name: normalizeWorkspaceName(input.name),
    contactPhone: clean(input.contactPhone),
    addressLine: clean(input.addressLine),
    city: clean(input.city),
    district: clean(input.district),
  }
  if (profile.name.length < 2) return { ok: false, field: 'name', message: 'Firma adı en az 2 karakter olmalıdır.' }
  for (const [field, limit] of Object.entries(PROFILE_FIELD_LIMITS) as Array<[keyof OrganizationProfile, number]>) {
    if (String(profile[field] ?? '').length > limit) {
      return { ok: false, field, message: 'Alan çok uzun.' }
    }
  }
  if (profile.contactPhone && !/^[+()\d\s-]{7,32}$/.test(profile.contactPhone)) {
    return { ok: false, field: 'contactPhone', message: 'Telefon numarası geçersiz.' }
  }
  return { ok: true, profile }
}

export async function updateOrganizationProfile(
  db: Db,
  organizationId: string,
  profile: OrganizationProfile,
): Promise<void> {
  await db
    .update(organizations)
    .set({ ...profile, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
}
