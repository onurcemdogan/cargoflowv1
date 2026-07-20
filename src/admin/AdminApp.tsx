// Platform admin uygulama kabuğu (/admin*). Organization AuthProvider/AppShell
// ile TAMAMEN AYRI. Yetki backend admin session'ından doğrulanır (GET
// /api/platform-admin/me); organization cookie'si admin erişimi sağlamaz.
import { useCallback, useEffect, useRef, useState } from 'react'
import { adminMe, type AdminUser } from './adminApiService'
import { AdminLoginPage } from './AdminLoginPage'
import { AdminDashboard } from './AdminDashboard'

type AdminState =
  | { phase: 'loading' }
  | { phase: 'login' }
  | { phase: 'ready'; admin: AdminUser }

export function AdminApp() {
  const [state, setState] = useState<AdminState>({ phase: 'loading' })
  const active = useRef(true)

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    adminMe()
      .then((admin) => {
        if (!active.current) return
        setState(admin ? { phase: 'ready', admin } : { phase: 'login' })
      })
      .catch(() => {
        if (active.current) setState({ phase: 'login' })
      })
  }, [])

  useEffect(() => {
    active.current = true
    adminMe()
      .then((admin) => {
        if (!active.current) return
        setState(admin ? { phase: 'ready', admin } : { phase: 'login' })
      })
      .catch(() => {
        if (active.current) setState({ phase: 'login' })
      })
    return () => {
      active.current = false
    }
  }, [])

  if (state.phase === 'loading') {
    return (
      <div className="admin-auth-screen" role="status" aria-live="polite">
        <span className="admin-brand-mark">CF</span>
        <span>Yönetici oturumu kontrol ediliyor…</span>
      </div>
    )
  }
  if (state.phase === 'login') {
    return <AdminLoginPage onLoggedIn={load} />
  }
  return (
    <AdminDashboard admin={state.admin} onLoggedOut={() => setState({ phase: 'login' })} />
  )
}
