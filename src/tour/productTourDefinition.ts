// ÜRÜN TURU — v1 TANIMI.
//
// Bu ONBOARDING DEĞİLDİR. Onboarding "bu organizasyon çalışabilir mi?"
// sorusunu yanıtlar; ürün turu yalnız "ana ekranlar nerede ve ne işe yarar?"
// sorusunu yanıtlar. Tur HİÇBİR işlem yapmaz: yalnız mevcut sayfa
// navigasyonunu kullanır ve açıklar.
//
// HEDEF SÖZLEŞMESİ: hedefler yalnız açık `data-tour="<kimlik>"` öznitelikleridir.
// Metin, sınıf sırası veya `:nth-child` KULLANILMAZ.
import type { PageKey } from '../types/cargoflow'

/** Sabit ürün sürümü — git commit'ine BAĞLI DEĞİL. */
export const PRODUCT_TOUR_VERSION = 'v1' as const

export interface ProductTourStep {
  id: string
  /** Mevcut navigasyon anahtarı (AppShell `navItems` ile AYNI sözlük). */
  page: PageKey
  /** `data-tour` kimliği; `null` → ortalanmış açıklama (hedefsiz). */
  target: string | null
  title: string
  body: string
}

const TARGET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Hedef seçicisinin TEK üreticisi: yalnız `[data-tour="…"]`. Kimlik biçimi
 * doğrulanır; serbest CSS seçicisi kabul edilmez.
 */
export function tourTargetSelector(target: string): string {
  if (!TARGET_ID.test(target)) {
    throw new Error(`Geçersiz tur hedefi: ${target}`)
  }
  return `[data-tour="${target}"]`
}

export const PRODUCT_TOUR_V1: readonly ProductTourStep[] = [
  {
    id: 'welcome',
    page: 'dashboard',
    target: null,
    title: "CargoFlow'a hoş geldiniz",
    body:
      'CargoFlow, pazaryeri siparişlerinizi kargo ve etiket akışına bağlayan operasyon panelidir. ' +
      'Bu kısa tur ana ekranları tanıtır; hiçbir işlem yapmaz.',
  },
  {
    id: 'dashboard',
    page: 'dashboard',
    target: 'dashboard-overview',
    title: 'Dashboard',
    body: 'Operasyon yoğunluğunu, bekleyen işlemleri ve bağlantı durumunu buradan takip edersiniz.',
  },
  {
    id: 'orders',
    page: 'orders',
    target: 'orders-workspace',
    title: 'Siparişler',
    body: 'Siparişlerin kargo, etiket ve işlem durumlarını yönettiğiniz ana çalışma alanıdır.',
  },
  {
    id: 'products',
    page: 'products',
    target: 'products-catalog',
    title: 'Ürünler',
    body:
      'Bağlı satış kanalındaki ürün ve varyant kataloğunu burada görüntüler ve senkronize edersiniz.',
  },
  {
    id: 'cargo',
    page: 'cargo',
    target: 'cargo-operations',
    title: 'Kargo İşlemleri',
    body: 'Seçili siparişlerin gönderi, takip ve etiket işlemlerini bu ekrandan kontrol edersiniz.',
  },
  {
    id: 'label-templates',
    page: 'labelTemplates',
    target: 'label-templates',
    title: 'Etiket Şablonları',
    body:
      'Etiket yerleşimini gerçek sipariş verisiyle önizler ve düzenlersiniz. Kaydetmek, yayınlamak anlamına gelmez.',
  },
  {
    id: 'integrations',
    page: 'integrations',
    target: 'integrations-settings',
    title: 'Entegrasyonlar / Ayarlar',
    body: 'Pazaryeri ve kargo bağlantılarınızı, gönderi ayarlarınızı buradan yönetirsiniz.',
  },
]
