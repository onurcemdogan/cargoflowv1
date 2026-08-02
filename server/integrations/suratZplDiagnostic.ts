// Sürat resmî ZPL teşhisi — SAF sınıflandırma (DB/ağ/IO YOK).
//
// AMAÇ: production'da YENİ GÖNDERİ OLUŞTURMADAN, yalnız hâlihazırda persist
// edilmiş provider yanıtlarına bakarak "elimizdeki ZPL gerçekten Sürat'in
// resmî çıktısı mı, yoksa CargoFlow'un eski generated şablonu mu?" sorusunu
// kanıta bağlamak. Sürat API'si ÇAĞRILMAZ, DB'ye YAZILMAZ.
//
// ALAN ADI KÖK NEDENİ: persistence katmanı provider'ın BarcodeRaw'ını
// `technicalZpl` adı altında normalize eder (server/index.mjs →
// buildSafeZplReference: ZPL YALNIZ shipment.barcodeRaw /
// suratCreateLog.BarcodeRaw / parsedResponse.BarcodeRaw /
// createDiagnostics.officialBarcodeRaw alanlarından okunur). Bu yüzden
// `technicalZpl` "BarcodeRaw yok" DEMEK DEĞİLDİR; aynı artefaktın kayıttaki
// adıdır. Yanında technicalZplSha256 / technicalZplLength de saklanır.
//
// GİZLİLİK SÖZLEŞMESİ: bu modül ham ZPL, adres, telefon, müşteri adı, açık
// sipariş/takip numarası veya credential DÖNDÜRMEZ. Dışarı çıkan tek kayıt-
// düzeyi bilgi, ZPL'in SHA-256 özetinin ilk 12 karakteridir.
//
// Zarf/sayfa/kanıt kontrolü frontend ile AYNI saf doğrulayıcıdan gelir.
import { createHash } from 'node:crypto'
import { validateOfficialSuratZpl } from '../../src/utils/officialSuratLabel.ts'

// Production'da her iki provider kimliği de görülür. Teşhis ikisini de kapsar;
// tek bir isme sabitlemek kayıtları SESSİZCE sıfırlar.
export const SURAT_PROVIDER_ALIASES = ['surat', 'surat-kargo'] as const

export type ZplEnvelopeClass =
  | 'validZplEnvelope'
  | 'missingZpl'
  | 'invalidEnvelope'
  | 'multiPageProviderZpl'
  | 'trackingEvidenceMismatch'

export type ZplProvenance =
  | 'officialProviderZpl'
  | 'legacyGeneratedCargoFlowZpl'
  | 'provenanceUnknown'
  | 'notApplicable'

export interface SuratLabelArtifactInput {
  // Persist edilmiş ZPL (technicalZpl / barcodeRaw / legacy zplContent).
  zpl?: unknown
  zplSource?: unknown
  trackingNumber?: unknown
  barcode?: unknown
  // Kayıtla birlikte saklanan bütünlük özeti (buildSafeZplReference yazar).
  persistedZplSha256?: unknown
  // Ham create yanıtındaki BarcodeRaw'ın SHA-256'sı (varsa).
  rawResponseBarcodeRawSha256?: unknown
  hasPdfBarkod?: boolean
  pdfBarkodLength?: number
  // Hangi alandan okunduğu (zplFieldBuckets için).
  zplField?: string
}

export interface SuratArtifactClassification {
  envelopeClass: ZplEnvelopeClass
  provenance: ZplProvenance
  officialPdfAvailable: boolean
  fingerprint: string
  zplSourceBucket: string
}

export interface SuratZplDiagnosticReport {
  scannedCount: number
  validZplEnvelopeCount: number
  officialProviderZplCount: number
  legacyGeneratedCargoFlowZplCount: number
  provenanceUnknownCount: number
  missingZplCount: number
  // Sözleşmedeki listeye ek: geçersiz zarflar sessizce kaybolmasın diye
  // ayrıca sayılır (scannedCount aritmetiği denetlenebilir kalsın).
  invalidEnvelopeCount: number
  multiPageCount: number
  trackingMismatchCount: number
  officialPdfAvailableCount: number
  zplSourceBuckets: Record<string, number>
  zplFieldBuckets: Record<string, number>
  safeFingerprintSamples: Array<{
    fingerprint: string
    class: ZplEnvelopeClass
    provenance: ZplProvenance
  }>
}

