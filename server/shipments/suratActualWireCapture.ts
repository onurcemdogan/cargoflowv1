// SÜRAT — GERÇEK TEL (ACTUAL WIRE) ANLIK GÖRÜNTÜSÜ.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// Şimdiye kadar "telde ne gitti?" sorusu ancak YENİDEN KURGULAYARAK
// yanıtlanabiliyordu: sipariş, gönderi kaydı, eski operasyon satırları ya da
// istemci enstrümantasyonu. Bu kurgular ÜRETİMDE YANLIŞ ÇIKTI — legacy debug
// `ReferansNo = 7270036062402465` ve `CariKod/FirmaId = 1537690944` gösterdi,
// oysa o değerler telde o şekilde GİTMEMİŞTİ.
//
// Bu modül kurgu YAPMAZ. Girdisi, ağ çağrısından hemen önce SERİLEŞTİRİLECEK
// olan NİHAİ istek nesnesidir. Başka hiçbir kaynağa bakmaz.
//
// ═══ SIR ve PII ═══════════════════════════════════════════════════════════
// Ham kullanıcı adı/parola ASLA saklanmaz: kullanıcı adı yalnız PARMAK İZİ,
// parola yalnız VARLIK olarak geçer. Alıcı adı/adres/telefon/e-posta ve ham
// etiket verisi HİÇ okunmaz.

import { accountFingerprint } from './suratRoutingModel.ts'

