// TEST/GELİŞTİRME auth bypass'ı — VARSAYILAN KAPALI.
//
// Yalnız CARGOFLOW_AUTH_BYPASS=true verildiğinde etkinleşir. Amacı: kendi
// sunucunuzda hesap oluşturma/giriş akışıyla uğraşmadan uygulamayı uçtan uca
// test edebilmek. İşi bittiğinde env satırını silip PM2'yi restart etmeniz
// yeterlidir; hiçbir auth/tenant kodu SİLİNMEMİŞTİR.
//
// ÖNEMLİ TASARIM: Bypass "auth'u yok saymaz"; istekleri GERÇEK bir organization
// kullanıcısına bağlar. Böylece tenant izolasyonu, org-scoped sorgular,
// idempotency ve credential encryption aynen çalışmaya devam eder.
//
// ⚠ Gerçek müşteri verisiyle açık BIRAKMAYIN.
import { asc, eq } from 'drizzle-orm'
import { organizations, organizationSettings, users } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export function isAuthBypassEnabled(): boolean {
  return String(process.env.CARGOFLOW_AUTH_BYPASS ?? '').trim().toLowerCase() === 'true'
}

export interface BypassContext {
  userId: string
  organizationId: string
  username: string
  organizationName: string
  organizationSlug: string
}

let cached: BypassContext | null = null
let warned = false

function warnOnce(): void {
  if (warned) return
  warned = true
  console.warn(
    '[auth] ⚠ CARGOFLOW_AUTH_BYPASS=true — giriş ekranı atlanıyor ve istekler ' +
      'demo organization kullanıcısına bağlanıyor. YALNIZ TEST İÇİNDİR; ' +
      'gerçek veriyle kullanmayın. Kapatmak için env satırını silin.',
  )
}

// Bypass için gerçek bir organization + kullanıcı çözer. Sistemde organization
// varsa İLKİNİ kullanır (mevcut verinizi görürsünüz); yoksa boş bir demo
// organization oluşturur. Onboarding tamamlanmış işaretlenir ki doğrudan
// dashboard açılsın.
export async function resolveBypassContext(db: Db): Promise<BypassContext> {
  if (cached) return cached
  warnOnce()

  const existingOrgs = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
    })
    .from(organizations)
    .orderBy(asc(organizations.createdAt))
    .limit(1)

  let organizationId: string
  let organizationName: string
  let organizationSlug: string
  if (existingOrgs.length > 0) {
    organizationId = String(existingOrgs[0].id)
    organizationName = String(existingOrgs[0].name)
    organizationSlug = String(existingOrgs[0].slug)
  } else {
    organizationName = 'Demo Şirket'
    organizationSlug = 'demo-sirket'
    const [created] = await db
      .insert(organizations)
      .values({ name: organizationName, slug: organizationSlug, status: 'active' })
      .returning({ id: organizations.id })
    organizationId = String(created.id)
  }

  // Organization'ın kullanıcısı (org başına tek kullanıcı) — yoksa oluştur.
  const existingUsers = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.organizationId, organizationId))
    .limit(1)

  let userId: string
  let username: string
  if (existingUsers.length > 0) {
    userId = String(existingUsers[0].id)
    username = String(existingUsers[0].username)
  } else {
    // Normal giriş için KULLANILAMAZ bir placeholder hash (argon2 formatında
    // olmadığı için verifyPassword her zaman false döner). Bypass kapatılınca
    // bu hesapla giriş yapılamaz; parolayı CLI ile belirlemeniz gerekir.
    username = 'demo'
    const [created] = await db
      .insert(users)
      .values({
        organizationId,
        username,
        passwordHash: 'BYPASS_PLACEHOLDER_NOT_A_VALID_HASH',
        status: 'active',
      })
      .returning({ id: users.id })
    userId = String(created.id)
  }

  // Doğrudan dashboard açılsın: onboarding tamamlanmış say.
  await db
    .insert(organizationSettings)
    .values({ organizationId, onboardingCompleted: true, onboardingCompletedAt: new Date() })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { onboardingCompleted: true, updatedAt: new Date() },
    })

  cached = { userId, organizationId, username, organizationName, organizationSlug }
  return cached
}

// Test amaçlı önbellek sıfırlama.
export function resetBypassCache(): void {
  cached = null
  warned = false
}