export interface SuratZplDecision {
  decision:
    | 'OFFICIAL_ZPL_VERIFIED'
    | 'LEGACY_GENERATED_ONLY'
    | 'ZPL_FOUND_PROVENANCE_UNKNOWN'
    | 'NO_EVIDENCE'
  message: string
}

const MAX_SAMPLES_PER_CLASS = 3

// Provider kökenli olduğu AÇIKÇA işaretlenmiş kaynak etiketleri.
// 'surat.create.replayStoredZpl' de resmîdir: saklanan BarcodeRaw'ın replay'i.
const OFFICIAL_SOURCE_TOKENS = new Set([
  'surat.ortakbarkod.barcoderaw',
  'surat.create.replaystoredzpl',
])

// CargoFlow'un ESKİ generated şablonuna ÖZGÜ imzalar.
//
// DİKKAT: 'MUST.IRS.NO' ve 'Siparis No:' gibi metinler GERÇEK Sürat etiketinde
// de bulunur (eski şablon zaten fotoğraftan kopyalanmıştı). Bunları generated
// kanıtı saymak resmî ZPL'i yanlışlıkla "legacy" işaretler. Bu yüzden yalnız
// CargoFlow'a ÖZGÜ, provider çıktısında bulunmayan imzalar kullanılır.
const GENERATED_ONLY_MARKERS = ['SIPARIS URUNLERI', 'ürün daha']

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
export function fingerprintZpl(value: string): string {
  return sha256Hex(value).slice(0, 12)
}

export function isOfficialSourceToken(value: unknown): boolean {
  return OFFICIAL_SOURCE_TOKENS.has(String(value ?? '').trim().toLowerCase())
}

function looksGenerated(zpl: string, zplSource: string): boolean {
  if (zplSource.toLowerCase() === 'generated') return true
  return GENERATED_ONLY_MARKERS.some((marker) => zpl.includes(marker))
}

// Kökeni KANITLA belirler. Kanıt yoksa 'provenanceUnknown' döner —
// "muhtemelen resmî" DİYE İŞARETLEMEZ.
function resolveProvenance(
  zpl: string,
  input: SuratLabelArtifactInput,
): ZplProvenance {
  const zplSource = String(input.zplSource ?? '').trim()
  // 1) Eski CargoFlow şablonu önce elenir (yanlışlıkla "resmî" demeyelim).
  if (looksGenerated(zpl, zplSource)) return 'legacyGeneratedCargoFlowZpl'
  // 2) Açık provider metadata'sı.
  if (isOfficialSourceToken(zplSource)) return 'officialProviderZpl'
  const digest = sha256Hex(zpl)
  // 3) Ham create yanıtındaki BarcodeRaw ile birebir eşleşme.
  if (digest === String(input.rawResponseBarcodeRawSha256 ?? '')) {
    return 'officialProviderZpl'
  }
  // 4) Kayıtla saklanan bütünlük özeti ile eşleşme. buildSafeZplReference bu
  //    özeti YALNIZ BarcodeRaw alanlarından üretir; dolayısıyla eşleşme,
  //    artefaktın create anında provider'dan gelen ZPL olduğunun kanıtıdır.
  if (digest === String(input.persistedZplSha256 ?? '')) {
    return 'officialProviderZpl'
  }
  return 'provenanceUnknown'
}

export function classifySuratLabelArtifact(
  input: SuratLabelArtifactInput,
): SuratArtifactClassification {
  const zpl = typeof input.zpl === 'string' ? input.zpl : ''
  const zplSource = String(input.zplSource ?? '').trim() || 'unknown'
  const officialPdfAvailable = Boolean(
    input.hasPdfBarkod || (input.pdfBarkodLength ?? 0) > 0,
  )
  const fingerprint = zpl.trim() ? fingerprintZpl(zpl) : ''
  const base = { officialPdfAvailable, fingerprint, zplSourceBucket: zplSource }

  if (!zpl.trim()) {
    return { ...base, envelopeClass: 'missingZpl', provenance: 'notApplicable' }
  }

  const result = validateOfficialSuratZpl(zpl, {
    trackingNumber: String(input.trackingNumber ?? ''),
    barcode: String(input.barcode ?? ''),
  })
  const provenance = resolveProvenance(zpl, input)

  if (
    result.rejection === 'not_zpl' ||
    result.rejection === 'too_small' ||
    result.rejection === 'too_large'
  ) {
    // Zarf bozuksa köken sorusu anlamsızdır.
    return { ...base, envelopeClass: 'invalidEnvelope', provenance: 'notApplicable' }
  }
  if (result.rejection === 'multi_page') {
    return { ...base, envelopeClass: 'multiPageProviderZpl', provenance }
  }
  if (
    result.rejection === 'web_barcode_only' ||
    result.rejection === 'barcode_mismatch'
  ) {
    return { ...base, envelopeClass: 'trackingEvidenceMismatch', provenance }
  }
  return { ...base, envelopeClass: 'validZplEnvelope', provenance }
}

