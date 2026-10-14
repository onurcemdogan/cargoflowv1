/** Small projection of persisted account evidence; credentials alone never say verified. */
export function AccountReadStatus({ isActive, configured, verificationStatus, ordersActive, verifying }: {
  isActive: boolean
  configured: boolean
  verificationStatus?: string
  ordersActive?: boolean
  verifying?: boolean
}) {
  const verified = isActive && configured && verificationStatus === 'verified'
  const status = verifying ? 'Doğrulanıyor…'
    : !isActive || !configured ? 'Bağlı değil'
    : verified ? 'Bağlı — Hesap doğrulandı'
    : verificationStatus === 'provider_unavailable' ? 'Bilgiler kaydedildi — Sağlayıcı geçici olarak kullanılamıyor'
    : verificationStatus === 'rate_limited' ? 'Bilgiler kaydedildi — İstek sınırına ulaşıldı'
    : verificationStatus === 'auth_failed' || verificationStatus === 'permission_denied' ? 'Doğrulama başarısız'
    : 'Bilgiler kaydedildi — Hesap doğrulanmadı'
  return <>
    <span role="status" data-verification-status={verificationStatus ?? 'unverified'}>{status}</span>
    <span>{verified && ordersActive && !verifying ? 'Siparişler aktif' : 'Siparişler pasif'}</span>
    {isActive && configured && !verified && !verifying ? <span>Test Et ile yeniden deneyebilirsiniz.</span> : null}
  </>
}
