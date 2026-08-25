// SÜRAT SOAP — GERÇEK TEL (ACTUAL WIRE) ANLIK GÖRÜNTÜSÜ.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// Kanonik yolda "telde ne gitti?" sorusu ancak NİHAİ gövdeden yakalanınca
// yanıtlanabildi; yeniden kurgulanan cevaplar üretimde YANLIŞ çıktı. SOAP
// birincil rota olduğunda aynı körlük geri gelmemelidir.
//
// Girdi, ağ çağrısına GİDECEK OLAN zarfın kendisidir. Bu modül kurgu yapmaz:
// zarfta ne varsa onu raporlar, olmayan `absent` görünür.
//
// ═══ SIR ve PII ══════════════════════════════════════════════════════════
// `KullaniciAdi` yalnız PARMAK İZİ, `Sifre` yalnız VARLIK olarak geçer.
// Alıcı adı/adres/telefon/e-posta alanlarının yalnız ADI ve TİPİ görünür;
// DEĞERLERİ hiçbir koşulda taşınmaz.

import { accountFingerprint } from './suratRoutingModel.ts'

/** Değeri ASLA taşınmayan alanlar — müşteri verisi. */
const SOAP_PII_TAGS = new Set([
  'KisiKurum', 'SahisBirim', 'AliciAdresi', 'Il', 'Ilce',
  'TelefonEv', 'TelefonIs', 'TelefonCep', 'Email', 'AliciKodu',
  'SevkAdresi', 'SevkAdresiAdi', 'KargoIcerigi',
])

/**
 * GERÇEK değeri taşınan alanlar — iş/faturalama semantiği.
 *
 * Yanlış değer doğrudan yanlış cariye/yanlış ücrete yol açtığı için bu
 * alanların gerçek değeri görünür olmalıdır.
 */
export const SOAP_SAFE_VALUE_TAGS = [
  'OdemeTipi', 'Odemetipi', 'Pazaryerimi', 'EntegrasyonFirmasi',
  'ReferansNo', 'OzelKargoTakipNo', 'KapidanOdemeTahsilatTipi',
  'KargoTuru', 'Adet', 'TasimaSekli', 'TeslimSekli', 'GonderiSekli', 'Iademi',
] as const

/**
 * SOAP `Gonderi` sözleşmesinde BULUNMAYAN alanlar.
 *
 * Doğrulanmış SOAP zarfında `WhoPays` / `KimOder` / `FirmaId` YOKTUR.
 * Telde bulunmamaları HATA DEĞİLDİR ve bu yüzden UYDURULMAZ; yalnız
 * gerçekten varsa raporlanır.
 */
export const SOAP_ABSENT_BY_CONTRACT_TAGS = [
  'WhoPays', 'KimOder', 'FirmaId',
] as const

export interface SoapWireCapture {
  /** Zarf gerçekten kuruldu mu? */
  envelopePresent: boolean
  operation: string
  serviceMode: string
  /** `Gonderi` düğümü bulundu mu — kanonik `gonderiRuntimeType` karşılığı. */
  gonderiPresent: boolean
  /** Zarftaki SIRAYA göre alan adları. */
  gonderiFieldNames: string[]
  /** Alan adı → çalışma zamanı tipi (değer YOK). */
  gonderiFieldTypes: Record<string, string>
  /** Güvenli GERÇEK değerler. */
  safeValues: Record<string, unknown>
  /** Sözleşmede olmayan alanlar — varlık + tip. */
  contractAbsentFields: Record<string, { present: boolean; runtimeType: string }>
  credential: {
    kullaniciAdiPresent: boolean
    sifrePresent: boolean
    networkBoundaryAccountFingerprint: string
  }
  /** Zarf uzunluğu — İÇERİK DEĞİL. */
  envelopeLength: number
}

/** XML metin değerinden çalışma zamanı tipi. */
export function soapValueRuntimeType(raw: string | null): string {
  if (raw === null) return 'absent'
  const trimmed = raw.trim()
  if (trimmed === '') return 'empty'
  if (/^-?\d+$/.test(trimmed)) return 'integer'
  if (/^-?\d+[.,]\d+$/.test(trimmed)) return 'decimal'
  return 'string'
}

