// SÜRAT CREATE — IDEMPOTENCY SEMANTİK KIYASI (saf karar katmanı).
//
// Ağ/DB'ye DOKUNMAZ. Tek soru: "kayıtlı sonucu geri oynatmak DOĞRU mu?"
//
// SORUN. Idempotency anahtarı `SURAT:${tenantId}:${orderId}:CREATE`tir —
// fiziksel (desi) ve finansal (kim öder) semantiği TAŞIMAZ. `requestFingerprint`
// bu semantiği taşır ama üretilip yazıldıktan sonra HİÇ okunmaz. Sonuç: desi
// düzeltilip istek tekrarlandığında anahtar aynı kalır, kayıt SUCCESS'tir ve
// ESKİ etiket "başarılı" diye geri oynatılır. Düzeltme uygulanmamıştır ama
// uygulanmış görünür; fatura yanlış desiden kesilir.
//
// NEDEN ANAHTARA KATMIYORUZ. Semantiği anahtara katmak, semantik değişince
// YENİ anahtar üretirdi → aynı sipariş için İKİNCİ fiziksel gönderi. Çift
// maliyet ve geri alınamaz. Bu yüzden anahtar SABİT kalır; kıyas ayrı yapılır.
//
// KARAR. Fark varsa ne replay ne create: FAIL-CLOSED durulur ve farkın HANGİ
// eksende olduğu söylenir.
//
// LEGACY GÜVENLİĞİ. Kayıtta kıyaslanacak alan YOKSA fark KANITLANAMAZ.
// "Kanıt yokluğu" ile "farklı" AYNI ŞEY DEĞİLDİR: eski kayıtlar bu alanları
// taşımaz ve onları reddetmek çalışan siparişleri sebepsiz bloklardı. Alan
// yoksa o eksen SESSİZCE atlanır ve bugünkü davranış korunur.

export const SURAT_IDEMPOTENCY_MISMATCH_CODE = 'SURAT_IDEMPOTENCY_SEMANTIC_MISMATCH'

/** Kullanıcıya gösterilen eksen adları (SIR İÇERMEZ). */
const AXIS_LABELS: Record<string, string> = {
  requestFingerprint: 'sipariş/desi/servis semantiği',
  billingParty: 'faturalanan taraf',
  expectedSuratWhoPays: 'Sürat ödeyen tarafı',
  credentialRole: 'kimlik rolü',
  odemeTipi: 'ödeme tipi',
  codEnabled: 'kapıda ödeme',
  codCollectionType: 'kapıda ödeme tahsilat tipi',
  pazaryerimi: 'pazaryeri bağlamı',
  entegrasyonFirmasi: 'entegrasyon firması',
  marketplaceIdentitySource: 'pazaryeri kimlik kaynağı',
  marketplaceIdentityPresent: 'pazaryeri kimliği varlığı',
}

export interface CreateSemantics {
  /** Sipariş/desi/servis semantiğinin hash'i. */
  requestFingerprint?: string | null
  /** Kapının ürettiği finansal semantik (SIR İÇERMEZ). */
  financialFingerprint?: Record<string, unknown> | null
}

export interface SemanticComparison {
  /** `false` ise kayıtlı sonuç GERİ OYNATILMAMALIDIR. */
  match: boolean
  /** Farklı bulunan eksenler; kıyaslanamayanlar BURADA OLMAZ. */
  changedAxes: string[]
  /** Hiç kıyas yapılamadıysa `true` (eski kayıt) — bu bir fark DEĞİLDİR. */
  comparable: boolean
  message: string | null
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Skaler karşılaştırma; `undefined` ve `null` AYNI sayılır (alan yok). */
const absent = (value: unknown): boolean => value === undefined || value === null

/**
 * Kayıtlı ve gelen semantiği kıyaslar.
 *
 * KIYASLANABİLİR eksen = HER İKİ tarafta da mevcut olan eksen. Yalnız birinde
 * varsa fark İDDİA EDİLMEZ (eski kayıt yeni alanı taşımıyor olabilir).
 */
export function compareCreateSemantics(params: {
  stored?: CreateSemantics | null
  current?: CreateSemantics | null
}): SemanticComparison {
  const stored = params.stored ?? {}
  const current = params.current ?? {}
  const changedAxes: string[] = []
  let comparedAny = false

  if (!absent(stored.requestFingerprint) && !absent(current.requestFingerprint)) {
    comparedAny = true
    if (String(stored.requestFingerprint) !== String(current.requestFingerprint)) {
      changedAxes.push('requestFingerprint')
    }
  }

  const storedFinancial = isPlainObject(stored.financialFingerprint)
    ? stored.financialFingerprint
    : null
  const currentFinancial = isPlainObject(current.financialFingerprint)
    ? current.financialFingerprint
    : null
  if (storedFinancial && currentFinancial) {
    // YALNIZ iki tarafta da bulunan alanlar kıyaslanır: kapıya yeni bir alan
    // eklendiğinde eski kayıtlar toptan reddedilmesin.
    for (const key of Object.keys(currentFinancial)) {
      if (absent(storedFinancial[key]) && absent(currentFinancial[key])) continue
      if (!(key in storedFinancial)) continue
      comparedAny = true
      if (String(storedFinancial[key]) !== String(currentFinancial[key])) {
        changedAxes.push(key)
      }
    }
  }

  if (changedAxes.length === 0) {
    return { match: true, changedAxes: [], comparable: comparedAny, message: null }
  }
  const labels = changedAxes.map((axis) => AXIS_LABELS[axis] ?? axis)
  return {
    match: false,
    changedAxes,
    comparable: true,
    message:
      'Bu sipariş için kayıtlı Sürat gönderisi FARKLI koşullarda oluşturulmuş: '
      + `${labels.join(', ')} değişmiş. Eski etiket başarı sayılmadı ve yeni `
      + 'gönderi de oluşturulmadı; yanlış tutar/cari ile ikinci bir gönderi '
      + 'doğmaması için işlem durduruldu.',
  }
}
