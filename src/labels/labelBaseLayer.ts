// TABAN KATMAN — RESMÎ SÜRAT ETİKETİ.
//
// ═══ ÜRÜN KURALI ═════════════════════════════════════════════════════════
// Bu bir "sıfırdan etiket tasarım aracı" DEĞİLDİR. Kiracı BOŞ bir tuval
// üstünde çalışmaz; taşıyıcının GERÇEK etiketinin üstüne kontrollü ekleme
// yapar. Bu yüzden düzenleyicinin tabanı taşıyıcı çıktısının KENDİSİDİR:
// aynı ZPL'den üretilmiş PNG.
//
// ═══ NEDEN PNG ═══════════════════════════════════════════════════════════
// Taşıyıcı etiketinin gövdesini CargoFlow ÇİZMEZ — çizerse taşıyıcının
// yerleşimini taklit etmiş olur ve şablon değiştiğinde sessizce ayrışır.
// Taban, taşıyıcı ZPL'inin RENDER EDİLMİŞ hâlidir: ne eklenir ne çıkarılır.
// Böylece "önizlemede gördüğün taşıyıcı etiketi" ile "basılan taşıyıcı
// etiketi" AYNI baytlardan gelir (`renderSha256` ile kanıtlanır).
//
// ═══ KİLİTLİ BÖLGELER ════════════════════════════════════════════════════
// Kiracının eklediği katman taşıyıcının kimlik alanlarını KAPATAMAZ.
// Bölgeler uydurulmaz: aynı semantic parser'dan (`resolveSuratSemanticModel`)
// gelen GERÇEK alan koordinatlarından türetilir. Şablon değişirse bölgeler
// de değişir — elle bakımı gereken ikinci bir koordinat listesi YOKTUR.
//
// SAF: ağ yok, DOM yok, render yok.

import {
  LABEL_CANVAS_HEIGHT_MM,
  LABEL_CANVAS_WIDTH_MM,
  type RectMm,
} from './labelGeometry.ts'
import {
  resolveSuratSemanticModel,
  type SuratSemanticKey,
} from '../utils/suratSemanticParser.ts'
import { fieldTextBox } from '../utils/zplTextGeometry.ts'
import { collectZplFields, parseZplDocument } from '../utils/zplCommandModel.ts'

/**
 * TAŞIYICI ETİKETİNİN DOT GENİŞLİĞİ — ZPL `^PW`/`^LL` ile beyan edilir.
 *
 * ═══ NEDEN 8 DOT/MM DEĞİL ════════════════════════════════════════════════
 * Render servisi kolaylık olsun diye 8 dot/mm kullanır ve 799 dot'u
 * 99.875 mm olarak raporlar. FİZİKSEL gerçek bu değildir: etiket 203 dpi'da
 * basılan 100×100 mm'lik bir etikettir (203 dpi ≈ 7.99 dot/mm).
 *
 * Kiracı katmanı ile taşıyıcı tabanı AYNI koordinat sisteminde olmalıdır;
 * aksi halde bölgeler bir milimetrenin sekizde biri kadar kayar ve muhafız
 * yanlış yerde tetiklenir. Bu yüzden dönüşüm, 799 dot'u tuvalin TAM
 * genişliğine (100 mm) eşler. Tek dönüşüm noktası budur.
 */
export const SURAT_LABEL_DOTS = 799

export function dotsToLabelMm(dots: number): number {
  return (dots * LABEL_CANVAS_WIDTH_MM) / SURAT_LABEL_DOTS
}

/** Bölgeyi tuval sınırlarına kenetler — taşan kutu muhafızı yanıltırdı. */
function clampRect(rect: RectMm): RectMm {
  const x = Math.max(0, Math.min(rect.x, LABEL_CANVAS_WIDTH_MM))
  const y = Math.max(0, Math.min(rect.y, LABEL_CANVAS_HEIGHT_MM))
  return {
    x,
    y,
    width: Math.max(0, Math.min(rect.width, LABEL_CANVAS_WIDTH_MM - x)),
    height: Math.max(0, Math.min(rect.height, LABEL_CANVAS_HEIGHT_MM - y)),
  }
}

