import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { EntryRoot } from './EntryRoot.tsx'

// Yol düzeyi giriş ayrımı `entryRoute.ts` içindedir:
//   /admin* → platform yönetici kabuğu (organization AuthProvider'dan AYRI)
//   /       → herkese açık tanıtım sayfası (kimlik/işlem çağrısı YOK)
//   /app ve diğer yollar → organization uygulaması (auth guard + onboarding
//   kapısı arkasında, DEĞİŞMEDEN)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EntryRoot pathname={window.location.pathname} />
  </StrictMode>,
)
