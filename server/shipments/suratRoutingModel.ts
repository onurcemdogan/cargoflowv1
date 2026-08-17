// SÜRAT YÖNLENDİRME MODELİ — SAF, AĞSIZ, YAN ETKİSİZ.
//
// BEŞ KATMAN BİRBİRİNDEN AYRIDIR VE BİRBİRİNİ DEĞİŞTİREMEZ:
//   1) BILLING   — kim öder (Trendyol sözleşmesinden türer)
//   2) PAYMENT   — OdemeTipi (peşin / ücret alıcı)
//   3) COD       — kapıda ödeme (tahsilat tipi + tutar)
//   4) CREDENTIAL— hangi Sürat cari/kimliği kullanılır
//   5) CONTRACT  — seçilen uçun gerçekten kabul ettiği alanlar
//
// EN ÖNEMLİ İKİ KURAL:
//   · `OdemeTipi` ile `BillingParty` arasında OTOMATİK EŞLEME YOKTUR.
//     TRENDYOL_PAYS + OdemeTipi=1 GEÇERLİ bir kombinasyondur.
//   · COD faturalama tarafını DEĞİŞTİRMEZ; faturalama tarafı da COD'u
//     değiştirmez. İkisi bağımsız eksenlerdir.
//
// SESSİZ KREDENSİYAL DÜŞÜŞÜ YOKTUR: istenen rolün kimliği yoksa sonuç
// hatadır, başka bir role SESSİZCE geçilmez.
import { classifyTrendyolWhoPays } from './suratBillingParty.ts'

const text = (value: unknown): string => String(value ?? '').trim()

/* ═══ 1) BILLING ═══════════════════════════════════════════════════════ */

export const BILLING_PARTIES_V2 = [
  'TRENDYOL_PAYS',
  'SELLER_PAYS',
  'UNKNOWN',
] as const
export type BillingPartyV2 = (typeof BILLING_PARTIES_V2)[number]

/**
 * Trendyol ham yükünden faturalama tarafı — mevcut sözleşme mapper'ının
 * ÜZERİNE kurulur, yeni kural YAZILMAZ.
 *   whoPays own-property === 1 → SELLER_PAYS
 *   whoPays property ABSENT    → TRENDYOL_PAYS
 *   null / desteklenmeyen      → UNKNOWN (fail-closed)
 */
export function resolveBillingPartyV2(rawOrder: unknown): {
  billingParty: BillingPartyV2
  rawWhoPaysPresent: boolean
  rawWhoPaysNormalized: string | null
  billingEvidence: string
} {
  const contract = classifyTrendyolWhoPays(rawOrder)
  const billingParty: BillingPartyV2 =
    contract.billingParty === 'SELLER'
      ? 'SELLER_PAYS'
      : contract.billingParty === 'TRENDYOL'
        ? 'TRENDYOL_PAYS'
        : 'UNKNOWN'
  return {
    billingParty,
    rawWhoPaysPresent: contract.rawFieldPresent,
    rawWhoPaysNormalized: contract.rawValue,
    billingEvidence: contract.source,
  }
}

/**
 * TEŞHİS AMAÇLI BEKLENTİ — Sürat getCargo kodlaması.
 *   TRENDYOL_PAYS → 3
 *   SELLER_PAYS   → 1
 *   UNKNOWN       → null
 *
 * DİKKAT: bu bir TEŞHİS değeridir. Seçilen uç `WhoPays` alanını kabul
 * etmiyorsa istek gövdesine EKLENMEZ. Beklenti ile telde giden AYRI
 * tutulur (`EXPECTED` vs `WIRE`).
 */
export function expectedSuratWhoPays(party: BillingPartyV2): string | null {
  if (party === 'TRENDYOL_PAYS') return '3'
  if (party === 'SELLER_PAYS') return '1'
  return null
}

/* ═══ 2) PAYMENT ═══════════════════════════════════════════════════════ */

export const ODEME_TIPI_MEANINGS: Record<string, string> = {
  '1': 'PESIN',
  '2': 'UCRET_ALICI',
}

export function describeOdemeTipi(value: unknown): {
  odemeTipi: string
  odemeTipiMeaning: string
} {
  const token = text(value)
  return {
    odemeTipi: token,
    odemeTipiMeaning: ODEME_TIPI_MEANINGS[token] ?? 'UNKNOWN',
  }
}

/* ═══ 3) COD ═══════════════════════════════════════════════════════════ */

export const COD_COLLECTION_TYPES: Record<string, string> = {
  '1': 'NAKIT',
  '2': 'POS',
}

