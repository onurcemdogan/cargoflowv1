// Sürat resmî ZPL teşhisi — SAF sınıflandırma (DB/ağ/IO YOK).
//
// AMAÇ: production'da YENİ GÖNDERİ OLUŞTURMADAN, yalnız hâlihazırda persist
// edilmiş provider yanıtlarına bakarak "Sürat gerçekten resmî ZPL veriyor mu?"
// sorusunu kanıta bağlamak. Sürat API'si ÇAĞRILMAZ, DB'ye YAZILMAZ.
//
// GİZLİLİK SÖZLEŞMESİ: bu modül ham ZPL, adres, telefon, müşteri adı, açık
// sipariş/takip numarası veya credential DÖNDÜRMEZ. Dışarı çıkan tek kayıt-
// düzeyi bilgi, ZPL'in SHA-256 özetinin ilk 12 karakteri + sınıf adıdır.
//
// Doğrulama kuralı çatallanmasın diye zarf/sayfa/kanıt kontrolü frontend ile
// AYNI saf doğrulayıcıdan gelir.
import { createHash } from 'node:crypto'
import { validateOfficialSuratZpl } from '../../src/utils/officialSuratLabel.ts'

export type SuratZplClass =
  | 'validOfficialZpl'
  | 'webInternalCodeOnly'
  | 'missingBarcodeRaw'
  | 'invalidEnvelope'
  | 'multiPageProviderZpl'
  | 'trackingEvidenceMismatch'
  | 'persistedGeneratedLegacyZpl'

// Teşhise giren TEK kayıt. Çağıran (CLI) bunu DB'den çözer; buraya yalnız
// sınıflandırma için gereken minimum alan gelir.
export interface SuratLabelArtifactInput {
  barcodeRaw?: unknown
  zplSource?: unknown
  trackingNumber?: unknown
  barcode?: unknown
  // PdfBarkod'un KENDİSİ değil, yalnız varlık/uzunluk metadata'sı.
  hasPdfBarkod?: boolean
  pdfBarkodLength?: number
}

export interface SuratArtifactClassification {
  primaryClass: SuratZplClass
  officialPdfAvailable: boolean
  // SHA-256 ilk 12 karakter. Ham ZPL'i geri getirmez; yalnız aynı/farklı
  // artefaktları ayırt etmeye ve tekrar üretilebilir kanıta yarar.
  fingerprint: string
  zplSourceBucket: string
}

export interface SuratZplDiagnosticReport {
  scannedCount: number
  validOfficialZplCount: number
  webInternalCodeOnlyCount: number
  missingBarcodeRawCount: number
  invalidEnvelopeCount: number
  multiPageCount: number
  trackingMismatchCount: number
  officialPdfAvailableCount: number
  legacyGeneratedCount: number
  zplSourceBuckets: Record<string, number>
  safeFingerprintSamples: Array<{ fingerprint: string; class: SuratZplClass }>
}

export interface SuratZplDecision {
  decision:
    | 'OFFICIAL_ZPL_VERIFIED'
    | 'PDF_ONLY'
    | 'WEB_CODE_ONLY'
    | 'NO_EVIDENCE'
  message: string
}

// Her sınıftan en fazla bu kadar parmak izi örneklenir (çıktı şişmesin).
const MAX_SAMPLES_PER_CLASS = 3

// Eski CargoFlow generated şablonunun imzaları. Bu kayıtlar DEĞİŞTİRİLMEZ ve
// yeniden ÜRETİLMEZ; yalnız "resmî provider ZPL'i" sayılmamaları için ayrılır.
const GENERATED_TEMPLATE_MARKERS = [
  'MUST.IRS.NO',
  'SIPARIS URUNLERI',
  'Siparis No:',
  'ürün daha',
]

export function fingerprintZpl(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
}

function looksGenerated(zpl: string, zplSource: string): boolean {
  if (zplSource === 'generated') return true
  return GENERATED_TEMPLATE_MARKERS.some((marker) => zpl.includes(marker))
}

