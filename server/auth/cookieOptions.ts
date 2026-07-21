// Oturum cookie'si güvenlik seçenekleri (organization + platform admin ORTAK).
// HttpOnly ve SameSite=Lax DEĞİŞMEZ; yalnız `secure` bayrağı ortama göre
// çözülür:
//   - COOKIE_SECURE açıkça verilirse ona uyulur
//   - verilmezse production'da true (HTTPS varsayımı)
// Düz HTTP (http://SUNUCU_IP:8787) ile çalışırken COOKIE_SECURE=false ZORUNLUDUR;
// aksi halde tarayıcı Secure cookie'yi geri göndermez ve login başarılı görünse
// bile sonraki istekler 401 döner.
export function isCookieSecure(): boolean {
  const raw = String(process.env.COOKIE_SECURE ?? '').trim().toLowerCase()
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  return process.env.NODE_ENV === 'production'
}
