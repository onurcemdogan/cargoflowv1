import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { AuthGate } from './auth/AuthGate.tsx'
import { OnboardingGate } from './onboarding/OnboardingGate.tsx'
import { AdminApp } from './admin/AdminApp.tsx'

// /admin* platform yönetici kabuğudur: organization AuthProvider/AppShell'den
// TAMAMEN ayrı bir ağaç render edilir. Diğer tüm yollar organization uygulaması
// (auth guard + onboarding kapısı arkasında).
const isAdminRoute = window.location.pathname.startsWith('/admin')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminRoute ? (
      <AdminApp />
    ) : (
      <AuthProvider>
        <AuthGate>
          <OnboardingGate>
            <App />
          </OnboardingGate>
        </AuthGate>
      </AuthProvider>
    )}
  </StrictMode>,
)