export interface CodContext {
  codEnabled: boolean
  codCollectionType: string | null
  codCollectionTypeMeaning: string | null
  codAmountPresent: boolean
}

export function resolveCodContext(input: {
  enabled?: unknown
  collectionType?: unknown
  amount?: unknown
}): CodContext {
  const codEnabled = input.enabled === true
  if (!codEnabled) {
    // COD kapalıyken tahsilat alanları ANLAMSIZDIR; taşınmaz.
    return {
      codEnabled: false,
      codCollectionType: null,
      codCollectionTypeMeaning: null,
      codAmountPresent: false,
    }
  }
  const collectionType = text(input.collectionType) || null
  return {
    codEnabled: true,
    codCollectionType: collectionType,
    codCollectionTypeMeaning: collectionType
      ? (COD_COLLECTION_TYPES[collectionType] ?? 'UNKNOWN')
      : null,
    codAmountPresent: Number(input.amount) > 0,
  }
}

/* ═══ 4) CREDENTIAL ROUTER ═════════════════════════════════════════════ */

export const SURAT_CREDENTIAL_ROLES = [
  'PRIMARY_MARKETPLACE',
  'SELLER_PAYS',
  'COD',
] as const
export type SuratCredentialRole = (typeof SURAT_CREDENTIAL_ROLES)[number]

/**
 * KAPIDA ÖDEME KİMLİK POLİTİKASI — AÇIK SEÇİM, SESSİZ DÜŞÜŞ YOK.
 *
 * Eski davranış "boş bırakılırsa Satıcı Öder kimliği kullanılır" idi; bu
 * örtük kural yanlış cariye fatura üretebilir. Politika artık AÇIKÇA
 * seçilir. `DEDICATED_COD` varsayılandır ve kimlik yoksa create YAPILMAZ.
 */
export const COD_CREDENTIAL_POLICIES = [
  'DEDICATED_COD',
  'SELLER_PAYS',
  'PRIMARY',
] as const
export type CodCredentialPolicy = (typeof COD_CREDENTIAL_POLICIES)[number]

export const DEFAULT_COD_CREDENTIAL_POLICY: CodCredentialPolicy = 'DEDICATED_COD'

export function resolveCodCredentialPolicy(value: unknown): CodCredentialPolicy {
  const token = text(value).toUpperCase()
  return (COD_CREDENTIAL_POLICIES as readonly string[]).includes(token)
    ? (token as CodCredentialPolicy)
    : DEFAULT_COD_CREDENTIAL_POLICY
}

/** `15******44` — düz cari kodu ASLA taşınmaz. */
export function maskAccount(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  if (raw.length <= 4) return '****'
  return `${raw.slice(0, 2)}******${raw.slice(-2)}`
}

export interface SuratCredentialContext {
  role: SuratCredentialRole
  source: string
  maskedAccount: string
  reason: string
  resolved: boolean
  errorCode: string | null
}

const ROLE_FIELDS: Record<
  SuratCredentialRole,
  { user: string[]; secret: string[]; source: string }
> = {
  PRIMARY_MARKETPLACE: {
    user: ['canonicalPrimaryKullaniciAdi', 'liveKullaniciAdi', 'kullaniciAdi'],
    secret: ['canonicalPrimarySifre', 'liveSifre', 'sifre'],
    source: 'tenant.surat.primary',
  },
  SELLER_PAYS: {
    user: ['sellerPaysKullaniciAdi'],
    secret: ['sellerPaysSifre'],
    source: 'tenant.surat.sellerPays',
  },
  COD: {
    user: ['codKullaniciAdi'],
    secret: ['codSifre'],
    source: 'tenant.surat.cod',
  },
}

function pickField(
  config: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = text(config[key])
    if (value) return value
  }
  return ''
}

/**
 * TEK KREDENSİYAL SINIRI.
 *
 * Rol seçimi UI'da, servis katmanında ve istek kurucuda TEKRARLANMAZ;
 * yalnız burada yapılır. Böylece üç yerde üç farklı kural oluşamaz.
 *
 * COD siparişinde seçilen politikanın kimliği yoksa sonuç
 * `COD_CREDENTIAL_NOT_CONFIGURED`dır ve çağıran taşıyıcıya GİTMEMELİDİR.
 */
