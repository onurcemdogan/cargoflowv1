// KARGO ÜCRETİNİ KİM ÖDER — SAĞLAYICI-NÖTR KANONİK ÇÖZÜMLEYİCİ.
//
// ═══ BU DOSYA ABONELİKLE İLGİLİ DEĞİLDİR ═════════════════════════════════
//
// `server/subscription/*` CargoFlow'un KENDİ PLANIDIR. Bu dosya GÖNDERİ
// ÜCRETİNİ kimin ödediğidir. İkisi ASLA birbirini etkilemez ve bu ayrım
// testle kilitlidir (BP-14/BP-15).
//
// ═══ MEVCUT KANITLANMIŞ MODELİ SİLMEZ, SARAR ═════════════════════════════
//
// `suratBillingParty.ts` forensic audit ile doğrulanmış bir modeldir:
//
//   BILLING_PARTIES = ['SELLER', 'TRENDYOL', 'UNKNOWN']
//   Trendyol sözleşmesi: `whoPays` own-property = '1' → SELLER öder
//                        `whoPays` property YOK       → TRENDYOL öder
//                        diğer her şey                → UNKNOWN
//
// O modül ÜRETİMDE ÇALIŞIR ve DEĞİŞTİRİLMEZ. Burada yapılan tek şey, onun
// TRENDYOL'A ÖZEL sonucunu SAĞLAYICI-NÖTR bir kanona çevirmek ve n11 /
// Hepsiburada / manuel gibi doğrulanmış sinyali OLMAYAN pazaryerleri için
// hesap bazlı yapılandırmayı devreye almaktır.
//
// ═══ SAĞLAYICI ADI KANIT DEĞİLDİR ════════════════════════════════════════
//
// Aras/Sürat'ın varlığı kimin ödediğini KANITLAMAZ. Taşıyıcı kimliğinden
// ödeyen çıkarımı YASAKTIR (BP-4, BP-10).
import type { BillingParty } from './suratBillingParty.ts'
import {
  isTrustedOrderContractEvidence,
  type OrderContractEvidence,
} from './trendyolLiveOrderIngestion.ts'

// Kanıtın DOĞDUĞU yer bu dosya DEĞİLDİR; burada yalnız TÜKETİLİR. Marka ve
// üretim `trendyolLiveOrderIngestion.ts` içindedir (canlı HTTP yanıt sınırı).
export { isTrustedOrderContractEvidence }
export type { OrderContractEvidence }

/** Sağlayıcı-nötr kanonik ödeyen durumu. */
export const SHIPPING_PAYERS = ['MARKETPLACE_PAYS', 'SELLER_PAYS', 'UNKNOWN'] as const
export type ShippingPayer = (typeof SHIPPING_PAYERS)[number]

/** Bilginin NEREDEN geldiği — olasılık değil, KÖKEN. */
export const PAYER_PROVENANCES = [
  /** Sağlayıcının kendi sipariş sözleşmesinden DOĞRULANMIŞ sinyal. */
  'ORDER_CONTRACT',
  /** Pazaryeri HESABI düzeyinde operatör yapılandırması. */
  'ACCOUNT_CONFIG',
  /** Kiracı geneli varsayılan. */
  'TENANT_CONFIG',
  'UNKNOWN',
] as const
export type PayerProvenance = (typeof PAYER_PROVENANCES)[number]

/**
 * ÖNCELİK — KANITLANMIŞ OLAN GENEL OLANI YENER.
 *
 * Sipariş düzeyindeki doğrulanmış sözleşme sinyali EN GÜÇLÜDÜR: o siparişe
 * dair GERÇEĞİ söyler. Kiracı geneli varsayılan ise yalnız bir TAHMİNDİR ve
 * doğrulanmış bir olguyu EZEMEZ (BP-7).
 */
export const PAYER_PRECEDENCE: readonly PayerProvenance[] = [
  'ORDER_CONTRACT',
  'ACCOUNT_CONFIG',
  'TENANT_CONFIG',
  'UNKNOWN',
]

/**
 * Doğrulanmış sipariş sinyali OLAN pazaryerleri.
 *
 * Trendyol: `suratBillingParty.classifyTrendyolWhoPays` forensic audit ile
 * doğrulanmıştır. Diğerleri için bu depoda KANIT YOKTUR:
 *
 *   n11          → `deliveryFeeType` bu depoda HİÇ GEÇMEZ ve kabul edilmiş
 *                  bir n11 sözleşme paketi YOKTUR → doğrulanmamış.
 *   Hepsiburada  → ödeyen alanı bulunamadı → doğrulanmamış.
 *
 * Doğrulanmamış bir alanı "herhalde budur" diye eşlemek, yanlış cariye
 * fatura kesmek demektir. Bu yüzden UYDURULMAZ.
 */
