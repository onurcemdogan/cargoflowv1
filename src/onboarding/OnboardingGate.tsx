// Authenticated kullanıcı ile App arasındaki onboarding kapısı. Kaynak-of-truth
// backend'tir: her açılış/refresh'te GET /api/onboarding/status ile yeniden
// hesaplanır (frontend localStorage'da onboardingCompleted SAKLANMAZ). Gereksiz
// sürekli polling YOK — yalnız mount + kullanıcı değişiminde ve tamamlanınca.
// Legacy modda (backend 404) onboarding yoktur → App doğrudan açılır.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/useAuth'
import {
  fetchOnboardingStatus,
  type OnboardingStatus,
} from '../services/onboardingService'
import { OnboardingPage } from '../pages/OnboardingPage'

type GateState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'skip' } // legacy (404) → onboarding yok
  | { phase: 'onboarding'; status: OnboardingStatus }
  | { phase: 'done' }

export function OnboardingGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  // Dev bypass'ta backend yoktur; onboarding atlanır (ilk durum lazy hesaplanır,
  // effect gövdesinde senkron setState yapılmaz).
  const [state, setState] = useState<GateState>(() =>
    auth.devBypass ? { phase: 'skip' } : { phase: 'loading' },
  )
  const active = useRef(true)

  // Durum uygulama yardımcıları (setState yalnız async .then/.catch içinde
  // çağrılır; effect gövdesinde senkron setState yapılmaz).
  const applyStatus = useCallback((status: OnboardingStatus | null) => {
    if (!active.current) return
    if (status === null) {
      setState({ phase: 'skip' })
      return
    }
    setState(
      status.completed ? { phase: 'done' } : { phase: 'onboarding', status },
    )
  }, [])

  // Yeniden dene butonu için: loading göster, sonra tekrar sorgula.
  const load = useCallback(() => {
    setState({ phase: 'loading' })
    fetchOnboardingStatus()
      .then(applyStatus)
      .catch(() => {
        if (active.current) setState({ phase: 'error' })
      })
  }, [applyStatus])

  useEffect(() => {
    active.current = true
    // Dev bypass: onboarding atlanır, backend sorgulanmaz.
    if (!auth.devBypass) {
      fetchOnboardingStatus()
        .then((status) => {
          if (active.current) applyStatus(status)
        })
        .catch(() => {
          if (active.current) setState({ phase: 'error' })
        })
    }
    return () => {
      active.current = false
    }
    // auth.user değişince (login/logout/refresh) yeniden hesaplanır.
  }, [auth.devBypass, auth.user, applyStatus])

  if (state.phase === 'loading') {
    return (
      <div className="auth-loading-screen" role="status" aria-live="polite">
        <div className="auth-brand-mark">CF</div>
        <span>Kurulum durumu kontrol ediliyor…</span>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className="auth-loading-screen" role="alert">
        <div className="auth-brand-mark">CF</div>
        <span>Kurulum durumu alınamadı.</span>
        <button type="button" onClick={() => void load()}>
          Tekrar Dene
        </button>
      </div>
    )
  }
  if (state.phase === 'onboarding') {
    return (
      <OnboardingPage
        initialStatus={state.status}
        onCompleted={() => setState({ phase: 'done' })}
      />
    )
  }
  // skip (legacy) veya done → normal uygulama.
  return <>{children}</>
}
