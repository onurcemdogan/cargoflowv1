// Auth durumu sağlayıcısı. İlk açılışta GET /api/auth/me ile session geri
// yüklenir (tarayıcı refresh dahil). Logout sonrası tüm auth state temizlenir.
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  bootstrap,
  getCurrentUser,
  login,
  logout,
  type AuthError,
  type AuthUser,
} from './authService'

export type AuthStatus =
  | 'loading'
  | 'authenticated'
  | 'unauthenticated'
  | 'setup_required'

export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  error?: string
  // DATABASE_URL yokken backend 503 döner; kontrollü mesaj gösterilir.
  unavailableMessage?: string
  // Yalnız development + VITE_AUTH_DEV_BYPASS=true iken auth atlanır.
  devBypass: boolean
}

export interface AuthContextValue extends AuthState {
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  initializeOrganization: (
    organizationName: string,
    username: string,
    password: string,
  ) => Promise<void>
  refreshSession: () => Promise<void>
  requestSetup: () => void
  cancelSetup: () => void
}

// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
)

// Development bypass: varsayılan KAPALI; production build'de import.meta.env.DEV
// false olduğundan hiçbir koşulda çalışmaz.
function isDevBypassEnabled(): boolean {
  return (
    import.meta.env.DEV === true &&
    String(import.meta.env.VITE_AUTH_DEV_BYPASS ?? '') === 'true'
  )
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const devBypass = isDevBypassEnabled()
  const [state, setState] = useState<AuthState>(() => ({
    status: devBypass ? 'authenticated' : 'loading',
    user: null,
    devBypass,
  }))

  const applyCurrentUserResult = useCallback(
    (result: Awaited<ReturnType<typeof getCurrentUser>>): void => {
      if (result.kind === 'authenticated') {
        setState({ status: 'authenticated', user: result.user, devBypass })
        return
      }
      if (result.kind === 'unavailable') {
        setState({
          status: 'unauthenticated',
          user: null,
          unavailableMessage: result.message,
          devBypass,
        })
        return
      }
      setState({ status: 'unauthenticated', user: null, devBypass })
    },
    [devBypass],
  )

  const refreshSession = useCallback(async (): Promise<void> => {
    if (devBypass) return
    try {
      applyCurrentUserResult(await getCurrentUser())
    } catch (error) {
      setState({
        status: 'unauthenticated',
        user: null,
        error: (error as AuthError)?.message,
        devBypass,
      })
    }
  }, [applyCurrentUserResult, devBypass])

  // İlk açılış + tarayıcı refresh: session /api/auth/me ile geri yüklenir.
  // (setState yalnız async .then/.catch içinde; effect gövdesinde senkron
  // setState yok.)
  useEffect(() => {
    if (devBypass) return
    let active = true
    getCurrentUser()
      .then((result) => {
        if (active) applyCurrentUserResult(result)
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: 'unauthenticated',
            user: null,
            error: (error as AuthError)?.message,
            devBypass,
          })
        }
      })
    return () => {
      active = false
    }
  }, [applyCurrentUserResult, devBypass])

  const signIn = useCallback(
    async (username: string, password: string): Promise<void> => {
      await login(username, password)
      await refreshSession()
    },
    [refreshSession],
  )

  const signOut = useCallback(async (): Promise<void> => {
    await logout()
    // Tüm auth state temizlenir; iş verileri (orders/products storage,
    // IndexedDB, shipment/idempotency) bu turda SİLİNMEZ.
    setState({ status: 'unauthenticated', user: null, devBypass })
  }, [devBypass])

  const initializeOrganization = useCallback(
    async (
      organizationName: string,
      username: string,
      password: string,
    ): Promise<void> => {
      try {
        await bootstrap(organizationName, username, password)
      } catch (error) {
        if ((error as AuthError)?.status === 409) {
          // Kurulum zaten yapılmış: login ekranına geçir, mesajı taşı.
          setState({
            status: 'unauthenticated',
            user: null,
            error: 'Sistem kurulumu daha önce tamamlanmış. Giriş yapın.',
            devBypass,
          })
        }
        throw error
      }
      await refreshSession()
    },
    [devBypass, refreshSession],
  )

  const requestSetup = useCallback(() => {
    setState((current) => ({
      ...current,
      status: 'setup_required',
      error: undefined,
    }))
  }, [])

  const cancelSetup = useCallback(() => {
    setState((current) => ({
      ...current,
      status: 'unauthenticated',
      error: undefined,
    }))
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signIn,
      signOut,
      initializeOrganization,
      refreshSession,
      requestSetup,
      cancelSetup,
    }),
    [
      state,
      signIn,
      signOut,
      initializeOrganization,
      refreshSession,
      requestSetup,
      cancelSetup,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
