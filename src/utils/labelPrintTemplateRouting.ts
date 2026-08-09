// ETİKET BASKI ŞABLONU YÖNLENDİRMESİ — SAF (IO/DOM/ağ YOK).
//
// TEK KARAR NOKTASI. Siparişler, Sipariş Detayı ve Dashboard AYNI bu
// çözümleyiciyi kullanır; üç UI yüzeyinde aynı mantık KOPYALANMAZ.
import type { CargoOrder } from '../types/cargoflow'

export type LabelPrintTemplate = 'cargoflow_html' | 'surat_official_zpl'

/**
 * VARSAYILAN ŞABLON: resmî Sürat düzeni.
 *
 * Ana "Kargo Etiketi Oluştur ve Yazdır" aksiyonu ek bir şablon seçimi
 * İSTEMEDEN bu şablonu kullanır; backend tarafında akış create → artefakt →
 * composer uygunluk → (gerekirse) official_augmented fallback → render'dır.
 *
 * TAŞIYICI GÜVENLİĞİ BYPASS EDİLMEZ: seçimde Sürat dışı gönderi varsa
 * `resolveLabelPrintTemplateDecision` mevcut CargoFlow yoluna güvenle döner
 * (aşağıdaki `fallbackApplied` dalı). Varsayılan tercih yalnız Sürat
 * gönderilerinde etkilidir.
 */
export const DEFAULT_LABEL_PRINT_TEMPLATE: LabelPrintTemplate =
  'surat_official_zpl'

/** Alternatif (eski) şablon — Gelişmiş İşlemler altından seçilebilir. */
export const LEGACY_LABEL_PRINT_TEMPLATE: LabelPrintTemplate = 'cargoflow_html'

export const SURAT_ONLY_TEMPLATE_MESSAGE =
  'Resmî Sürat şablonu yalnız Sürat Kargo gönderilerinde kullanılabilir.'

export const SURAT_TEMPLATE_FALLBACK_NOTICE =
  'Seçimde Sürat dışı gönderi var; bu baskı CargoFlow şablonuyla yapıldı.'

export const CARGOFLOW_TEMPLATE_LABEL = 'CargoFlow Etiket Şablonu'
export const SURAT_TEMPLATE_LABEL = 'Resmî Sürat Etiket Şablonu'
export const CARGOFLOW_TEMPLATE_DESCRIPTION =
  'CargoFlow tarafından oluşturulan mevcut ürün detaylı etiket tasarımı.'
export const SURAT_TEMPLATE_DESCRIPTION =
  'Sürat Kargo’nun resmî etiket düzenini kullanır ve ürün bilgilerini alt alana ekler.'

export function normalizeLabelPrintTemplate(value: unknown): LabelPrintTemplate {
  // Her İKİ şablon da AÇIKÇA tanınır. Yalnız bilinmeyen/eksik değer varsayılana
  // düşer — aksi halde varsayılan değiştiğinde açık `cargoflow_html` seçimi de
  // sessizce Sürat'e dönerdi (Gelişmiş İşlemler menüsünü bozardı).
  if (value === 'surat_official_zpl') return 'surat_official_zpl'
  if (value === 'cargoflow_html') return 'cargoflow_html'
  return DEFAULT_LABEL_PRINT_TEMPLATE
}

/** Baskı alanındaki küçük gösterge metni. */
export function describeLabelPrintTemplate(
  template: LabelPrintTemplate,
): string {
  return template === 'surat_official_zpl'
    ? 'Şablon: Resmî Sürat'
    : 'Şablon: CargoFlow'
}

/**
 * Sipariş Sürat gönderisi mi? Mevcut ön kontrol kuralıyla AYNI: kargo firması
 * hiç belirtilmemişse (tek sağlayıcılı kurulum) Sürat sayılır.
 */
export function isSuratShipmentOrder(order: CargoOrder | undefined): boolean {
  if (!order) return false
  const provider = String(order.shipment?.provider ?? '').trim()
  if (provider) return /surat|sürat/i.test(provider)
  const carrier = String(order.cargoProviderName ?? '').trim()
  if (carrier) return /surat|sürat/i.test(carrier)
  return true
}

