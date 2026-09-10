// KALICI `renderContract` AYIRICISININ GERİYE DÖNÜK NORMALİZASYONU.
//
// ═══ SORUN ═══════════════════════════════════════════════════════════════
// `renderContract`, türetilmiş baskı artefaktıyla birlikte şifreli shipment
// payload'ında SAKLANIR. Sözleşmenin kanonik adı yeniden adlandırıldığında
// (yalnız isimlendirme; üretilen ZPL AYNI) daha önce yazılmış kayıtlar hâlâ
// ESKİ ayırıcıyı taşır.
//
// Okuma kapısı yalnız güncel adları tanıyordu: eski kayıtta alan DÜŞÜYOR ve
// DTO `official_augmented` varsayılanına iniyordu. Yani composer'dan geçmiş
// bir gönderi, "yalnız augmentation uygulanmış" gibi YANLIŞ sınıflanıyordu.
// Bu bir teşhis hatasıdır: baskı çıktısı doğru, raporlanan sözleşme yanlış.
//
// ═══ NEDEN HASH ══════════════════════════════════════════════════════════
// Eski ayırıcı, kaldırılmış bir ÜÇÜNCÜ TARAF FİRMA ADINI içerir ve o ad
// depoya düz metin olarak GERİ GELMEMELİDİR. Kayıttaki değeri tanımanın
// tek güvenilir yolu değerin kendisidir (sürüm/köken alanları composed ile
// augmented'ı AYIRT ETMEZ — ikisi de aynı `printZplVersion` altında
// üretilebilir). Bu yüzden karşılaştırma, çalışma anındaki değerin
// SHA-256 özeti üzerinden yapılır: eşleşme kesin, kaynak temiz.
//
// Özet, düz metnin yerine geçen tersine çevrilebilir bir maskeleme DEĞİLDİR;
// SHA-256 tek yönlüdür ve buradan ad geri üretilemez.
//
// SAF: IO yok, ağ yok, DB yok.
import { createHash } from 'node:crypto'

/** Yürürlükteki kanonik sözleşme adları. */
export const RENDER_CONTRACTS = ['official_augmented', 'carrier_composed'] as const
export type RenderContract = (typeof RENDER_CONTRACTS)[number]

/**
 * Yeniden adlandırma ÖNCESİ yazılmış ayırıcının SHA-256 özeti (küçük harf).
 *
 * Bu değer YALNIZ TANIMA içindir; hiçbir yere YAZILMAZ. Yeni artefaktlar her
 * zaman kanonik adı taşır.
 */
const LEGACY_COMPOSED_CONTRACT_SHA256 =
  '920a3418e4df577449682659d23da924039261090ff4ad0a83a33af820b5d039'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Değer, yeniden adlandırma öncesindeki composed ayırıcısı mı? */
export function isLegacyComposedContract(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  return sha256(normalized) === LEGACY_COMPOSED_CONTRACT_SHA256
}

/**
 * Kalıcı `renderContract` değerini kanonik ada çevirir.
 *
 *   kanonik ad          → aynen
 *   eski composed ayırıcı → 'carrier_composed'
 *   GERÇEKTEN bilinmeyen → null (çağıran mevcut güvenli davranışı sürdürür)
 *
 * Eski ayırıcı ile gerçek bilinmeyen BİRBİRİNE KARIŞTIRILMAZ: yalnız özeti
 * tutan değer eski sayılır, geri kalan her şey bilinmeyendir.
 */
export function normalizeRenderContract(value: unknown): RenderContract | null {
  if (typeof value === 'string') {
    const candidate = value as RenderContract
    if (RENDER_CONTRACTS.includes(candidate)) return candidate
  }
  return isLegacyComposedContract(value) ? 'carrier_composed' : null
}

/**
 * Kalıcı `composeMode` değerini normalize eder.
 *
 * `composeMode`, composed artefaktlarda sözleşmeyle AYNI dizgiyi taşır; bu
 * yüzden eski kayıtlarda kaldırılmış ad API yanıtına SIZIYORDU. Yalnız o
 * durum çevrilir; `fallback_*` gibi ilgisiz mod değerleri AYNEN korunur.
 */
export function normalizeComposeMode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return isLegacyComposedContract(value) ? 'carrier_composed' : value
}
