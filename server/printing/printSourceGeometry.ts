// KAYNAK BAZINDA FİZİKSEL GEOMETRİ.
//
// ═══ NEDEN PLATFORMDA KÜRESEL SABİT YOK ══════════════════════════════════
//
// Sürat resmî etiketi 10 × 10 cm'dir ve bu KANITLANMIŞ bir üründür. Bunu
// platform seviyesinde `PAGE_WIDTH_MM = 100` diye yazmak, gelecekteki HER
// sağlayıcının, HER taşıyıcının ve HER ek sayfanın aynı ölçüde olduğunu
// iddia etmek olurdu. Bu iddia yanlıştır ve yanlışlığı ancak ilk farklı
// ölçülü etikette — üretimde, sessizce kayan bir baskıyla — görülürdü.
//
// Bu yüzden ölçü KAYNAĞA aittir: her kalıcı artefakt kaynağı KENDİ
// geometrisini bildirir ve sayfa nesnesi onu TAŞIR.
//
// Buradaki değerler MEVCUT kanıtlanmış Sürat davranışını AYNEN korur:
// `labelGeometry` (100 × 100 mm) ve 203 dpi termal yerleşim.
import {
  LABEL_CANVAS_HEIGHT_MM,
  LABEL_CANVAS_WIDTH_MM,
  LABEL_PRINTER_DPI,
} from '../../src/labels/labelGeometry.ts'
import type { PrintPageGeometry } from './printArtifactModel.ts'

/**
 * KANITLANMIŞ kaynaklar. Yeni bir taşıyıcı/sağlayıcı BURAYA kendi ölçüsüyle
 * eklenir; platform kodu ölçü UYDURMAZ.
 *
 * Aras/ikas/Ticimax BİLEREK YOK: ölçüleri kanıtlanmadı ve bu bilette
 * uydurulmaz.
 */
export const PRINT_ARTIFACT_SOURCES = ['surat_persisted_print_bundle'] as const
export type PrintArtifactSource = (typeof PRINT_ARTIFACT_SOURCES)[number]

/**
 * Sürat kalıcı baskı paketi: taşıyıcı sayfa ve ürün detay sayfaları AYNI
 * fiziksel stoğa (10 × 10 cm) basılır — bugünkü kanıtlanmış davranış.
 */
const SURAT_PAGE_GEOMETRY: PrintPageGeometry = Object.freeze({
  widthMm: LABEL_CANVAS_WIDTH_MM,
  heightMm: LABEL_CANVAS_HEIGHT_MM,
  dpi: LABEL_PRINTER_DPI,
})

const GEOMETRY_BY_SOURCE: Readonly<Record<PrintArtifactSource, PrintPageGeometry>> =
  Object.freeze({
    surat_persisted_print_bundle: SURAT_PAGE_GEOMETRY,
  })

/**
 * Kaynağın sayfa geometrisi.
 *
 * Bilinmeyen kaynak için ölçü UYDURULMAZ: `null` döner ve çağıran fail-closed
 * davranır. "Varsayılan 100 × 100" demek, tam olarak kaçınılan hatadır.
 */
export function geometryForSource(
  source: string,
): PrintPageGeometry | null {
  return GEOMETRY_BY_SOURCE[source as PrintArtifactSource] ?? null
}