const decodeXmlText = (value: string): string => value
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&')

/** Zarftaki İLK eşleşen düğümün ham metni (yoksa `null`). */
function readTag(xml: string, tag: string): string | null {
  const match = new RegExp(
    `<(?:[^:>]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[^:>]+:)?${tag}>`,
  ).exec(xml)
  if (!match) {
    // Kendi kendine kapanan boş düğüm de VARDIR: `<ReferansNo />`.
    return new RegExp(`<(?:[^:>]+:)?${tag}\\b[^>]*/>`).test(xml) ? '' : null
  }
  return decodeXmlText(match[1] ?? '')
}

/**
 * Zarftaki HAM kullanıcı adı — YALNIZ parite karşılaştırması için.
 *
 * Dönen değer hiçbir yere YAZILMAZ ve loglanmaz; parmak izine çevrilip
 * atılır. Parite, telde GERÇEKTEN giden değerle ölçülmelidir.
 */
export function readEnvelopeKullaniciAdi(envelope: unknown): string {
  const text = typeof envelope === 'string' ? envelope : ''
  return (readTag(text, 'KullaniciAdi') ?? '').trim()
}

/**
 * NİHAİ SOAP zarfından güvenli anlık görüntü üretir.
 *
 * `envelope` ağ çağrısına gidecek OLAN metindir. Başka hiçbir kaynağa
 * bakılmaz — sipariş, config ve önceki operasyon satırları OKUNMAZ.
 */
export function captureSoapActualWire(params: {
  envelope?: unknown
  operation?: unknown
  serviceMode?: unknown
}): SoapWireCapture {
  const envelope = typeof params.envelope === 'string' ? params.envelope : ''
  const operation = String(params.operation ?? '')
  const serviceMode = String(params.serviceMode ?? '')

  const gonderiBody = readTag(envelope, 'Gonderi')
  const gonderiFieldNames: string[] = []
  const gonderiFieldTypes: Record<string, string> = {}
  if (gonderiBody !== null) {
    // Alan ADLARI görünür (sözleşme denetimi için), PII DEĞERLERİ asla.
    const tagPattern = /<(?:[^:>]+:)?([A-Za-z0-9_]+)\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:[^:>]+:)?\1>)/g
    let match: RegExpExecArray | null = tagPattern.exec(gonderiBody)
    while (match !== null) {
      const name = match[1]
      const raw = match[2] === undefined ? '' : decodeXmlText(match[2])
      gonderiFieldNames.push(name)
      gonderiFieldTypes[name] = soapValueRuntimeType(raw)
      match = tagPattern.exec(gonderiBody)
    }
  }

  const safeValues: Record<string, unknown> = {}
  for (const tag of SOAP_SAFE_VALUE_TAGS) {
    if (SOAP_PII_TAGS.has(tag)) continue
    const raw = gonderiBody === null ? null : readTag(gonderiBody, tag)
    safeValues[tag] = raw === null ? null : raw.trim()
  }

  const contractAbsentFields: Record<
    string, { present: boolean; runtimeType: string }
  > = {}
  for (const tag of SOAP_ABSENT_BY_CONTRACT_TAGS) {
    const raw = gonderiBody === null ? null : readTag(gonderiBody, tag)
    contractAbsentFields[tag] = {
      present: raw !== null,
      runtimeType: soapValueRuntimeType(raw),
    }
  }

  const kullaniciAdi = (readTag(envelope, 'KullaniciAdi') ?? '').trim()
  const sifre = readTag(envelope, 'Sifre') ?? ''
  return {
    envelopePresent: envelope.length > 0,
    operation,
    serviceMode,
    gonderiPresent: gonderiBody !== null,
    gonderiFieldNames,
    gonderiFieldTypes,
    safeValues,
    contractAbsentFields,
    credential: {
      kullaniciAdiPresent: kullaniciAdi.length > 0,
      sifrePresent: sifre.length > 0,
      // AĞ SINIRI parmak izi: NİHAİ zarftaki değerden hesaplanır.
      networkBoundaryAccountFingerprint: accountFingerprint(kullaniciAdi),
    },
    envelopeLength: envelope.length,
  }
}