/**
 * BÖLGE SINIFI — kiracı katmanının o bölgeye girmesi ne kadar tehlikeli?
 *
 * `identity`     : barkod, T.No, QR/DataMatrix. Okunamayan kimlik = kayıp
 *                  paket. Üstüne bir şey KONULAMAZ.
 * `operational`  : rota, aktarma merkezi, şube, teslim tipi, parça adedi.
 * ��                Kuryenin yönlendirme bilgisidir; kapatılması gönderiyi
 *                  yanlış yere götürür. Üstüne bir şey KONULAMAZ.
 * `informational`: alıcı/gönderici adı, adres, telefon, ödeme, desi.
 *                  Kapatmak kötü fikirdir ama gönderiyi kaybettirmez;
 *                  operatör UYARILIR, yayınlama engellenmez.
 */
export type CarrierZoneClass = 'identity' | 'operational' | 'informational'

const ZONE_CLASS: Record<SuratSemanticKey, CarrierZoneClass> = {
  code128Payload: 'identity',
  dataMatrixPayload: 'identity',
  tNo: 'identity',
  routeCode: 'operational',
  transferCenter: 'operational',
  branch: 'operational',
  deliveryType: 'operational',
  parcelCount: 'operational',
  unit: 'operational',
  paymentType: 'operational',
  desiKg: 'operational',
  sender: 'informational',
  senderInvoice: 'informational',
  senderPhone: 'informational',
  recipient: 'informational',
  addressLine1: 'informational',
  addressLine2: 'informational',
  recipientPhone: 'informational',
  cityDistrict: 'informational',
  orderReference: 'informational',
}

const ZONE_LABEL: Record<SuratSemanticKey, string> = {
  code128Payload: 'Ana barkod',
  dataMatrixPayload: 'DataMatrix',
  tNo: 'Takip numarası (T.No)',
  routeCode: 'Rota kodu',
  transferCenter: 'Aktarma merkezi',
  branch: 'Şube',
  deliveryType: 'Teslim tipi',
  parcelCount: 'Parça adedi',
  unit: 'Birim',
  paymentType: 'Ödeme tipi',
  desiKg: 'Desi / kg',
  sender: 'Gönderici',
  senderInvoice: 'Gönderici irsaliye',
  senderPhone: 'Gönderici telefon',
  recipient: 'Alıcı adı',
  addressLine1: 'Alıcı adres 1',
  addressLine2: 'Alıcı adres 2',
  recipientPhone: 'Alıcı telefon',
  cityDistrict: 'İl / ilçe',
  orderReference: 'Sipariş referansı',
}

const ZONE_REASON: Record<CarrierZoneClass, string> = {
  identity:
    'Taşıyıcı kimlik alanı. Okunamayan barkod/takip = kaybolan paket; ' +
    'bu alanın üstü KAPATILAMAZ.',
  operational:
    'Taşıyıcı operasyon alanı. Kuryenin yönlendirme bilgisidir; ' +
    'kapatılması gönderiyi yanlış yere götürür.',
  informational:
    'Taşıyıcı bilgi alanı. Kapatmak önerilmez; operatör uyarılır.',
}

export interface CarrierZone {
  /** Kararlı kimlik — muhafız mesajları ve testler buna dayanır. */
  id: string
  key: SuratSemanticKey | 'barcodeGraphic' | 'qrGraphic' | 'dataMatrixGraphic'
  label: string
  zoneClass: CarrierZoneClass
  /** Neden kilitli? Arayüz bunu operatöre AYNEN gösterir. */
  reason: string
  rect: RectMm
}

/** Grafik (barkod/QR/DataMatrix) alanları için sınıf ve etiket. */
const GRAPHIC_ZONES: Record<
  string,
  { key: CarrierZone['key']; label: string }
> = {
  code128: { key: 'barcodeGraphic', label: 'Ana barkod (çizim)' },
  qr: { key: 'qrGraphic', label: 'QR kod (çizim)' },
  datamatrix: { key: 'dataMatrixGraphic', label: 'DataMatrix (çizim)' },
}

/**
 * Barkod/QR çizim yüksekliği ZPL'de metin gibi ölçülemez: `^BY`/`^BC`
 * parametrelerine bağlıdır. Ölçülen gerçek Sürat etiketinde Code128 bandı
 * ~17 mm, QR/DataMatrix ~16 mm karedir. Bu değerler TEMKİNLİ (gerçek
 * çizimden biraz GENİŞ) tutulur: dar bir tahmin, kimliğin kenarına öğe
 * konmasına izin verirdi.
 */
const CODE128_BAND_MM = 18
const MATRIX_SIZE_MM = 17