export function resolveSuratCredentialContext(params: {
  config?: Record<string, unknown>
  billingParty: BillingPartyV2
  cod: CodContext
  codPolicy?: CodCredentialPolicy
}): SuratCredentialContext {
  const config = params.config ?? {}
  const policy = params.codPolicy ?? DEFAULT_COD_CREDENTIAL_POLICY

  let role: SuratCredentialRole
  let reason: string
  if (params.cod.codEnabled) {
    role =
      policy === 'DEDICATED_COD'
        ? 'COD'
        : policy === 'SELLER_PAYS'
          ? 'SELLER_PAYS'
          : 'PRIMARY_MARKETPLACE'
    reason = `COD_${policy}`
  } else if (params.billingParty === 'SELLER_PAYS') {
    role = 'SELLER_PAYS'
    reason = 'SELLER_PAYS_NON_COD'
  } else {
    role = 'PRIMARY_MARKETPLACE'
    reason =
      params.billingParty === 'TRENDYOL_PAYS'
        ? 'TRENDYOL_MARKETPLACE_NON_COD'
        : 'BILLING_UNKNOWN_DEFAULT_PRIMARY'
  }

  const fields = ROLE_FIELDS[role]
  const account = pickField(config, fields.user)
  const secret = pickField(config, fields.secret)
  const resolved = Boolean(account && secret)

  // SESSİZ DÜŞÜŞ YOK: eksik kimlikte başka role GEÇİLMEZ.
  const errorCode = resolved
    ? null
    : params.cod.codEnabled
      ? 'COD_CREDENTIAL_NOT_CONFIGURED'
      : role === 'SELLER_PAYS'
        ? 'SELLER_PAYS_CREDENTIAL_NOT_CONFIGURED'
        : 'PRIMARY_CREDENTIAL_NOT_CONFIGURED'

  return {
    role,
    source: fields.source,
    maskedAccount: maskAccount(account),
    reason,
    resolved,
    errorCode,
  }
}

/* ═══ 5) PAZARYERİ SÖZLEŞME ÖN KONTROLÜ ════════════════════════════════ */

export interface SuratCreatePreflight {
  valid: boolean
  errorCode: string | null
  failures: string[]
  expectedBillingParty: BillingPartyV2
  expectedSuratWhoPays: string | null
}

/** Trendyol kargo numarası biçimi — mevcut kanonik doğrulama. */
export function isTrendyolParcelIdentity(value: unknown): boolean {
  return /^727\d{10,}$/.test(text(value))
}

/**
 * TRENDYOL_PAYS + Ortak Barkod için ZORUNLU bağlam.
 *
 * Bir değişmez bozuksa `BILLING_CONTEXT_INVALID` döner ve çağıran taşıyıcıya
 * GİTMEZ: yanlış bağlamla oluşan gönderi yanlış cariye yazılır.
 */
export function evaluateSuratCreatePreflight(params: {
  marketplace?: unknown
  pazaryerimi?: unknown
  entegrasyonFirmasi?: unknown
  ozelKargoTakipNo?: unknown
  orderCargoTrackingNumber?: unknown
  billingParty: BillingPartyV2
  credential: SuratCredentialContext
}): SuratCreatePreflight {
  const failures: string[] = []
  const expected = expectedSuratWhoPays(params.billingParty)

  if (!params.credential.resolved) {
    failures.push(params.credential.errorCode ?? 'CREDENTIAL_NOT_CONFIGURED')
  }

  if (params.billingParty === 'TRENDYOL_PAYS') {
    if (text(params.marketplace).toUpperCase() !== 'TRENDYOL') {
      failures.push('MARKETPLACE_NOT_TRENDYOL')
    }
    if (Number(params.pazaryerimi) !== 1) failures.push('PAZARYERIMI_NOT_1')
    if (text(params.entegrasyonFirmasi) !== 'Trendyol') {
      failures.push('ENTEGRASYON_FIRMASI_INVALID')
    }
    const parcel = text(params.ozelKargoTakipNo)
    if (!parcel) failures.push('OZEL_KARGO_TAKIP_NO_MISSING')
    else if (!isTrendyolParcelIdentity(parcel)) {
      failures.push('OZEL_KARGO_TAKIP_NO_FORMAT_INVALID')
    } else if (
      text(params.orderCargoTrackingNumber) &&
      text(params.orderCargoTrackingNumber) !== parcel
    ) {
      // Pazaryeri numarası siparişten GELMELİ; başka kaynak faturalamayı bozar.
      failures.push('OZEL_KARGO_TAKIP_NO_SOURCE_MISMATCH')
    }
  }

  if (params.billingParty === 'UNKNOWN') failures.push('BILLING_PARTY_UNKNOWN')

  return {
    valid: failures.length === 0,
    errorCode: failures.length === 0 ? null : 'BILLING_CONTEXT_INVALID',
    failures,
    expectedBillingParty: params.billingParty,
    expectedSuratWhoPays: expected,
  }
}
