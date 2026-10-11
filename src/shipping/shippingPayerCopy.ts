// KARGO ÜCRETİNİ KİM ÖDER — SUNUM KATMANI (SAF).
//
// ═══ ABONELİKLE KARIŞTIRILMAMALI ═════════════════════════════════════════
//
// `src/subscription/*` CargoFlow PLANIDIR. Bu dosya GÖNDERİ ÜCRETİNİN
// ödeyenidir. Aynı ekranda yan yana görünseler bile AYRI kavramlardır.
//
// ═══ OTOMATİK SEÇİM YOK ══════════════════════════════════════════════════
//
// Taşıyıcıya (Aras/Sürat) bakıp "herhalde satıcı ödüyor" diye ÖN SEÇİM
// YAPILMAZ. Yanlış ön seçim, yanlış cariye fatura demektir.

export type ShippingPayerValue = 'MARKETPLACE_PAYS' | 'SELLER_PAYS' | 'UNKNOWN'

export interface PayerOption {
  value: ShippingPayerValue
  label: string
}

/** Seçenekler — hiçbiri VARSAYILAN olarak işaretli değildir. */
export const PAYER_OPTIONS: readonly PayerOption[] = [
  { value: 'MARKETPLACE_PAYS', label: 'Pazaryeri ödüyor' },
  { value: 'SELLER_PAYS', label: 'Satıcı ödüyor' },
  { value: 'UNKNOWN', label: 'Bilinmiyor / seçilmedi' },
]

export const PAYER_QUESTION = 'Kargo ücretini kim ödüyor?'

/** Neden sorulduğu — spekülatif özellik vaadi İÇERMEZ. */
export const PAYER_HELP_TEXT =
  'Etiket ve kargo oluşturma yöntemi bu sözleşme tipine göre değişebilir.'

export interface PayerFieldState {
  question: string
  helpText: string
  options: readonly PayerOption[]
  /** Seçili değer; hiçbir zaman OTOMATİK doldurulmaz. */
  selected: ShippingPayerValue
  /** Alan operatöre gösterilmeli mi. */
  visible: boolean
  /** Bu pazaryeri için neden soruluyor. */
  reasonText: string | null
  /** Ödeyen kesinliği gerektiren akışlar için engel var mı. */
  blocksRouting: boolean
}

/**
 * Alan durumunu üretir.
 *
 * `CAN_DERIVE_FROM_ORDER` olan pazaryerinde (Trendyol) alan GİZLENİR: gerçek
 * siparişin kendisinden gelir, operatöre sormak yanlış cevabı davet eder.
 */
export function buildPayerField(params: {
  evidenceClass: 'CAN_DERIVE_FROM_ORDER' | 'ACCOUNT_CONFIG_REQUIRED' | 'NOT_VERIFIED'
  currentValue?: ShippingPayerValue | null
}): PayerFieldState {
  const selected = params.currentValue ?? 'UNKNOWN'
  if (params.evidenceClass === 'CAN_DERIVE_FROM_ORDER') {
    return {
      question: PAYER_QUESTION,
      helpText: PAYER_HELP_TEXT,
      options: PAYER_OPTIONS,
      selected,
      visible: false,
      reasonText: 'Bu pazaryerinde ödeyen bilgisi siparişin kendisinden okunuyor.',
      blocksRouting: false,
    }
  }
  return {
    question: PAYER_QUESTION,
    helpText: PAYER_HELP_TEXT,
    options: PAYER_OPTIONS,
    selected,
    visible: true,
    reasonText:
      'Bu pazaryerinde ödeyen bilgisi sipariş verisinden doğrulanamıyor; hesap bazında seçilmelidir.',
    // Seçilmediyse ödeyen kesinliği gerektiren akış AÇILMAZ.
    blocksRouting: selected === 'UNKNOWN',
  }
}

/** Çözümlenmiş ödeyenin operatöre gösterimi. */
export function presentResolvedPayer(result: {
  payer: ShippingPayerValue
  provenance: string
}): { text: string; sourceText: string } {
  const payerText =
    result.payer === 'MARKETPLACE_PAYS'
      ? 'Pazaryeri ödüyor'
      : result.payer === 'SELLER_PAYS'
        ? 'Satıcı ödüyor'
        : 'Bilinmiyor'
  const sourceText =
    result.provenance === 'ORDER_CONTRACT'
      ? 'Sipariş verisinden'
      : result.provenance === 'ACCOUNT_CONFIG'
        ? 'Hesap ayarından'
        : result.provenance === 'TENANT_CONFIG'
          ? 'Varsayılan ayardan'
          : 'Kaynak yok'
  return { text: payerText, sourceText }
}
