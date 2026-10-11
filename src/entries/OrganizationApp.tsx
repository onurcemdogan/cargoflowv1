// ORGANİZASYON UYGULAMASI GİRİŞİ (/app).
//
// Ağaç DEĞİŞMEDİ: AuthProvider → AuthGate → OnboardingGate → App. Kimlik,
// onboarding, ürün turu ve kiracı izolasyonu ATLANMAZ. Bu modül tembel
// yüklenir: tanıtım sayfası (/) operasyon kodunu ve genel stil sayfasını
// İNDİRMEZ.
import { useEffect } from 'react'
import '../index.css'
import App from '../App.tsx'
import { AuthProvider } from '../auth/AuthProvider.tsx'
import { AuthGate } from '../auth/AuthGate.tsx'
import { OnboardingGate } from '../onboarding/OnboardingGate.tsx'
import { APP_TITLE } from '../entryRoute.ts'

export default function OrganizationApp() {
  useEffect(() => {
    // Pazarlama başlığı uygulamada KALMAZ.
    document.title = APP_TITLE
  }, [])
  return (
    <AuthProvider>
      <AuthGate>
        <OnboardingGate>
          <App />
        </OnboardingGate>
      </AuthGate>
    </AuthProvider>
  )
}
