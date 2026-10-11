// "Operasyon ayarlarını doğrulayın" — her etkin satış hesabının siparişi hangi
// kargo hesabıyla ve hangi ödeyen kuralıyla gönderilecek? Durum SUNUCUDAN
// gelir; çözülemeyen satırda gönderi oluşturulmaz.
import type { OnboardingOperationsAccount } from '../services/onboardingService'

const CARRIER_ERRORS: Record<string, string> = {
  CARRIER_ACCOUNT_NOT_CONFIGURED: 'Kargo hesabı bağlı değil',
  CARRIER_ACCOUNT_DISABLED: 'Eşlenen kargo hesabı kapalı',
  CARRIER_MAPPING_PROVIDER_MISMATCH: 'Eşlenen hesap başka bir kargo firmasına ait',
  CARRIER_ACCOUNT_AMBIGUOUS: 'Birden çok kargo hesabı var; hangisinin kullanılacağını seçin',
}

const SOURCE_LABELS: Record<string, string> = {
  EXPLICIT_MAPPING: 'açık eşleme',
  ONLY_ACCOUNT_FOR_PROVIDER: 'tek kargo hesabınız',
}

export function OperationsStep({
  resolved,
  accounts,
}: {
  resolved: boolean
  accounts: OnboardingOperationsAccount[]
}) {
  return (
    <div className="onboarding-card">
      <h2>Operasyon Ayarları</h2>
      <p>
        Her satış hesabının siparişleri hangi kargo hesabıyla gönderilecek ve kargo ücretini kimin
        ödediği nasıl belirlenecek — kesin değilse gönderi oluşturulmaz.
      </p>
      {accounts.length === 0 ? (
        <p className="onboarding-warn">Önce satış kanalınızı ve kargo hesabınızı bağlayın.</p>
      ) : (
        <ul className="onboarding-operations" aria-label="Satış hesapları">
          {accounts.map((account) => (
            <li key={account.marketplaceAccountId ?? account.providerKey}>
              <b>{account.displayName}</b>
              <span className={account.carrier.ok ? 'onboarding-ok' : 'onboarding-warn'}>
                {account.carrier.ok
                  ? `Kargo: ${account.carrier.carrierName} (${SOURCE_LABELS[account.carrier.source] ?? account.carrier.source})`
                  : `Kargo: ${CARRIER_ERRORS[account.carrier.code] ?? 'Kargo hesabı çözülemedi'}`}
              </span>
              <span className={account.payer.ok ? 'onboarding-ok' : 'onboarding-warn'}>
                {account.payer.source === 'ORDER_CONTRACT'
                  ? 'Ödeyen: her siparişte pazaryerinin gönderdiği sözleşme bilgisinden'
                  : account.payer.source === 'ACCOUNT_CONFIG'
                    ? 'Ödeyen: hesap ayarından'
                    : 'Ödeyen: belirlenmedi — Entegrasyonlar › Kargo ücreti ödeyeni'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {resolved ? (
        <p className="onboarding-ok">Operasyon ayarları tamam.</p>
      ) : (
        <p className="onboarding-note">
          Eksikleri Entegrasyonlar ekranında tamamlayın; durum buradan yeniden okunur.
        </p>
      )}
    </div>
  )
}
