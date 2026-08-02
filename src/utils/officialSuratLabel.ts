// Sürat'in RESMÎ etiket ZPL'i için doğrulayıcı (SAF).
//
// KARAR: Sürat etiketi CargoFlow tarafından yeniden TASARLANMAZ. Tek kaynak
// doğrusu Sürat'in kendi yanıtındaki ZPL'dir (OrtakBarkodOlustur → BarcodeRaw).
// Bu modül yalnız DOĞRULAR; ZPL'i DEĞİŞTİRMEZ, yeniden üretmez, koordinat/font
// dokunmaz. Geçerliyse byte-for-byte aynen kullanılır.
//
// Güvenlik sözleşmesi (kod tabanında zaten uygulanan kural): "Web" ile başlayan
// dahilî kod OPERASYONEL barkod sayılmaz. Resmî ZPL yalnız canonical numerik
// barkodu taşıyorsa baskıya uygundur; aksi halde SESSİZCE basılmaz.
//
// Bu dosya SAF'tır: hiçbir import'u yoktur, DOM/Node API'sine dokunmaz. Böylece
// hem frontend hem de server-side read-only diagnostic aynı doğrulayıcıyı
// paylaşır (kural çatallanmasın).

export type OfficialLabelRejection =
  | 'missing'
  | 'not_zpl'
  | 'multi_page'
  | 'too_small'
  | 'too_large'
  | 'barcode_mismatch'
  | 'web_barcode_only'

export interface OfficialLabelResult {
  ok: boolean
  zpl: string
  pageCount: number
  rejection: OfficialLabelRejection | null
  reason: string
}

// Makul boyut sınırları: boş/kırpık veya beklenmedik dev payload'ı ele.
const MIN_ZPL_LENGTH = 40
const MAX_ZPL_LENGTH = 512_000

function looksLikeErrorPayload(text: string): boolean {
  const head = text.slice(0, 200).trimStart().toLowerCase()
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('{') ||
    head.startsWith('[')
  )
}

// Resmî ZPL'i doğrular. DEĞİŞTİRMEZ. expected* verilirse ZPL'in canonical
// takip/barkod değerini gerçekten taşıdığı da kanıtlanır (yanlış etiket basma
// riskine karşı).
export function validateOfficialSuratZpl(
  rawZpl: unknown,
  expected: { trackingNumber?: string; barcode?: string } = {},
): OfficialLabelResult {
  const zpl = String(rawZpl ?? '')
  const fail = (
    rejection: OfficialLabelRejection,
    reason: string,
  ): OfficialLabelResult => ({ ok: false, zpl: '', pageCount: 0, rejection, reason })

  if (!zpl.trim()) {
    return fail('missing', 'Sürat resmî etiketi (ZPL) yanıtta bulunamadı.')
  }
  if (looksLikeErrorPayload(zpl)) {
    return fail('not_zpl', 'Sürat etiket yanıtı ZPL değil (HTML/JSON hata gövdesi).')
  }
  const trimmed = zpl.trim()
  if (!trimmed.startsWith('^XA') || !trimmed.endsWith('^XZ')) {
    return fail('not_zpl', 'Sürat etiket verisi ^XA ile başlayıp ^XZ ile bitmiyor.')
  }
  if (trimmed.length < MIN_ZPL_LENGTH) {
    return fail('too_small', 'Sürat resmî etiketi beklenenden kısa (bozuk olabilir).')
  }
  if (trimmed.length > MAX_ZPL_LENGTH) {
    return fail('too_large', 'Sürat resmî etiketi beklenmedik biçimde büyük.')
  }

  // TEK fiziksel etiket invariantı: bir gönderi = bir ^XA…^XZ.
  const pageCount = (trimmed.match(/\^XA/g) ?? []).length
  if (pageCount !== 1) {
    return {
      ok: false,
      zpl: trimmed,
      pageCount,
      rejection: 'multi_page',
      reason:
        `Sürat resmî ZPL'i ${pageCount} sayfa (^XA) içeriyor. Provider çıktısı ` +
        'sessizce değiştirilmez; onay olmadan baskıya gönderilmez.',
    }
  }

  // Canonical kimlik kanıtı: ZPL gerçekten beklenen takip/barkod değerini
  // taşımalı. Taşımıyorsa YANLIŞ etiket basma riski vardır.
  const expectedBarcode = String(expected.barcode ?? '').trim()
  const expectedTracking = String(expected.trackingNumber ?? '').trim()
  const hasBarcode = expectedBarcode ? trimmed.includes(expectedBarcode) : true
  const hasTracking = expectedTracking ? trimmed.includes(expectedTracking) : true
  if (!hasBarcode && !hasTracking) {
    // "Web..." dahilî kodu taşıyan ama canonical numerik kodu taşımayan ZPL:
    // operasyonel baskıya UYGUN DEĞİLDİR.
    const webOnly = /\^FD\s*web[0-9a-z-]+/i.test(trimmed)
    return webOnly
      ? fail(
          'web_barcode_only',
          'Sürat resmî ZPL\'i yalnız dahilî "Web" kodu taşıyor; canonical ' +
            'numerik kargo barkodu yok. Operasyonel baskı açılmaz.',
        )
      : fail(
          'barcode_mismatch',
          'Sürat resmî ZPL\'i beklenen takip numarası/barkodu içermiyor.',
        )
  }

  return { ok: true, zpl: trimmed, pageCount: 1, rejection: null, reason: '' }
}
