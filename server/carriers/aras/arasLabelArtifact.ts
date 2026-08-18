// ARAS — GetBarcode ETİKET ARTEFAKTI (saf karar; ağ YOK).
//
// KAYNAK: resmî test servisi `GetBarcode` (Username · Password ·
// integrationCode), doğrulama 2026-08-19. Yanıt sözleşmesi:
//   Images (base64) · ZebraZpl · ZebraEpl · BarcodeModelLst
//
// ═══ ZPL'İN VAR OLDUĞU VARSAYILMAZ ═══════════════════════════════════════
// Sürat yolunda ZPL fiilen her zaman gelir; Aras'ta ÜÇ farklı artefakt tipi
// dokümante edilmiştir ve hangisinin döneceği garanti DEĞİLDİR. Bu yüzden
// tipler BAĞIMSIZ ayrıştırılır ve hiçbiri diğerinin varlığını ima etmez.
//
// ═══ ARTEFAKT DEĞİŞMEZDİR ════════════════════════════════════════════════
// Sürat'ta kanıtlanan ilke burada da geçerlidir: yeniden baskı KAYITLI
// artefakttan yapılır, taşıyıcıdan YENİDEN ÜRETİLMEZ. Yeniden üretim, ikinci
// bir barkod/gönderi doğurma riskidir ve baskı ile kayıt arasında sessiz
// ayrışma yaratır.

export const ARAS_LABEL_ARTIFACT_TYPES = ['ZPL', 'EPL', 'IMAGE'] as const
export type ArasLabelArtifactType = (typeof ARAS_LABEL_ARTIFACT_TYPES)[number]

export interface ArasLabelArtifact {
  type: ArasLabelArtifactType
  /** ZPL/EPL için ham metin; IMAGE için base64 gövde. */
  content: string
  encoding: 'text' | 'base64'
}

export interface ArasLabelResolution {
  ok: boolean
  artifacts: ArasLabelArtifact[]
  /** Baskı için tercih edilen artefakt; yoksa null. */
  preferred: ArasLabelArtifact | null
  barcodeModels: Array<Record<string, unknown>>
  errorCode: 'ARAS_LABEL_ARTIFACT_MISSING' | null
  reason: string | null
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/**
 * GetBarcode yanıtını artefaktlara çevirir.
 *
 * Tercih sırası ZPL → EPL → IMAGE'dır: yazıcı yolu ham ZPL'i olduğu gibi
 * basabildiğinde en yüksek doğrulukta çıktı odur. Ancak ZPL YOKSA akış
 * DURMAZ; sıradaki artefakt kullanılır. Hiçbiri yoksa fail-closed.
 */
export function resolveArasLabelArtifacts(
  raw: Record<string, unknown> | null | undefined,
): ArasLabelResolution {
  const artifacts: ArasLabelArtifact[] = []
  const source = raw ?? {}

  const zpl = str(source.ZebraZpl)
  if (zpl) artifacts.push({ type: 'ZPL', content: zpl, encoding: 'text' })

  const epl = str(source.ZebraEpl)
  if (epl) artifacts.push({ type: 'EPL', content: epl, encoding: 'text' })

  const images = Array.isArray(source.Images)
    ? source.Images
    : source.Images
      ? [source.Images]
      : []
  for (const image of images) {
    const content = str(image)
    if (content) artifacts.push({ type: 'IMAGE', content, encoding: 'base64' })
  }

  const barcodeModels = Array.isArray(source.BarcodeModelLst)
    ? (source.BarcodeModelLst as Array<Record<string, unknown>>)
    : []

  if (artifacts.length === 0) {
    return {
      ok: false, artifacts: [], preferred: null, barcodeModels,
      errorCode: 'ARAS_LABEL_ARTIFACT_MISSING',
      reason: 'GetBarcode yanıtı basılabilir bir artefakt taşımıyor.',
    }
  }
  const order: ArasLabelArtifactType[] = ['ZPL', 'EPL', 'IMAGE']
  const preferred =
    order
      .map((type) => artifacts.find((artifact) => artifact.type === type))
      .find(Boolean) ?? null

  return { ok: true, artifacts, preferred, barcodeModels, errorCode: null, reason: null }
}

/**
 * Yeniden baskı KAYITLI artefaktan yapılır.
 *
 * Taşıyıcıya yeniden gitmek YASAKTIR: `GetBarcode`ı tekrar çağırmak,
 * kayıtlıdan farklı bir çıktı dönme ihtimalini ve gereksiz taşıyıcı yükünü
 * getirir. Kayıt yoksa baskı YAPILMAZ — sessizce yeniden üretmek yerine
 * eksiklik bildirilir.
 */
export function resolveArasReprintArtifact(
  stored: ArasLabelArtifact | null | undefined,
): { ok: boolean; artifact: ArasLabelArtifact | null; errorCode: string | null } {
  if (!stored || !str(stored.content)) {
    return {
      ok: false, artifact: null,
      errorCode: 'ARAS_STORED_ARTIFACT_MISSING',
    }
  }
  return { ok: true, artifact: stored, errorCode: null }
}