export const MARKETPLACES_WITH_VERIFIED_ORDER_SIGNAL = ['trendyol'] as const

/**
 * SİPARİŞ SÖZLEŞMESİ KANITI — ÜÇ AŞAMALI DÜZELTMENİN SONU.
 *
 * (1) Önce girdi düz bir `BillingParty` idi: çağıran `'TRENDYOL'` yazıp
 *     `ORDER_CONTRACT` kökeni uyduruyordu.
 * (2) Sonra alanlı bir nesne oldu — ama O DA ELLE KURULABİLİYORDU:
 *
 *       { evidence: 'CONFIRMED_PROVIDER_CONTRACT',
 *         provenance: 'PROVIDER_RAW', billingParty: 'TRENDYOL' }
 *
 *     Alanları doğru yazmak, kanıta SAHİP OLMAK DEĞİLDİR.
 * (3) Sonra kanıt MARKALANDI — ama markayı basan fabrika hâlâ
 *     `(rastgeleYük, { origin: 'LIVE_PROVIDER_RESPONSE' })` kabul ediyordu.
 *     Yani marka şunu kanıtlıyordu: "fabrikadan geçti". Şunu KANITLAMIYORDU:
 *     "canlı sağlayıcı yanıtından geldi". `origin` bir OLGU değil, ÇAĞIRANIN
 *     YAZDIĞI bir DİZGİYDİ.
 *
 * O genel fabrika KALDIRILDI. Kanıt artık YALNIZ gerçek HTTP yanıt sınırında
 * (`trendyolLiveOrderIngestion.ingestTrendyolLiveOrderResponse`) doğar; bu
 * dosya kanıtı yalnız TÜKETİR ve markayı SORAR.
 */
export interface ShippingPayerInput {
  marketplace: string
  /**
   * Sağlayıcı sipariş sözleşmesi KANITI. Düz `BillingParty` YETMEZ.
   */
  orderContractEvidence?: OrderContractEvidence | null
  /** Hesap düzeyinde operatör yapılandırması. */
  marketplaceAccountConfig?: ShippingPayer | null
  /** Kiracı geneli varsayılan. */
  tenantConfig?: ShippingPayer | null
}

export interface ShippingPayerResult {
  payer: ShippingPayer
  provenance: PayerProvenance
  reasonCode: string
  /** Ödeyen kesinliği gerektiren rotalar için kullanılabilir mi. */
  usableForRouting: boolean
}

/** Trendyol'a özel `BillingParty` → sağlayıcı-nötr kanon. */
export function canonicalizeBillingParty(party: BillingParty | null | undefined): ShippingPayer {
  if (party === 'SELLER') return 'SELLER_PAYS'
  if (party === 'TRENDYOL') return 'MARKETPLACE_PAYS'
  return 'UNKNOWN'
}

