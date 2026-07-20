// Frontend onboarding servisi. Kaynak-of-truth backend'tir; onboardingCompleted
// frontend localStorage'da SAKLANMAZ. Legacy modda (backend 404) onboarding
// kavramı yoktur → null döner ve uygulama normal açılır.

export interface OnboardingSteps {
  trendyolConfigured: boolean
  trendyolConnectionVerified: boolean
  suratConfigured: boolean
  suratConnectionVerified: boolean
  productsSynced: boolean
  ordersSynced: boolean
}

export interface OnboardingStatus {
  completed: boolean
  steps: OnboardingSteps
  counts: { products: number; orders: number }
  suratVerificationNote?: string
}

export interface OnboardingCompleteResult {
  ok: boolean
  missing?: string[]
  status?: OnboardingStatus
}

// 401: organization oturumu geçersiz (expired/revoked/disabled/suspended).
// Çağıran taraf auth state'i temizleyip /login'e yönlendirmek için yakalar.
export class UnauthorizedError extends Error {
  status = 401
  constructor() {
    super('Organization oturumu geçersiz.')
    this.name = 'UnauthorizedError'
  }
}

// Backend durumu. 404 → legacy mod (onboarding yok) → null. 401 →
// UnauthorizedError. Diğer hatalar genel Error fırlatır.
export async function fetchOnboardingStatus(): Promise<OnboardingStatus | null> {
  const response = await fetch('/api/onboarding/status', {
    credentials: 'include',
  })
  if (response.status === 404) return null
  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) {
    throw new Error(`Onboarding durumu alınamadı (${response.status}).`)
  }
  const payload = (await response.json()) as Partial<OnboardingStatus> & {
    ok?: boolean
  }
  return {
    completed: Boolean(payload.completed),
    steps: (payload.steps ?? {
      trendyolConfigured: false,
      trendyolConnectionVerified: false,
      suratConfigured: false,
      suratConnectionVerified: false,
      productsSynced: false,
      ordersSynced: false,
    }) as OnboardingSteps,
    counts: payload.counts ?? { products: 0, orders: 0 },
    suratVerificationNote: payload.suratVerificationNote,
  }
}

export async function completeOnboarding(): Promise<OnboardingCompleteResult> {
  const response = await fetch('/api/onboarding/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    missing?: string[]
    steps?: OnboardingSteps
    counts?: { products: number; orders: number }
    completed?: boolean
  }
  if (response.ok && payload.ok) {
    return {
      ok: true,
      status: {
        completed: Boolean(payload.completed),
        steps: payload.steps as OnboardingSteps,
        counts: payload.counts ?? { products: 0, orders: 0 },
      },
    }
  }
  return { ok: false, missing: payload.missing ?? [] }
}
