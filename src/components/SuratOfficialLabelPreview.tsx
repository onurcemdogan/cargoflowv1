import { useEffect, useReducer } from 'react'
import type { CargoOrder } from '../types/cargoflow'
import {
  fetchSuratRenderArtifact,
  SURAT_RENDER_UNAVAILABLE_MESSAGE,
  type SuratRenderArtifact,
} from '../services/suratLabelRenderClient'

// RESMÎ SÜRAT ETİKETİ ÖNİZLEMESİ.
//
// Önizleme ve Chrome baskısı AYNI endpoint artefaktını kullanır; istemci
// önbelleği sayesinde AYNI PNG baytları paylaşılır, bu yüzden
//   preview.printZplSha256 === print.printZplSha256
//   preview.renderSha256   === print.renderSha256
//   preview.zebrashVersion === print.zebrashVersion
// zorunlu olarak sağlanır. Ayrı bir yaklaşık HTML/SVG önizleme ÜRETİLMEZ.
//
// PNG üzerine HİÇBİR overlay eklenmez; ürün satırı yalnız printZpl içindeki
// ZPL komutlarından gelir.
//
// YAN ETKİ YOKTUR: provider çağrısı, shipment oluşturma, printCount artışı
// veya labelStatus değişimi YOK (uç nokta salt okunurdur).

interface SuratOfficialLabelPreviewProps {
  order: CargoOrder
}

interface PreviewState {
  artifact: SuratRenderArtifact | null
  reason: string | null
}

type PreviewAction =
  | { type: 'reset' }
  | { type: 'loaded'; artifact: SuratRenderArtifact }
  | { type: 'failed'; reason: string }

function previewReducer(_state: PreviewState, action: PreviewAction): PreviewState {
  if (action.type === 'loaded') return { artifact: action.artifact, reason: null }
  if (action.type === 'failed') return { artifact: null, reason: action.reason }
  return { artifact: null, reason: null }
}

export function SuratOfficialLabelPreview({
  order,
}: SuratOfficialLabelPreviewProps) {
  const [{ artifact, reason }, dispatch] = useReducer(previewReducer, {
    artifact: null,
    reason: null,
  })
  const orderId = String(order?.id ?? '')

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    dispatch({ type: 'reset' })
    void fetchSuratRenderArtifact(orderId, { signal: controller.signal })
      .then((result) => {
        if (active) dispatch({ type: 'loaded', artifact: result })
      })
      .catch((error) => {
        if (!active) return
        dispatch({
          type: 'failed',
          reason:
            error instanceof Error && error.message
              ? error.message
              : SURAT_RENDER_UNAVAILABLE_MESSAGE,
        })
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [orderId])

  if (reason) {
    return (
      <div className="surat-official-preview-status" role="status">
        {reason}
      </div>
    )
  }
  if (!artifact) {
    return (
      <div className="surat-official-preview-status" role="status">
        Resmî Sürat etiketi hazırlanıyor…
      </div>
    )
  }
  return (
    <div
      className="surat-official-preview"
      data-testid="surat-official-preview"
      data-print-zpl-sha256={artifact.printZplSha256}
      data-render-sha256={artifact.renderSha256}
      data-zebrash-version={artifact.zebrashVersion}
      data-augmentation-status={artifact.augmentationStatus}
    >
      <img
        alt="Resmî Sürat etiketi önizlemesi"
        src={`data:${artifact.mimeType};base64,${artifact.imageBase64}`}
      />
      {artifact.warning ? (
        <p className="surat-official-preview-status">{artifact.warning}</p>
      ) : null}
    </div>
  )
}
