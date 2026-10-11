// İşletme profili (PHASE2-B). Kiracı oturumdan gelir; organizationId
// GÖNDERİLMEZ. Onboarding'in "İşletmenizi oluşturun" adımı sunucuda bu
// alanların doluluğundan hesaplanır.
export interface OrganizationProfile {
  name: string
  contactPhone: string | null
  addressLine: string | null
  city: string | null
  district: string | null
}

export interface ProfileResult {
  profile: OrganizationProfile
  complete: boolean
}

export class ProfileSaveError extends Error {
  readonly field: string | null
  constructor(message: string, field: string | null) {
    super(message)
    this.field = field
  }
}

export async function fetchOrganizationProfile(): Promise<ProfileResult | null> {
  const response = await fetch('/api/organization/profile', { credentials: 'include' })
  if (!response.ok) return null
  const body = (await response.json().catch(() => null)) as (ProfileResult & { ok?: boolean }) | null
  return body?.profile ? { profile: body.profile, complete: body.complete === true } : null
}

export async function saveOrganizationProfile(profile: OrganizationProfile): Promise<ProfileResult> {
  const response = await fetch('/api/organization/profile', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  })
  const body = (await response.json().catch(() => null)) as
    | (ProfileResult & { ok?: boolean; message?: string; field?: string })
    | null
  if (!response.ok || !body?.profile) {
    throw new ProfileSaveError(body?.message ?? 'İşletme bilgileri kaydedilemedi.', body?.field ?? null)
  }
  return { profile: body.profile, complete: body.complete === true }
}