function pick(root: unknown, paths: string[][]): { value: unknown; field: string } {
  for (const path of paths) {
    let node: unknown = root
    for (const key of path) {
      if (node == null || typeof node !== 'object') { node = undefined; break }
      node = (node as Record<string, unknown>)[key]
    }
    if (node != null && node !== '') return { value: node, field: path.join('.') }
  }
  return { value: undefined, field: '' }
}

// Persist edilmiş carrier/response payload'undan teşhis için gereken MİNİMUM
// alanları çıkarır. PDF için yalnız VARLIK + UZUNLUK alınır; base64 içerik
// ASLA taşınmaz.
export function extractSuratLabelArtifact(
  payload: unknown,
): SuratLabelArtifactInput {
  // Öncelik: persist edilmiş technicalZpl (production'daki gerçek alan) →
  // shipment.barcodeRaw → ham yanıttaki BarcodeRaw → eski label artifact'leri.
  const zpl = pick(payload, [
    ['technicalZpl'],
    ['shipment', 'technicalZpl'],
    ['shipment', 'barcodeRaw'],
    ['barcodeRaw'],
    ['shipment', 'suratCreateLog', 'BarcodeRaw'],
    ['shipment', 'suratCreateLog', 'parsedResponse', 'BarcodeRaw'],
    ['shipment', 'rawResponse', 'parsedResponse', 'BarcodeRaw'],
    ['createDiagnostics', 'officialBarcodeRaw'],
    ['BarcodeRaw'],
    // Eski label artifact alanları.
    ['label', 'zplContent'],
    ['shipment', 'label', 'zplContent'],
    ['zplContent'],
  ])
  // Ham create yanıtındaki BarcodeRaw — köken eşleştirmesi için ayrıca alınır.
  const rawBarcodeRaw = pick(payload, [
    ['shipment', 'suratCreateLog', 'parsedResponse', 'BarcodeRaw'],
    ['shipment', 'suratCreateLog', 'BarcodeRaw'],
    ['shipment', 'rawResponse', 'parsedResponse', 'BarcodeRaw'],
    ['createDiagnostics', 'officialBarcodeRaw'],
    ['BarcodeRaw'],
  ])
  const pdf = pick(payload, [
    ['shipment', 'labelPdfBase64'],
    ['shipment', 'pdfBarkodBase64'],
    ['shipment', 'PdfBarkod'],
    ['shipment', 'suratCreateLog', 'PdfBarkod'],
    ['labelPdfBase64'],
    ['pdfBarkodBase64'],
    ['PdfBarkod'],
  ])
  const pdfFlag = pick(payload, [
    ['shipment', 'hasPdfBarkod'],
    ['shipment', 'pdfReady'],
    ['hasPdfBarkod'],
    ['pdfReady'],
  ])
  return {
    zpl: zpl.value,
    zplField: zpl.field || 'none',
    zplSource: pick(payload, [
      ['shipment', 'zplSource'],
      ['shipment', 'suratCreateLog', 'zplSource'],
      ['label', 'zplSource'],
      ['zplSource'],
    ]).value,
    trackingNumber: pick(payload, [
      ['shipment', 'trackingNumber'],
      ['shipment', 'tNo'],
      ['shipment', 'kargoTakipNo'],
      ['carrierTrackingNumber'],
      ['candidateTrackingNumber'],
    ]).value,
    barcode: pick(payload, [
      ['shipment', 'barkodNo'],
      ['shipment', 'barcode'],
      ['shipment', 'barcodeValue'],
      ['carrierBarcodeNumber'],
      ['candidateBarcodeNumber'],
    ]).value,
    persistedZplSha256: pick(payload, [
      ['technicalZplSha256'],
      ['shipment', 'technicalZplSha256'],
    ]).value,
    rawResponseBarcodeRawSha256:
      typeof rawBarcodeRaw.value === 'string' && rawBarcodeRaw.value
        ? sha256Hex(rawBarcodeRaw.value)
        : undefined,
    hasPdfBarkod: pdfFlag.value === true || typeof pdf.value === 'string',
    pdfBarkodLength: typeof pdf.value === 'string' ? pdf.value.length : 0,
  }
}