// TEK kaydı sınıflandırır. Öncelik sırası bilinçlidir: "yok" → "bozuk zarf" →
// "çok sayfa" → "eski generated" → "yalnız Web kodu" → "kanıt uyuşmuyor" →
// geriye kalan tek durum resmî ve geçerli ZPL'dir.
export function classifySuratLabelArtifact(
  input: SuratLabelArtifactInput,
): SuratArtifactClassification {
  const zpl = typeof input.barcodeRaw === 'string' ? input.barcodeRaw : ''
  const zplSource = String(input.zplSource ?? '').trim() || 'unknown'
  const officialPdfAvailable = Boolean(
    input.hasPdfBarkod || (input.pdfBarkodLength ?? 0) > 0,
  )
  const fingerprint = zpl.trim() ? fingerprintZpl(zpl) : ''
  const base = { officialPdfAvailable, fingerprint, zplSourceBucket: zplSource }

  if (!zpl.trim()) {
    return { ...base, primaryClass: 'missingBarcodeRaw' }
  }

  const result = validateOfficialSuratZpl(zpl, {
    trackingNumber: String(input.trackingNumber ?? ''),
    barcode: String(input.barcode ?? ''),
  })

  if (result.rejection === 'not_zpl' || result.rejection === 'too_small' ||
      result.rejection === 'too_large') {
    return { ...base, primaryClass: 'invalidEnvelope' }
  }
  if (result.rejection === 'multi_page') {
    return { ...base, primaryClass: 'multiPageProviderZpl' }
  }
  // Zarf sağlam. Eski CargoFlow şablonu mu, gerçekten provider çıktısı mı?
  if (looksGenerated(zpl, zplSource)) {
    return { ...base, primaryClass: 'persistedGeneratedLegacyZpl' }
  }
  if (result.rejection === 'web_barcode_only') {
    return { ...base, primaryClass: 'webInternalCodeOnly' }
  }
  if (result.rejection === 'barcode_mismatch') {
    return { ...base, primaryClass: 'trackingEvidenceMismatch' }
  }
  return { ...base, primaryClass: 'validOfficialZpl' }
}

function pick(root: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    let node: unknown = root
    for (const key of path) {
      if (node == null || typeof node !== 'object') { node = undefined; break }
      node = (node as Record<string, unknown>)[key]
    }
    if (node != null && node !== '') return node
  }
  return undefined
}

// Persist edilmiş carrier payload'undan teşhis için gereken MİNİMUM alanları
// çıkarır. PDF için yalnız VARLIK + UZUNLUK alınır; base64 içerik ASLA taşınmaz.
export function extractSuratLabelArtifact(
  carrierPayload: unknown,
): SuratLabelArtifactInput {
  const p = carrierPayload
  const pdf = pick(p, [
    ['shipment', 'labelPdfBase64'],
    ['shipment', 'pdfBarkodBase64'],
    ['shipment', 'PdfBarkod'],
    ['shipment', 'suratCreateLog', 'PdfBarkod'],
    ['labelPdfBase64'],
    ['pdfBarkodBase64'],
    ['PdfBarkod'],
  ])
  const pdfFlag = pick(p, [
    ['shipment', 'hasPdfBarkod'],
    ['shipment', 'pdfReady'],
    ['hasPdfBarkod'],
    ['pdfReady'],
  ])
  return {
    barcodeRaw: pick(p, [
      ['shipment', 'barcodeRaw'],
      ['shipment', 'suratCreateLog', 'BarcodeRaw'],
      ['shipment', 'suratCreateLog', 'parsedResponse', 'BarcodeRaw'],
      ['shipment', 'rawResponse', 'parsedResponse', 'BarcodeRaw'],
      ['barcodeRaw'],
      ['BarcodeRaw'],
    ]),
    zplSource: pick(p, [
      ['shipment', 'zplSource'],
      ['label', 'zplSource'],
      ['zplSource'],
    ]),
    trackingNumber: pick(p, [
      ['shipment', 'trackingNumber'],
      ['shipment', 'tNo'],
      ['shipment', 'kargoTakipNo'],
      ['carrierTrackingNumber'],
      ['candidateTrackingNumber'],
    ]),
    barcode: pick(p, [
      ['shipment', 'barkodNo'],
      ['shipment', 'barcode'],
      ['shipment', 'barcodeValue'],
      ['carrierBarcodeNumber'],
      ['candidateBarcodeNumber'],
    ]),
    hasPdfBarkod: pdfFlag === true || typeof pdf === 'string',
    pdfBarkodLength: typeof pdf === 'string' ? pdf.length : 0,
  }
}

