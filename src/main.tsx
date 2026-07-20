import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { AuthGate } from './auth/AuthGate.tsx'

// Uygulama kabuğu auth guard'ının arkasındadır: kullanıcı giriş yapmadan
// mevcut App (Dashboard/Orders/...) render edilmez.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  </StrictMode>,
)