/** Değerin çalışma zamanı tipi — sözleşme karşılaştırmasının çekirdeği. */
export function wireRuntimeType(value: unknown): string {
  if (value === undefined) return 'absent'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Güvenli ACTUAL değeri taşınan alanlar.
 *
 * Bunlar iş/faturalama semantiğidir; müşteri verisi DEĞİLDİR. Yanlış değer
 * doğrudan yanlış cariye/yanlış ücrete yol açtığı için GERÇEK değer görünür
 * olmalıdır.
 */
export const WIRE_SAFE_VALUE_FIELDS = [
  'OdemeTipi',
  'Pazaryerimi',
  'EntegrasyonFirmasi',
  'ReferansNo',
  'OzelKargoTakipNo',
  'KapidanOdemeTahsilatTipi',
] as const

/** Yalnız VARLIK + TİP taşınan alanlar (değer gereksiz ya da hassas). */
export const WIRE_PRESENCE_ONLY_FIELDS = [
  'KapidanOdemeTutari',
  'FirmaId',
] as const

/**
 * Sözleşmede OLMAYABİLECEK alanlar.
 *
 * Kanonik `Gonderi` sözleşmesinde `WhoPays`/`KimOder` YOKTUR. Telde
 * bulunmamaları HATA DEĞİLDİR ve bu yüzden UYDURULMAZ; yalnız gerçekten
 * varsa raporlanır.
 */
export const WIRE_OPTIONAL_CONTRACT_FIELDS = ['WhoPays', 'KimOder'] as const

/** ASLA yakalanmayan alanlar — müşteri verisi. */
const PII_FIELDS = new Set([
  'KisiKurum', 'AliciAdresi', 'Il', 'Ilce', 'Email',
  'Telefon', 'CepTelefonu', 'SevkAdresi',
])

export interface WireFieldTypes {
  [field: string]: string
}

export interface ActualWireCapture {
  /** Kök gövdenin çalışma zamanı tipi. */
  rootRuntimeType: string
  /** `Gonderi` alanının çalışma zamanı tipi — NESNE olmalıdır. */
  gonderiRuntimeType: string
  /** HER Gonderi alanı için ad → tip (değer YOK). */
  gonderiFieldTypes: WireFieldTypes
  /** Güvenli GERÇEK değerler. */
  safeValues: Record<string, unknown>
  /** Varlık + tip. */
  presence: Record<string, { present: boolean; runtimeType: string }>
  /** Sözleşmede olmayabilecek alanlar. */
  optionalContractFields: Record<
    string, { present: boolean; runtimeType: string; value?: unknown }
  >
  /** Kimlik: parola YALNIZ varlık, kullanıcı adı YALNIZ parmak izi. */
  credential: {
    kullaniciAdiPresent: boolean
    sifrePresent: boolean
    networkBoundaryAccountFingerprint: string
  }
  /** Serileştirilmiş gövde uzunluğu — içerik DEĞİL. */
  serializedLength: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * NİHAİ istek nesnesinden güvenli anlık görüntü üretir.
 *
 * `request` ağ çağrısına gidecek OLAN nesnedir (`{ KullaniciAdi, Sifre,
 * Gonderi }`). Kurgu yoktur: ne varsa o raporlanır, olmayan `absent` görünür.
 */
export function captureActualWire(
  request: Record<string, unknown> | null | undefined,
): ActualWireCapture {
  const body = request ?? {}
  const gonderi = isObject(body.Gonderi) ? body.Gonderi : null

  const gonderiFieldTypes: WireFieldTypes = {}
  if (gonderi) {
    for (const key of Object.keys(gonderi)) {
      // PII alanlarının ADI görünür (sözleşme denetimi için), DEĞERİ asla.
      gonderiFieldTypes[key] = wireRuntimeType(gonderi[key])
    }
  }

  const source = gonderi ?? {}
  const safeValues: Record<string, unknown> = {}
  for (const field of WIRE_SAFE_VALUE_FIELDS) {
    if (PII_FIELDS.has(field)) continue
    safeValues[field] = source[field] === undefined ? null : source[field]
  }

  const presence: Record<string, { present: boolean; runtimeType: string }> = {}
  for (const field of WIRE_PRESENCE_ONLY_FIELDS) {
    presence[field] = {
      present: source[field] !== undefined && source[field] !== null,
      runtimeType: wireRuntimeType(source[field]),
    }
  }

  const optionalContractFields: Record<
    string, { present: boolean; runtimeType: string; value?: unknown }
  > = {}
  for (const field of WIRE_OPTIONAL_CONTRACT_FIELDS) {
    const value = source[field]
    const present = value !== undefined
    optionalContractFields[field] = present
      ? { present, runtimeType: wireRuntimeType(value), value }
      : { present: false, runtimeType: 'absent' }
  }

  // Döngüsel gövde serileştirilemeyebilir; o durumda uzunluk 0 kalır.
  let serializedLength: number
  try {
    serializedLength = JSON.stringify(body)?.length ?? 0
  } catch {
    serializedLength = 0
  }

  return {
    rootRuntimeType: wireRuntimeType(body),
    gonderiRuntimeType: wireRuntimeType(body.Gonderi),
    gonderiFieldTypes,
    safeValues,
    presence,
    optionalContractFields,
    credential: {
      kullaniciAdiPresent: String(body.KullaniciAdi ?? '').trim().length > 0,
      sifrePresent: String(body.Sifre ?? '').length > 0,
      // AĞ SINIRI parmak izi: NİHAİ gövdedeki değerden hesaplanır.
      networkBoundaryAccountFingerprint: accountFingerprint(
        String(body.KullaniciAdi ?? ''),
      ),
    },
    serializedLength,
  }
}

// ═══ DÖRT PARMAK İZİ — TEK KARAR ═════════════════════════════════════════

export interface WireFingerprintSet {
  resolverAccountFingerprint: string
  snapshotAccountFingerprint: string
  requestBuilderAccountFingerprint: string
  networkBoundaryAccountFingerprint: string
}

export interface WireFingerprintVerdict extends WireFingerprintSet {
  credentialFingerprintMatch: boolean
  /** Eşleşmeyenler — hangi sınırda ayrıştığı görünür kalmalı. */
  divergentBoundaries: string[]
}

/**
 * Dört sınırın HEPSİ aynı hesabı göstermeli.
 *
 * Üretimde ölçülen kusur tam olarak buydu: iki sınır aynı istemci gövdesinden
 * türediği için eşit çıkıyor, otoriter hesap ise bambaşka oluyordu. Artık
 * dördü de ayrı kaynaklardan gelir ve HEPSİ karşılaştırılır.
 */
export function verifyWireFingerprints(
  set: WireFingerprintSet,
): WireFingerprintVerdict {
  const reference = set.snapshotAccountFingerprint
  const divergent: string[] = []
  const check = (name: string, value: string) => {
    if (!value || value !== reference) divergent.push(name)
  }
  check('resolver', set.resolverAccountFingerprint)
  check('requestBuilder', set.requestBuilderAccountFingerprint)
  check('networkBoundary', set.networkBoundaryAccountFingerprint)
  return {
    ...set,
    credentialFingerprintMatch: divergent.length === 0 && Boolean(reference),
    divergentBoundaries: divergent,
  }
}
