// RESMÎ SÜRAT ETİKETİ RENDER SERVİSİ — org-scoped, salt okunur, saf zincir.
//
// AKIŞ: canonical sipariş → Sürat shipment doğrulaması →
//       resolvePersistedPrintableLabel (persisted printZpl / legacy hydration /
//       technicalZpl fallback) → zebrash PNG.
//
// KURALLAR
//   - İstemciden HAM ZPL KABUL EDİLMEZ; girdi yalnız canonical kimliktir.
//   - Yanıt HAM ZPL İÇERMEZ (technicalZpl / printZpl / şifreli payload YOK).
//   - DB WRITE YOK (tek istisna: printZplRepository'nin legacy hydration
//     compare-and-set'i — bu MEVCUT ve KASITLI sözleşmedir, printZpl
//     artefaktını YALNIZ BİR KEZ üretir; sipariş/shipment durumunu,
//     printCount'u veya labelStatus'u DEĞİŞTİRMEZ).
//   - Provider/marketplace çağrısı YOK, yeni shipment YOK.
//   - Harici render API YOK (zebrash yereldir).
import {
  resolvePersistedPrintableLabel,
  PRINT_ZPL_SOURCE_MISSING_MESSAGE,
} from '../shipments/printZplRepository.ts'
import { loadPrintLineItems } from '../shipments/printZplItems.ts'
import { SURAT_PERSISTENCE_PROVIDER } from '../shipments/suratProvider.ts'
import {
  AUGMENTATION_FALLBACK_WARNING,
  type AugmentationStatus,
} from '../../src/utils/augmentedSuratZpl.ts'
import {
  renderZplToPng,
  ZPL_RENDER_FAILED_MESSAGE,
  ZPL_RENDERER_PACKAGE,
  ZPL_RENDERER_PACKAGE_VERSION,
} from './zplRenderService.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Sürat dışı gönderide resmî şablon KULLANILAMAZ. */
export const NOT_SURAT_SHIPMENT_MESSAGE =
  'Resmî Sürat şablonu yalnız Sürat Kargo gönderilerinde kullanılabilir.'
/**
 * Ürün satırı eklenemediğinde gösterilen GÜVENLİ uyarı. Metin TEK KAYNAKTAN
 * (domain sabiti) gelir; burada kopyalanmaz.
 */
export const PRODUCT_LINE_FALLBACK_WARNING = AUGMENTATION_FALLBACK_WARNING

export function isSuratProvider(provider: unknown): boolean {
  return /surat|sürat/i.test(String(provider ?? ''))
}

export interface SuratRenderRequest {
  db: Db
  organizationId: string
  marketplaceAccountId: string | null
  orderId: string
  /** Sipariş okuyucu (org + hesap kapsamlı) — çağıran katmandan gelir. */
  getOrder: (
    db: Db,
    organizationId: string,
    orderId: string,
    marketplaceAccountId: string | null,
  ) => Promise<any>
}

export interface SuratRenderDto {
  mimeType: 'image/png'
  imageBase64: string
  widthPx: number
  heightPx: number
  widthMm: number
  heightMm: number
  printZplSha256: string
  renderSha256: string
  renderEngine: string
  renderEngineVersion: string
  zebrashVersion: string
  /**
   * DOMAIN sözleşmesi: success | overflow | unsupported_template | unavailable.
   * Kalıcılık katmanının `augmented | source_only` bayrağı DTO'ya SIZMAZ —
   * paralel durum sözlüğü YOKTUR.
   */
  augmentationStatus: AugmentationStatus
  /**
   * Baskı ZPL'inin RENDER SÖZLEŞMESİ. Teşhis içindir; HAM ZPL, payload veya
   * müşteri alanı İÇERMEZ.
   *   'official_augmented' → resmî ZPL + güvenli ürün footer'ı
   *   'durusoft_composed'  → DuruSoft parity dönüşümü uygulandı
   */
  renderContract: 'official_augmented' | 'durusoft_composed'
  /**
   * Composer sonucu: 'durusoft_composed' veya fallback nedeni
   * (fallback_unknown_template | fallback_semantic_failure |
   *  fallback_geometry_failure | fallback_invariant_failure |
   *  fallback_whitelist_violation). Denenmediyse null.
   */
  composeMode: string | null
  warning?: string
}

export class SuratRenderError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SuratRenderError'
    this.status = status
    this.code = code
  }
}

/**
 * Resmî Sürat etiketini PNG olarak üretir. Ham ZPL DÖNMEZ ve LOGLANMAZ.
 */
