// UYGULAMA GİRİŞ KÖKÜ — yol düzeyi ayrım (bkz. `entryRoute.ts`).
//
// Tanıtım sayfası HEVESLE (küçük) yüklenir; organizasyon uygulaması ve
// yönetici kabuğu TEMBEL parçalardır. `/` açıldığında AuthProvider BAĞLANMAZ:
// `/api/auth/me`, onboarding, entegrasyon veya sağlayıcı çağrısı YAPILMAZ.
import { Suspense, lazy } from 'react'
import { resolveEntryRoute } from './entryRoute'
import { LandingPage } from './landing/LandingPage'

const OrganizationApp = lazy(() => import('./entries/OrganizationApp'))
const AdminEntry = lazy(() => import('./entries/AdminEntry'))

function EntryLoading() {
  // Genel stil sayfası henüz yüklenmedi: satır içi, sade bekleme görünümü.
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'system-ui, sans-serif',
        color: '#62707b',
      }}
    >
      Yükleniyor…
    </div>
  )
}

export function EntryRoot({ pathname }: { pathname: string }) {
  const route = resolveEntryRoute(pathname)
  if (route === 'landing') return <LandingPage />
  return (
    <Suspense fallback={<EntryLoading />}>
      {route === 'admin' ? <AdminEntry /> : <OrganizationApp />}
    </Suspense>
  )
}
