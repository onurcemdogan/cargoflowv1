import type { IntegrationConfig } from '../types/cargoflow.ts'
import type { MaskedIntegrationStatus } from '../services/integrationConfigService.ts'

// Provider "configured" durumunu MERKEZİ olarak hesaplar (tek kaynak; Dashboard
// health ve Entegrasyon sayfası aynı mantığı kullanır — kopya YOK).
//
// Kök sorun: auth modda güvenlik gereği gerçek apiKey/apiSecret/sifre frontend'e
// DÖNMEZ; sayfa yenilenince ham form alanları boştur. Bu yüzden "configured"
// kararı ham secret alanlarına BAKMAMALI — önce backend'in maskeli durum
// metadata'sı (secret İÇERMEZ, yalnız varlık bayrakları) kullanılır. Legacy modda
// (maskedStatus yok) ham form alanlarına düşülür.
//
// FirmaId temel Sürat bağlantısı için ZORUNLU DEĞİLDİR: KullanıcıAdı/CariKod +
// (Şifre veya WebPassword) yeterlidir.

export function resolveTrendyolConfigured(
  maskedStatus: MaskedIntegrationStatus | null | undefined,
  config: IntegrationConfig,
): boolean {
  const masked = maskedStatus?.trendyol
  if (masked) {
    return (
      masked.configured ||
      Boolean(masked.sellerId && masked.hasApiKey && masked.hasApiSecret)
    )
  }
  // Legacy / maskedStatus yok: ham form alanları.
  return Boolean(
    config.trendyol.sellerId &&
      config.trendyol.apiKey &&
      config.trendyol.apiSecret,
  )
}

export function resolveSuratConfigured(
  maskedStatus: MaskedIntegrationStatus | null | undefined,
  config: IntegrationConfig,
): boolean {
  const masked = maskedStatus?.surat
  if (masked) {
    return (
      masked.configured ||
      Boolean(
        (masked.customerCode || masked.cariKod) &&
          (masked.hasPassword || masked.hasWebPassword),
      )
    )
  }
  // Legacy / maskedStatus yok: ham form alanları (firmaId ZORUNLU değil).
  return Boolean(
    config.surat.kullaniciAdi &&
      (config.surat.sifre || config.surat.webPassword),
  )
}
