// DURUSOFT SAĞ-ALT QR — CANONICAL PAYLOAD ÇÖZÜMÜ.
//
// DOĞRULANMIŞ İŞ KURALI: DuruSoft referans etiketindeki sağ-alt QR fiziksel
// olarak okutulmuştur ve `727` ile başlayan Trendyol takip/QR numarasını verir.
// Bu bir varsayım DEĞİL, ölçülmüş bir gerçektir.
//
// Bu modül QR'a ne yazılacağına karar veren TEK yerdir. Kural katıdır:
// değer kalıcı CargoFlow verisinden gelir, biçimi doğrulanır ve etiketteki
// DİĞER makine-okunur alanlarla ÇAKIŞMADIĞI kanıtlanır. Herhangi bir şüphede
// QR ÜRETİLMEZ — yanlış QR, QR'ın hiç olmamasından çok daha tehlikelidir.

/** Trendyol kargo takip numarasının doğrulanmış öneki. */
const VERIFIED_PREFIX = '727'
const MIN_LENGTH = 10
const MAX_LENGTH = 20

export type SuratQrSource =
  | 'cargoTrackingNumber'
  | 'ozelKargoTakipNo'
  | 'both'

export type SuratQrRejection =
  | 'no_candidate'
  | 'invalid_format'
  | 'sources_disagree'
  | 'collides_with_machine_field'

export interface SuratQrCandidateInput {
  /** order.cargoTrackingNumber */
  readonly cargoTrackingNumber?: unknown
  /** shipment.ozelKargoTakipNo */
  readonly ozelKargoTakipNo?: unknown
  /**
   * QR'a ASLA yazılmaması gereken değerler: T.No, Code128 gövdesi,
   * DataMatrix gövdesi, sipariş numarası. Çakışma = QR üretilmez.
   */
  readonly forbiddenValues?: readonly unknown[]
}

export interface SuratQrResolution {
  /** QR üretilecekse EXACT payload; aksi halde null. */
  readonly payload: string | null
  readonly source: SuratQrSource | null
  readonly rejection: SuratQrRejection | null
  /** Teşhis için güvenli özet — GERÇEK DEĞER veya hash İÇERMEZ. */
  readonly diagnostic: string
}

function normalize(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  if (typeof value !== 'string') return ''
  // Yalnız boşluk temizlenir; rakam dışı karakter DÜZELTİLMEZ, reddedilir.
  return value.trim().replace(/\s+/g, '')
}

/** Doğrulanmış 727 biçimi: yalnız rakam, `727` öneki, makul uzunluk. */
export function isVerifiedTrendyolTracking(value: string): boolean {
  if (!value.startsWith(VERIFIED_PREFIX)) return false
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) return false
  return /^[0-9]+$/.test(value)
}

/**
 * Yalnız DOĞRULANMIŞ değer için QR payload döner.
 *
 * Reddetme koşulları (hepsinde `payload: null`):
 *  - hiçbir aday yok
 *  - aday `727…` biçimine uymuyor
 *  - iki canonical kaynak da dolu ve BİRBİRİNDEN FARKLI
 *  - aday, etiketteki başka bir makine-okunur alanla aynı
 */
export function resolveSuratQrPayload(
  input: SuratQrCandidateInput,
): SuratQrResolution {
  const cargo = normalize(input.cargoTrackingNumber)
  const ozel = normalize(input.ozelKargoTakipNo)

  if (cargo === '' && ozel === '') {
    return {
      payload: null,
      source: null,
      rejection: 'no_candidate',
      diagnostic: 'canonical takip numarası yok',
    }
  }

  // İKİ KAYNAK DA DOLU → BİREBİR EŞLEŞMELİ.
  if (cargo !== '' && ozel !== '' && cargo !== ozel) {
    return {
      payload: null,
      source: null,
      rejection: 'sources_disagree',
      diagnostic: 'cargoTrackingNumber ile ozelKargoTakipNo uyuşmuyor',
    }
  }

  const candidate = cargo !== '' ? cargo : ozel
  const source: SuratQrSource =
    cargo !== '' && ozel !== ''
      ? 'both'
      : cargo !== ''
        ? 'cargoTrackingNumber'
        : 'ozelKargoTakipNo'

  if (!isVerifiedTrendyolTracking(candidate)) {
    return {
      payload: null,
      source: null,
      rejection: 'invalid_format',
      diagnostic: `aday doğrulanmış 727 biçiminde değil (uzunluk ${candidate.length})`,
    }
  }

  // ETİKETTEKİ DİĞER MAKİNE-OKUNUR ALANLARLA ÇAKIŞMA YASAK.
  for (const forbidden of input.forbiddenValues ?? []) {
    const other = normalize(forbidden)
    if (other !== '' && other === candidate) {
      return {
        payload: null,
        source: null,
        rejection: 'collides_with_machine_field',
        diagnostic: 'aday başka bir makine-okunur alanla aynı',
      }
    }
  }

  return {
    payload: candidate,
    source,
    rejection: null,
    diagnostic: `doğrulanmış takip numarası (${source})`,
  }
}
