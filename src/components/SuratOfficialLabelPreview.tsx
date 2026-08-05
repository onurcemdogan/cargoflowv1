import type { CargoOrder, CargoProduct } from '../types/cargoflow'
import { buildSuratOfficialArtifact } from '../utils/browserLabelPrint'

// RESMÎ SÜRAT ETİKETİ ÖNİZLEMESİ.
//
// ÖNİZLEME ve CHROME BASKISI AYNI FONKSİYONDAN (buildSuratOfficialArtifact)
// üretilen AYNI SVG artefaktını kullanır. Ayrı bir "yaklaşık önizleme" HTML'i
// ÜRETİLMEZ; bu yüzden aynı gönderi için
//   preview.printZplSha256      === browserPrint.printZplSha256
//   preview.renderVersion       === browserPrint.renderVersion
//   preview.templateFingerprint === browserPrint.templateFingerprint
// zorunlu olarak sağlanır (aynı saf çağrı, aynı girdi).
//
// YAN ETKİ YOKTUR: provider çağrısı yapılmaz, shipment oluşturulmaz,
// printCount artmaz, labelStatus değişmez.

interface SuratOfficialLabelPreviewProps {
  order: CargoOrder
  products?: CargoProduct[]
}

export function SuratOfficialLabelPreview({
  order,
  products = [],
}: SuratOfficialLabelPreviewProps) {
  const { page, reason } = buildSuratOfficialArtifact(order, products)
  if (!page) {
    return (
      <div className="surat-official-preview-unavailable" role="status">
        {reason}
      </div>
    )
  }
  return (
    <div
      className="surat-official-preview"
      data-testid="surat-official-preview"
      data-print-zpl-sha256={page.printZplSha256}
      data-render-version={page.render.renderVersion}
      data-template-fingerprint={page.render.templateFingerprint}
      data-width-mm={String(page.render.widthMm)}
      data-height-mm={String(page.render.heightMm)}
      aria-label="Resmî Sürat etiketi önizlemesi"
      // Kaynak, YEREL renderer'ın ürettiği kendi SVG'sidir (harici içerik
      // veya kullanıcı HTML'i DEĞİLDİR); metin alanları escapeXml ile
      // kaçırılır.
      dangerouslySetInnerHTML={{ __html: page.render.svg }}
    />
  )
}
