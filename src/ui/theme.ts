// UYGULAMA TEMASI — koyu (varsayılan) / açık.
//
// Tercih yalnız bu tarayıcıda, kullanıcı kolaylığı olarak saklanır; iş
// verisi DEĞİLDİR. Depo erişilemezse (gizli pencere, engelli site verisi)
// koyu tema kullanılır ve hata yutulur.
import { useCallback, useState } from 'react'

export type AppTheme = 'dark' | 'light'

const STORAGE_KEY = 'cargoflow.theme'

function readStoredTheme(): AppTheme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function applyTheme(theme: AppTheme) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
}

/** Uygulama girişinde bir kez çağrılır; ilk boyamada doğru tema görünür. */
export function applyStoredTheme(): AppTheme {
  const theme = typeof window === 'undefined' ? 'dark' : readStoredTheme()
  applyTheme(theme)
  return theme
}

export function useTheme(): [AppTheme, (next: AppTheme) => void] {
  const [theme, setThemeState] = useState<AppTheme>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
      ? 'light'
      : 'dark',
  )
  const setTheme = useCallback((next: AppTheme) => {
    setThemeState(next)
    applyTheme(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Tercih kaydedilemedi; tema bu oturumda yine de uygulanır.
    }
  }, [])
  return [theme, setTheme]
}