function normalizeMarketplace(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function normalizePayer(value: unknown): ShippingPayer | null {
  const text = String(value ?? '').trim().toUpperCase()
  return (SHIPPING_PAYERS as readonly string[]).includes(text)
    ? (text as ShippingPayer)
    : null
}

/**
 * KANONİK ÇÖZÜMLEYİCİ — SAF, DETERMİNİSTİK, OLASILIKSIZ.
 *
 * Hiçbir koşulda taşıyıcı/sağlayıcı ADINDAN çıkarım yapılmaz ve hiçbir
 * koşulda "kimlik bilgisi var → satıcı öder" gibi bir varsayım kurulmaz.
 */
export function resolveShippingBillingParty(
  input: ShippingPayerInput,
): ShippingPayerResult {
  const marketplace = normalizeMarketplace(input.marketplace)

  // 1) DOĞRULANMIŞ SİPARİŞ SÖZLEŞMESİ — ÜÇ KOŞUL BİRDEN.
  //
  //   (a) pazaryerinin doğrulanmış sözleşme sinyali OLMALI
  //   (b) kanıt CANLI YANIT SINIRINDA doğmuş OLMALI (markalı)
  //   (c) kanıt seviyesi `CONFIRMED_PROVIDER_CONTRACT` OLMALI
  //   (d) yük gerçekten SAĞLAYICI HAM PAKETİ (`PROVIDER_RAW`) OLMALI
  //
  // `UNVERIFIED_HISTORICAL_RAW` / `NORMALIZED_COPY` / `RECONSTRUCTED` /
  // `UNKNOWN` sözleşme kanıtı SAYILMAZ ve bir alt kaynağa DÜŞÜLÜR.
  const hasVerifiedContract = (
    MARKETPLACES_WITH_VERIFIED_ORDER_SIGNAL as readonly string[]
  ).includes(marketplace)
  const evidence = input.orderContractEvidence ?? null
  if (
    hasVerifiedContract &&
    evidence &&
    // (b) KANIT CANLI YANIT SINIRINDA DOĞMUŞ OLMALI. Alanları elle doğru
    //     yazmak yetmez; nesne markalı değilse REDDEDİLİR. Kopyalama da
    //     markayı taşımaz — marka NESNEYE bağlıdır.
    isTrustedOrderContractEvidence(evidence) &&
    evidence.evidence === 'CONFIRMED_PROVIDER_CONTRACT' &&
    evidence.provenance === 'PROVIDER_RAW'
  ) {
    const payer = canonicalizeBillingParty(evidence.billingParty)
    if (payer !== 'UNKNOWN') {
      return {
        payer,
        provenance: 'ORDER_CONTRACT',
        reasonCode: 'CONFIRMED_PROVIDER_CONTRACT_EVIDENCE',
        usableForRouting: true,
      }
    }
  }

  // 2) HESAP YAPILANDIRMASI — sözleşmeler hesaptan hesaba DEĞİŞEBİLİR.
  const accountConfig = normalizePayer(input.marketplaceAccountConfig)
  if (accountConfig && accountConfig !== 'UNKNOWN') {
    return {
      payer: accountConfig,
      provenance: 'ACCOUNT_CONFIG',
      reasonCode: 'ACCOUNT_LEVEL_CONFIGURATION',
      usableForRouting: true,
    }
  }

  // 3) KİRACI VARSAYILANI — en zayıf kanıt.
  const tenantConfig = normalizePayer(input.tenantConfig)
  if (tenantConfig && tenantConfig !== 'UNKNOWN') {
    return {
      payer: tenantConfig,
      provenance: 'TENANT_CONFIG',
      reasonCode: 'TENANT_DEFAULT_CONFIGURATION',
      usableForRouting: true,
    }
  }

  // 4) BİLİNMİYOR — FAIL-CLOSED. Varsayılan SELLER_PAYS YOKTUR.
  return {
    payer: 'UNKNOWN',
    provenance: 'UNKNOWN',
    reasonCode: 'NO_VERIFIED_SIGNAL_OR_CONFIGURATION',
    usableForRouting: false,
  }
}

/**
 * ÖDEYEN KESİNLİĞİ GEREKTİREN ROTA İÇİN KAPI.
 *
 * `UNKNOWN` → `CONFIG_REQUIRED`. Pazaryeri etiketi başarısız olunca sessizce
 * doğrudan taşıyıcıya düşmek YASAKTIR: bu, yanlış cariye fatura kesebilir.
 */
export const ROUTING_GATES = ['ALLOWED', 'CONFIG_REQUIRED'] as const
export type RoutingGate = (typeof ROUTING_GATES)[number]

export function routingGateForPayer(result: ShippingPayerResult): {
  gate: RoutingGate
  reasonCode: string
} {
  if (result.payer === 'UNKNOWN' || !result.usableForRouting) {
    return { gate: 'CONFIG_REQUIRED', reasonCode: 'PAYER_UNKNOWN' }
  }
  return { gate: 'ALLOWED', reasonCode: result.reasonCode }
}

/** Pazaryeri bazında ödeyen kanıt sınıfı — UI ve rapor için. */
export const PAYER_EVIDENCE_CLASSES = [
  'CAN_DERIVE_FROM_ORDER',
  'ACCOUNT_CONFIG_REQUIRED',
  'NOT_VERIFIED',
] as const
export type PayerEvidenceClass = (typeof PAYER_EVIDENCE_CLASSES)[number]

/**
 * KANIT MATRİSİ — bu depoda KANITLANMIŞ olana göre.
 *
 * `n11` ve `hepsiburada` için ödeyen alanı bu depoda DOĞRULANAMADI; bu
 * yüzden hesap yapılandırması gerekir. Doğrulanmamışı "destekleniyor"
 * göstermek YASAKTIR.
 */
export const PAYER_EVIDENCE_MATRIX: Record<string, PayerEvidenceClass> = {
  trendyol: 'CAN_DERIVE_FROM_ORDER',
  n11: 'ACCOUNT_CONFIG_REQUIRED',
  hepsiburada: 'ACCOUNT_CONFIG_REQUIRED',
  woocommerce: 'ACCOUNT_CONFIG_REQUIRED',
  ikas: 'ACCOUNT_CONFIG_REQUIRED',
  ticimax: 'ACCOUNT_CONFIG_REQUIRED',
}

export function payerEvidenceClass(marketplace: string): PayerEvidenceClass {
  return PAYER_EVIDENCE_MATRIX[normalizeMarketplace(marketplace)] ?? 'NOT_VERIFIED'
}