export interface LabelPrintTemplateDecision {
  template: LabelPrintTemplate
  /** Kullanıcı organizasyon varsayılanı yerine geçici seçim mi yaptı? */
  overridden: boolean
  /** Resmî Sürat istendi ama güvenli biçimde CargoFlow'a düşüldü. */
  fallbackApplied: boolean
  /** TEK kısa bilgi satırı (banner VEYA toast — ikisi birden DEĞİL). */
  notice?: string
  /** Açık kullanıcı seçimi uygulanamıyorsa güvenli hata (baskı yapılmaz). */
  blockedReason?: string
}

/**
 * AKSİYON NİYETİ — iki farklı kullanıcı niyeti AYRI otoriteye sahiptir.
 *
 *   'primary'  → "Kargo Etiketi Oluştur ve Yazdır" ana aksiyonu.
 *                Sürat gönderileri için HER ZAMAN resmî Sürat şablonu.
 *                Organizasyon ayarı / eski tercih bu kararı EZEMEZ.
 *   'advanced' → Gelişmiş İşlemler içinden AÇIK şablon seçimi.
 *                Yalnız o çalışmaya uygulanır, kalıcı tercih yazmaz.
 */
export type LabelPrintIntent = 'primary' | 'advanced'

export interface LabelPrintTemplateInput {
  /**
   * Organizasyon ayarı. YALNIZ 'advanced' niyetinde okunur; 'primary'
   * niyetinde bilinçli olarak YOK SAYILIR (bkz. resolver).
   */
  organizationTemplate?: unknown
  templateOverride?: LabelPrintTemplate
  orders: CargoOrder[]
  /** Verilmezse geriye uyumluluk için 'advanced' varsayılır. */
  intent?: LabelPrintIntent
}

/**
 * Sözleşme:
 *  - override yoksa organizasyon varsayılanı kullanılır.
 *  - resmî Sürat şablonu YALNIZ tüm seçim Sürat gönderisiyse kullanılır.
 *  - AÇIK kullanıcı seçimi uygulanamıyorsa güvenli HATA döner; sessizce
 *    başka bir şablonla basılmaz.
 *  - Organizasyon VARSAYILANI uygulanamıyorsa mevcut CargoFlow HTML yoluna
 *    güvenle düşülür ve kullanıcıya TEK kısa bilgi verilir.
 */
export function resolveLabelPrintTemplateDecision(
  input: LabelPrintTemplateInput,
): LabelPrintTemplateDecision {
  const organizationTemplate = normalizeLabelPrintTemplate(
    input.organizationTemplate,
  )
  const overridden = input.templateOverride !== undefined
  // ANA AKSİYON, ORGANİZASYON AYARINI OKUMAZ.
  //
  // Üretimde görülen hata tam olarak buydu: kayıtlı `cargoflow_html` tercihi
  // ana butonu sessizce eski şablona düşürüyordu. Kullanıcıya "varsayılan
  // şablon" seçtirip ana aksiyonun onu yok sayması yanıltıcı olacağı için
  // ayar normal Ayarlar ekranından da KALDIRILDI; burada yalnız açık
  // (advanced) seçim yolunda geriye uyumluluk için okunmaya devam eder.
  const requested = overridden
    ? normalizeLabelPrintTemplate(input.templateOverride)
    : input.intent === 'primary'
      ? DEFAULT_LABEL_PRINT_TEMPLATE
      : organizationTemplate

  if (requested !== 'surat_official_zpl') {
    return { template: 'cargoflow_html', overridden, fallbackApplied: false }
  }

  const nonSurat = input.orders.filter((order) => !isSuratShipmentOrder(order))
  if (nonSurat.length === 0) {
    return { template: 'surat_official_zpl', overridden, fallbackApplied: false }
  }
  if (overridden) {
    return {
      template: 'cargoflow_html',
      overridden,
      fallbackApplied: false,
      blockedReason: SURAT_ONLY_TEMPLATE_MESSAGE,
    }
  }
  return {
    template: 'cargoflow_html',
    overridden,
    fallbackApplied: true,
    notice: SURAT_TEMPLATE_FALLBACK_NOTICE,
  }
}
