// GİRİŞ YOLU AYRIMI — React Router YOK; mevcut yol düzeyi ayrım genişletildi.
//
//   /admin*  → platform yönetici kabuğu (ÖNCELİK: değişmedi)
//   /        → HERKESE AÇIK tanıtım sayfası (kimlik/işlem çağrısı YOK)
//   /app     → organizasyon uygulaması (AuthProvider → AuthGate →
//              OnboardingGate → App), DEĞİŞMEDEN
//   diğer    → organizasyon uygulaması (mevcut davranış korunur: eskiden `/admin`
//              dışındaki HER yol uygulamayı açıyordu)

export type EntryRoute = 'landing' | 'app' | 'admin'

/** Tanıtım sayfasındaki "Panele Gir" hedefi. */
export const APP_ENTRY_PATH = '/app'

export function resolveEntryRoute(pathname: string): EntryRoute {
  const path = String(pathname ?? '')
  // Yönetici önceliği ESKİ kural ile BİREBİR aynı (`startsWith('/admin')`).
  if (path.startsWith('/admin')) return 'admin'
  if (path === '' || path === '/' || path === '/index.html') return 'landing'
  return 'app'
}

export const LANDING_TITLE = 'CargoFlow — E-ticaret Kargo Operasyon Paneli'
export const APP_TITLE = 'CargoFlow — Operasyon Paneli'
export const ADMIN_TITLE = 'CargoFlow — Platform Yönetimi'