/**
 * Taşıyıcı etiketindeki KORUNAN bölgeler.
 *
 * Koordinatlar ZPL'in kendisinden gelir; sabit bir liste DEĞİLDİR.
 */
export function deriveCarrierZones(zpl: string): CarrierZone[] {
  const source = String(zpl ?? '')
  if (!source.trim()) return []
  const semantic = resolveSuratSemanticModel(source)
  const zones: CarrierZone[] = []

  if (semantic.supported) {
    for (const [rawKey, field] of Object.entries(semantic.fields)) {
      const key = rawKey as SuratSemanticKey
      if (!field || field.empty) continue
      const box = fieldTextBox(field.field)
      if (!box) continue
      const zoneClass = ZONE_CLASS[key] ?? 'informational'
      zones.push({
        id: `carrier-${key}`,
        key,
        label: ZONE_LABEL[key] ?? key,
        zoneClass,
        reason: ZONE_REASON[zoneClass],
        rect: clampRect({
          x: dotsToLabelMm(box.x),
          y: dotsToLabelMm(box.y),
          width: dotsToLabelMm(box.width),
          height: dotsToLabelMm(box.height),
        }),
      })
    }
  }

  // Grafik kimlikler: metin kutusu yok, çizim bandı var.
  const fields = collectZplFields(parseZplDocument(source))
  for (const field of fields) {
    const graphic = GRAPHIC_ZONES[field.kind]
    if (!graphic) continue
    const size = field.kind === 'code128' ? CODE128_BAND_MM : MATRIX_SIZE_MM
    const width =
      field.kind === 'code128'
        ? dotsToLabelMm(700) // barkod bandı etiket genişliğini kaplar
        : size
    zones.push({
      id: `carrier-${graphic.key}`,
      key: graphic.key,
      label: graphic.label,
      zoneClass: 'identity',
      reason: ZONE_REASON.identity,
      rect: clampRect({
        x: dotsToLabelMm(field.x),
        // `^FT`/`^FO` farkı: barkodlar `^FT` ile TABANDAN konumlanır.
        y:
          field.positionType === 'FT'
            ? dotsToLabelMm(field.y) - size
            : dotsToLabelMm(field.y),
        width,
        height: size,
      }),
    })
  }

  return zones
}

/**
 * TABAN KATMAN — düzenleyicinin ve baskının ALT katmanı.
 *
 * `renderSha256` taban görüntünün kimliğidir: önizleme ile baskının AYNI
 * tabanı kullandığı bu alanla kanıtlanır.
 */
export interface LabelBaseLayer {
  kind: 'surat_official'
  /** Taşıyıcı etiketinin render edilmiş PNG'si (base64, veri yok). */
  imageBase64: string
  widthMm: number
  heightMm: number
  /** Render edilen görüntünün özeti — parite kanıtı. */
  renderSha256: string
  /** Kaynak baskı ZPL'inin özeti — hangi artefakttan geldiği. */
  printZplSha256: string
  /**
   * TAŞIYICI ŞABLON KİMLİĞİ (parmak izi).
   *
   * ═══ NEDEN GEREKLİ ═════════════════════════════════════════════════════
   * Kiracının yerleşimi, taşıyıcının O ANKİ şablonuna göre tasarlanır:
   * boş şeritler, kilitli bölgeler ve güvenli alanlar o şablondan gelir.
   * Sürat şablonunu değiştirirse (v1 → v2 geçişinde olduğu gibi) eski
   * yerleşim yeni etikette taşıyıcı alanlarının üstüne düşebilir.
   *
   * Parmak izi yayın anında belgeye YAZILIR; baskıda canlı tabanınkiyle
   * karşılaştırılır. Uyuşmazlık SESSİZ KALMAZ.
   */
  templateFingerprint: string
  /** Üstü kapatılamayacak taşıyıcı bölgeleri. */
  carrierZones: CarrierZone[]
}

/** Kiracı katmanı bu bölgeye giremez mi? */
/** Taşıyıcı şablonunun kimliği — semantic modelden, uydurulmaz. */
export function carrierTemplateFingerprint(zpl: string): string {
  const model = resolveSuratSemanticModel(String(zpl ?? ''))
  return model.supported ? model.fingerprint : ''
}

export function zoneBlocksOverlay(zone: CarrierZone): boolean {
  return zone.zoneClass === 'identity' || zone.zoneClass === 'operational'
}