export function summarizeSuratZplDiagnostic(
  inputs: SuratLabelArtifactInput[],
): SuratZplDiagnosticReport {
  const report: SuratZplDiagnosticReport = {
    scannedCount: 0,
    validZplEnvelopeCount: 0,
    officialProviderZplCount: 0,
    legacyGeneratedCargoFlowZplCount: 0,
    provenanceUnknownCount: 0,
    missingZplCount: 0,
    invalidEnvelopeCount: 0,
    multiPageCount: 0,
    trackingMismatchCount: 0,
    officialPdfAvailableCount: 0,
    zplSourceBuckets: {},
    zplFieldBuckets: {},
    safeFingerprintSamples: [],
  }
  const perClassSamples = new Map<ZplEnvelopeClass, number>()

  for (const input of inputs) {
    const c = classifySuratLabelArtifact(input)
    report.scannedCount += 1
    if (c.officialPdfAvailable) report.officialPdfAvailableCount += 1
    report.zplSourceBuckets[c.zplSourceBucket] =
      (report.zplSourceBuckets[c.zplSourceBucket] ?? 0) + 1
    const field = String(input.zplField ?? 'none') || 'none'
    report.zplFieldBuckets[field] = (report.zplFieldBuckets[field] ?? 0) + 1

    switch (c.envelopeClass) {
      case 'validZplEnvelope': report.validZplEnvelopeCount += 1; break
      case 'missingZpl': report.missingZplCount += 1; break
      case 'invalidEnvelope': report.invalidEnvelopeCount += 1; break
      case 'multiPageProviderZpl': report.multiPageCount += 1; break
      case 'trackingEvidenceMismatch': report.trackingMismatchCount += 1; break
    }
    switch (c.provenance) {
      case 'officialProviderZpl': report.officialProviderZplCount += 1; break
      case 'legacyGeneratedCargoFlowZpl':
        report.legacyGeneratedCargoFlowZplCount += 1; break
      case 'provenanceUnknown': report.provenanceUnknownCount += 1; break
    }

    const taken = perClassSamples.get(c.envelopeClass) ?? 0
    if (c.fingerprint && taken < MAX_SAMPLES_PER_CLASS) {
      perClassSamples.set(c.envelopeClass, taken + 1)
      report.safeFingerprintSamples.push({
        fingerprint: c.fingerprint,
        class: c.envelopeClass,
        provenance: c.provenance,
      })
    }
  }
  return report
}

// Deploy kararı. Cümleler sabittir: operatör karar kaydı olarak kopyalayabilsin.
export function decideSuratZplReadiness(
  report: SuratZplDiagnosticReport,
): SuratZplDecision {
  if (report.officialProviderZplCount > 0) {
    return {
      decision: 'OFFICIAL_ZPL_VERIFIED',
      message: 'Resmî Sürat ZPL production verisinde doğrulandı.',
    }
  }
  if (
    report.legacyGeneratedCargoFlowZplCount > 0 &&
    report.provenanceUnknownCount === 0
  ) {
    return {
      decision: 'LEGACY_GENERATED_ONLY',
      message:
        'Kayıtlardaki ZPL yalnız CargoFlow’un eski generated şablonudur; ' +
        'resmî provider ZPL kanıtı yok. Eski kayıtlar korunur, yeniden ' +
        'üretilmez; deploy öncesi kontrollü tek test gönderisi gerekir.',
    }
  }
  if (
    report.validZplEnvelopeCount > 0 ||
    report.provenanceUnknownCount > 0 ||
    report.legacyGeneratedCargoFlowZplCount > 0
  ) {
    return {
      decision: 'ZPL_FOUND_PROVENANCE_UNKNOWN',
      message:
        'Geçerli ZPL bulundu ancak provider/generated kökeni kanıtlanamadı; ' +
        'resmî sayılmaz. Deploy öncesi kontrollü tek test gönderisi gerekir.',
    }
  }
  return {
    decision: 'NO_EVIDENCE',
    message:
      'Mevcut kayıtlarla doğrulanamadı; kontrollü tek test gönderisi ' +
      'olmadan deploy onaylanamaz.',
  }
}