export function summarizeSuratZplDiagnostic(
  inputs: SuratLabelArtifactInput[],
): SuratZplDiagnosticReport {
  const report: SuratZplDiagnosticReport = {
    scannedCount: 0,
    validOfficialZplCount: 0,
    webInternalCodeOnlyCount: 0,
    missingBarcodeRawCount: 0,
    invalidEnvelopeCount: 0,
    multiPageCount: 0,
    trackingMismatchCount: 0,
    officialPdfAvailableCount: 0,
    legacyGeneratedCount: 0,
    zplSourceBuckets: {},
    safeFingerprintSamples: [],
  }
  const perClassSamples = new Map<SuratZplClass, number>()

  for (const input of inputs) {
    const c = classifySuratLabelArtifact(input)
    report.scannedCount += 1
    if (c.officialPdfAvailable) report.officialPdfAvailableCount += 1
    report.zplSourceBuckets[c.zplSourceBucket] =
      (report.zplSourceBuckets[c.zplSourceBucket] ?? 0) + 1

    switch (c.primaryClass) {
      case 'validOfficialZpl': report.validOfficialZplCount += 1; break
      case 'webInternalCodeOnly': report.webInternalCodeOnlyCount += 1; break
      case 'missingBarcodeRaw': report.missingBarcodeRawCount += 1; break
      case 'invalidEnvelope': report.invalidEnvelopeCount += 1; break
      case 'multiPageProviderZpl': report.multiPageCount += 1; break
      case 'trackingEvidenceMismatch': report.trackingMismatchCount += 1; break
      case 'persistedGeneratedLegacyZpl': report.legacyGeneratedCount += 1; break
    }

    const taken = perClassSamples.get(c.primaryClass) ?? 0
    if (c.fingerprint && taken < MAX_SAMPLES_PER_CLASS) {
      perClassSamples.set(c.primaryClass, taken + 1)
      report.safeFingerprintSamples.push({
        fingerprint: c.fingerprint,
        class: c.primaryClass,
      })
    }
  }
  return report
}

// Deploy kararı. Rapor cümleleri bilinçli olarak sabittir: operatör bunları
// karar kaydı olarak kopyalayabilsin.
export function decideSuratZplReadiness(
  report: SuratZplDiagnosticReport,
): SuratZplDecision {
  if (report.validOfficialZplCount > 0) {
    return {
      decision: 'OFFICIAL_ZPL_VERIFIED',
      message: 'Resmî Sürat ZPL production verisinde doğrulandı.',
    }
  }
  if (report.officialPdfAvailableCount > 0) {
    return {
      decision: 'PDF_ONLY',
      message:
        'Provider yalnız resmî PDF sağlıyor olabilir; PDF’yi ZPL’ye ' +
        'çevirmeden önce baskı mimarisi kararı gerekir.',
    }
  }
  if (report.webInternalCodeOnlyCount > 0) {
    return {
      decision: 'WEB_CODE_ONLY',
      message:
        'BarcodeRaw resmî etiket değildir; mevcut hard-block ile deploy ' +
        'operasyonu durdurur.',
    }
  }
  return {
    decision: 'NO_EVIDENCE',
    message:
      'Mevcut kayıtlarla doğrulanamadı; kontrollü tek test gönderisi ' +
      'olmadan deploy onaylanamaz.',
  }
}
