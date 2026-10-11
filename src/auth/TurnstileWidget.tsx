// CLOUDFLARE TURNSTILE — açık (explicit) çizim.
//
// Resmî istemci sözleşmesi (developers.cloudflare.com/turnstile/get-started/client-side-rendering):
//   script: https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit
//   turnstile.render(kap, { sitekey, callback, 'error-callback',
//                           'expired-callback', appearance, theme })
//   turnstile.reset(id) · turnstile.remove(id)
//
// `appearance: 'interaction-only'`: widget YALNIZ etkileşim gerektiğinde
// görünür; çoğu kullanıcı bulmaca görmez. Token tek kullanımlıktır, her
// gönderimden sonra `resetKey` artırılarak yenisi alınır.
//
// Site anahtarı yoksa (yerel geliştirme) hiçbir şey çizilmez ve sunucu da
// doğrulamayı atlar; production'da anahtar yoksa signup zaten kapalıdır.
import { useEffect, useRef } from 'react'

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')))
    script.onerror = () => {
      scriptPromise = null
      reject(new Error('turnstile'))
    }
    document.head.appendChild(script)
  })
  return scriptPromise
}

export function TurnstileWidget({
  siteKey,
  onToken,
  resetKey = 0,
}: {
  siteKey: string | null
  onToken: (token: string) => void
  /** Değişince widget sıfırlanır (token tek kullanımlıktır). */
  resetKey?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetRef = useRef<string | null>(null)
  const onTokenRef = useRef(onToken)

  useEffect(() => {
    onTokenRef.current = onToken
  }, [onToken])

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return
        widgetRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          appearance: 'interaction-only',
          theme: 'auto',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(''),
          'error-callback': () => onTokenRef.current(''),
        })
      })
      .catch(() => onTokenRef.current(''))
    return () => {
      cancelled = true
      if (widgetRef.current && window.turnstile) window.turnstile.remove(widgetRef.current)
      widgetRef.current = null
    }
  }, [siteKey])

  useEffect(() => {
    if (resetKey > 0 && widgetRef.current && window.turnstile) {
      window.turnstile.reset(widgetRef.current)
      onTokenRef.current('')
    }
  }, [resetKey])

  if (!siteKey) return null
  return <div className="auth-turnstile" ref={containerRef} />
}
