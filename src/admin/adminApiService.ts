// Platform admin frontend API servisi. Tüm çağrılar admin cookie'siyle
// (credentials:'include') aynı origin'e gider. Secret/hash frontend'e gelmez;
// admin yetkisi YALNIZ backend session'ından doğrulanır.
const BASE = '/api/platform-admin'

async function json<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T
}

export interface AdminUser {
  username: string
}

export interface OrganizationRow {
  organizationId: string
  name: string
  slug: string
  status: string
  username: string | null
  userId: string | null
  userStatus: string | null
  createdAt: string | null
  lastLoginAt: string | null
  onboardingCompleted: boolean
  trendyolConfigured: boolean
  suratConfigured: boolean
  productCount: number
  orderCount: number
  activeSessionCount: number
}

export interface AdminSummary {
  totalOrganizations: number
  activeOrganizations: number
  onboardingCompleted: number
  integrationIncomplete: number
}

export async function adminMe(): Promise<AdminUser | null> {
  const response = await fetch(`${BASE}/me`, { credentials: 'include' })
  if (!response.ok) return null
  const payload = await json<{ authenticated?: boolean; admin?: AdminUser }>(response)
  return payload.authenticated && payload.admin ? payload.admin : null
}

export async function adminLogin(
  username: string,
  password: string,
): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  })
  const payload = await json<{ ok?: boolean; message?: string }>(response)
  return { ok: response.ok && Boolean(payload.ok), message: payload.message }
}

export async function adminLogout(): Promise<void> {
  await fetch(`${BASE}/logout`, { method: 'POST', credentials: 'include' }).catch(
    () => undefined,
  )
}

export async function fetchSummary(): Promise<AdminSummary> {
  const response = await fetch(`${BASE}/summary`, { credentials: 'include' })
  const payload = await json<{ summary?: AdminSummary }>(response)
  return (
    payload.summary ?? {
      totalOrganizations: 0,
      activeOrganizations: 0,
      onboardingCompleted: 0,
      integrationIncomplete: 0,
    }
  )
}

export async function fetchOrganizations(params: {
  search?: string
  page?: number
  pageSize?: number
}): Promise<{ organizations: OrganizationRow[]; total: number; page: number; pageSize: number }> {
  const query = new URLSearchParams()
  if (params.search) query.set('search', params.search)
  if (params.page) query.set('page', String(params.page))
  if (params.pageSize) query.set('pageSize', String(params.pageSize))
  const response = await fetch(`${BASE}/organizations?${query.toString()}`, {
    credentials: 'include',
  })
  const payload = await json<{
    organizations?: OrganizationRow[]
    total?: number
    page?: number
    pageSize?: number
  }>(response)
  return {
    organizations: payload.organizations ?? [],
    total: Number(payload.total ?? 0),
    page: Number(payload.page ?? 1),
    pageSize: Number(payload.pageSize ?? 25),
  }
}

export async function createOrganization(input: {
  organizationName: string
  username: string
  password: string
}): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch(`${BASE}/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  })
  const payload = await json<{ ok?: boolean; message?: string }>(response)
  return { ok: response.ok && Boolean(payload.ok), message: payload.message }
}

export async function setOrganizationStatus(
  organizationId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch(`${BASE}/organizations/${organizationId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ status }),
  })
  const payload = await json<{ ok?: boolean; message?: string }>(response)
  return { ok: response.ok && Boolean(payload.ok), message: payload.message }
}

export async function setUserStatus(
  userId: string,
  status: 'ACTIVE' | 'DISABLED',
): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch(`${BASE}/users/${userId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ status }),
  })
  const payload = await json<{ ok?: boolean; message?: string }>(response)
  return { ok: response.ok && Boolean(payload.ok), message: payload.message }
}

export async function resetUserPassword(
  userId: string,
  password: string,
): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch(`${BASE}/users/${userId}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ password }),
  })
  const payload = await json<{ ok?: boolean; message?: string }>(response)
  return { ok: response.ok && Boolean(payload.ok), message: payload.message }
}

export async function revokeUserSessions(
  userId: string,
): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch(`${BASE}/users/${userId}/revoke-sessions`, {
    method: 'POST',
    credentials: 'include',
  })
  const payload = await json<{ ok?: boolean; message?: string }>(response)
  return { ok: response.ok && Boolean(payload.ok), message: payload.message }
}
