// Code128 sessiz alanı (quiet zone) — TEK KAYNAK KURAL.
//
// PROBLEM: etikette barkodu "geniş yay" demek, dar çubuk (modül) genişliği X'i
// büyütmek demektir. ISO/IEC 15417 Code128 için her iki yanda EN AZ 10X sessiz
// alan ister. Sessiz alan X ile ÖLÇEKLENDİĞİ için SABİT bir mm/px yan boşluk
// hiçbir zaman doğru olamaz: barkod uzunluğu (modül sayısı) değişince X değişir,
// gereken sessiz alan da değişir.
//
// Ölçüm (203 DPI, 100mm etiket, 7mm sol dikey kolon → 93mm gövde):
//   11 haneli barkod = 112 modül. 1.5mm yan boşluk yalnız 1.9X verir → YETERSİZ.
//   Sabit 7mm bile 10 haneli (90 modül) barkodda 8.0X'te kalır → YETERSİZ.
//
// ÇÖZÜM: sessiz alanı SVG'nin KENDİ viewBox'ına gömüyoruz. viewBox intrinsic
// (gerçek) ölçüden türetilir ve her iki yana 10 modül eklenir. SVG kapsayıcıya
// esnetildiğinde çubuklar ve sessiz alan AYNI katsayıyla ölçeklenir; böylece
// oran her barkod uzunluğunda ve her kapsayıcı genişliğinde tam 10X kalır.
//
// PAYLOAD DEĞİŞMEZ: kodlama JsBarcode'a aittir; burada yalnız görüntüleme
// kutusu (viewBox) genişletilir. Çubuk/boşluk göreli oranları korunur.
export const CODE128_QUIET_ZONE_MODULES = 10

export interface QuietZoneResult {
  applied: boolean
  /** Intrinsic (viewBox) birimi cinsinden tek yandaki sessiz alan. */
  quietZoneUnits: number
  /** Çubukların kapladığı intrinsic genişlik (sessiz alan hariç). */
  barsWidth: number
  viewBox: string
}

// Verilen SVG'ye ölçeklenebilir sessiz alan uygular.
// moduleWidth = JsBarcode'a verilen `width` (bir modülün intrinsic genişliği).
export function applyScalableQuietZone(
  svg: {
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
    removeAttribute(name: string): void
  },
  moduleWidth: number,
): QuietZoneResult {
  // DİKKAT (ölçülmüş davranış): JsBarcode SVG'ye width="247px" / height="91px"
  // yazar — BİRİMLİ. Number("247px") === NaN olduğu için parseFloat kullanmak
  // ZORUNLUDUR; aksi hâlde bu fonksiyon sessizce hiçbir şey yapmaz.
  // Ayrıca JsBarcode KENDİ viewBox'ını da yazar ("0 0 247 91"); varsa onu
  // kaynak alırız (yuvarlanmış px değerleriyle bire bir tutarlı olsun diye).
  const existingViewBox = (svg.getAttribute('viewBox') ?? '')
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part))
    .filter((n) => Number.isFinite(n))
  const fromViewBox = existingViewBox.length === 4
  const barsWidth = fromViewBox
    ? existingViewBox[2]
    : Number.parseFloat(svg.getAttribute('width') ?? '') || 0
  const height = fromViewBox
    ? existingViewBox[3]
    : Number.parseFloat(svg.getAttribute('height') ?? '') || 0
  const quietZoneUnits = CODE128_QUIET_ZONE_MODULES * moduleWidth
  if (!(barsWidth > 0) || !(height > 0) || !(quietZoneUnits > 0)) {
    return { applied: false, quietZoneUnits: 0, barsWidth, viewBox: '' }
  }
  // Sol/sağ simetrik genişletme: insan-okunur numara JsBarcode tarafından
  // barsWidth/2'ye ortalanır ve simetrik büyütmede ORTADA KALIR.
  const viewBox = `${-quietZoneUnits} 0 ${barsWidth + 2 * quietZoneUnits} ${height}`
  svg.setAttribute('viewBox', viewBox)
  // Çubukların yalnız SVG kutusunun değil, GERÇEKTEN yatayda yayılması için.
  svg.setAttribute('preserveAspectRatio', 'none')
  // Sabit width/height attribute'ları kalırsa CSS width:100% çubukları
  // esnetmez; yalnız kutuyu büyütür.
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  return { applied: true, quietZoneUnits, barsWidth, viewBox }
}

// Teşhis/raporlama için: kapsayıcı genişliği (mm) ve modül sayısından gerçek
// X ve sessiz alan ölçüsünü verir. Render'ı ETKİLEMEZ.
export function describeQuietZone(
  containerWidthMm: number,
  moduleCount: number,
  dpi = 203,
): { moduleMm: number; moduleDots: number; quietZoneMm: number; barsMm: number } {
  const totalUnits = moduleCount + 2 * CODE128_QUIET_ZONE_MODULES
  const moduleMm = containerWidthMm / totalUnits
  return {
    moduleMm,
    moduleDots: moduleMm / (25.4 / dpi),
    quietZoneMm: CODE128_QUIET_ZONE_MODULES * moduleMm,
    barsMm: moduleCount * moduleMm,
  }
}