export async function renderSuratLabel(
  request: SuratRenderRequest,
): Promise<SuratRenderDto> {
  const order = await request.getOrder(
    request.db,
    request.organizationId,
    request.orderId,
    request.marketplaceAccountId,
  )
  if (!order) {
    throw new SuratRenderError(404, 'order_not_found', 'Sipariş bulunamadı.')
  }

  const shipment = (order.shipment ?? {}) as Record<string, unknown>
  // GÖRÜNEN ad YALNIZ doğrulama içindir: pazaryeri/UI değeri ('surat-kargo',
  // 'Sürat Kargo Marketplace', ...) olabilir ve DB anahtarı DEĞİLDİR.
  const displayedProvider = String(
    shipment.provider ?? order.cargoProviderName ?? '',
  )
  // Sağlayıcı hiç belirtilmemişse (tek sağlayıcılı kurulum) Sürat sayılır;
  // AÇIKÇA başka bir sağlayıcı yazılıysa resmî şablon REDDEDİLİR.
  if (displayedProvider && !isSuratProvider(displayedProvider)) {
    throw new SuratRenderError(409, 'not_surat_shipment', NOT_SURAT_SHIPMENT_MESSAGE)
  }

  const marketplace = String(order.marketplace ?? '')
  const packageId = String(order.packageId ?? '')
  if (!marketplace || !packageId) {
    throw new SuratRenderError(
      409,
      'label_not_ready',
      PRINT_ZPL_SOURCE_MISSING_MESSAGE,
    )
  }

  let model
  try {
    model = await resolvePersistedPrintableLabel(
      request.db,
      {
        organizationId: request.organizationId,
        marketplace,
        packageId,
        // KANONİK DB ANAHTARI — görünen ad DEĞİL. `shipments.provider` kolonu
        // exact `eq(...)` ile sorgulanır ve persistence katmanı bu satırı
        // DAİMA 'surat' ile yazar. Görünüm değeri ('surat-kargo' vb.) buraya
        // geçirilirse kayıt bulunamaz. Organization/marketplace/packageId
        // izolasyonu AYNEN exact kalır.
        provider: SURAT_PERSISTENCE_PROVIDER,
      },
      {
        // TEMBEL: kalıcı printZpl varsa katalog ve sipariş satırları HİÇ
        // okunmaz (reprint immutability).
        loadItems: () =>
          loadPrintLineItems(
            request.db,
            request.organizationId,
            marketplace,
            packageId,
          ),
      },
    )
  } catch (error) {
    throw new SuratRenderError(
      409,
      'label_not_ready',
      error instanceof Error ? error.message : PRINT_ZPL_SOURCE_MISSING_MESSAGE,
    )
  }

  let render
  try {
    render = await renderZplToPng({ zpl: model.printZpl })
  } catch {
    // Ham ZPL hata mesajına KONMAZ; yaklaşık SVG'ye DÜŞÜLMEZ.
    throw new SuratRenderError(502, 'render_failed', ZPL_RENDER_FAILED_MESSAGE)
  }

  // Kalıcılık bayrağı → DOMAIN sözlüğü. Ürün satırı eklendiyse 'success';
  // eklenmediyse kalıcı artefakttaki gerçek NEDEN kullanılır (eski kayıtlarda
  // neden saklanmadığı için 'unavailable' güvenli varsayılandır).
  const augmentationStatus: AugmentationStatus =
    model.augmentationStatus === 'augmented'
      ? 'success'
      : (model.augmentationReason ?? 'unavailable')

  return {
    mimeType: 'image/png',
    imageBase64: render.pngBase64,
    widthPx: render.widthPx,
    heightPx: render.heightPx,
    widthMm: render.widthMm,
    heightMm: render.heightMm,
    printZplSha256: model.printZplSha256,
    renderSha256: render.renderSha256,
    renderEngine: ZPL_RENDERER_PACKAGE,
    renderEngineVersion: ZPL_RENDERER_PACKAGE_VERSION,
    zebrashVersion: render.engine.zebrashVersion,
    augmentationStatus,
    // Eski kayıtlarda alan yoktur; o artefaktlar composer'dan ÖNCE
    // üretildiği için augmentation-only'dir.
    renderContract: model.renderContract ?? 'official_augmented',
    composeMode: model.composeMode ?? null,
    ...(augmentationStatus === 'success'
      ? {}
      : { warning: PRODUCT_LINE_FALLBACK_WARNING }),
  }
}
