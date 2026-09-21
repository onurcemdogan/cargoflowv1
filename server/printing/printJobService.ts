// KANONİK BASKI İŞİ — HAZIRLIK + YÜRÜTME + SONUÇ.
//
// ═══ ÜÇ SORUMLULUK AYRI ══════════════════════════════════════════════════
//
//   ARTEFAKT  : `printArtifactResolver` (hangi değişmez sayfalar)
//   TAŞIMA    : `windowsRawTransport` vb. (nasıl gönderilir)
//   YÜRÜTME   : BU DOSYA (hangi işler gerçekten gönderildi)
//
// Bu dosya ZPL ÜRETMEZ, sayfa SIRALAMAZ, ürün toplamaz, pazaryeri/taşıyıcı
// ÇAĞIRMAZ. Yalnız kimlikten kanonik artefaktı çözdürür ve taşımaya verir.
//
// ═══ DURUMLAR DÜRÜSTTÜR ══════════════════════════════════════════════════
//
//   PREPARED  : iş kuruldu, henüz taşımaya verilmedi
//   SUBMITTED : TÜM kalemler taşımaya KABUL ETTİRİLDİ
//   PARTIAL   : bazı kalemler kabul edildi, bazıları edilmedi
//   FAILED    : hiçbir kalem kabul edilmedi
//
// `SUBMITTED` "kâğıt çıktı" DEMEK DEĞİLDİR: işletim sistemi/yazıcı kuyruğu
// işi kabul etti demektir. Sistem fiziksel çıktıyı GÖZLEMLEYEMEZ ve bunu
// iddia etmez.
import {
  resolveCanonicalPrintArtifact,
  resolveShipmentKeyForOrder,
  type PrintResolutionFailure,
} from './printArtifactResolver.ts'
import type { CanonicalPrintArtifact } from './printArtifactModel.ts'
import type { PrintTransport } from './printTransport.ts'
import type { RawPrintExecutor, RawPrintFailure } from './windowsRawTransport.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const PRINT_JOB_STATUSES = [
  'PREPARED',
  'SUBMITTED',
  'PARTIAL',
  'FAILED',
] as const
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number]

export type PrintItemFailure = PrintResolutionFailure | RawPrintFailure

export interface PrintJobPageResult {
  readonly index: number
  readonly kind: string
  readonly status: 'SUBMITTED' | 'FAILED'
  readonly failure: PrintItemFailure | null
}

export interface PrintJobItemResult {
  readonly orderId: string
  readonly orderNumber: string
  readonly shipmentId: string | null
  readonly status: 'SUBMITTED' | 'FAILED'
  readonly failure: PrintItemFailure | null
  readonly printJobId: string | null
  readonly pageCount: number
  readonly pages: readonly PrintJobPageResult[]
}

export interface PrintJobResult {
  readonly jobId: string
  readonly organizationId: string
  readonly transport: PrintTransport
  readonly requestedAt: string
  readonly status: PrintJobStatus
  readonly items: readonly PrintJobItemResult[]
}

export interface PrintJobItemRequest {
  readonly orderId: string
  readonly orderNumber?: string
}

export interface SubmitPrintJobParams {
  /** KİRACI YALNIZ AUTH BAĞLAMINDAN. İstek gövdesi bunu EZEMEZ. */
  organizationId: string
  marketplaceAccountId?: string | null
  transport: PrintTransport
  printerName: string
  items: readonly PrintJobItemRequest[]
  getOrder: (
    db: Db,
    organizationId: string,
    orderId: string,
    marketplaceAccountId?: string | null,
  ) => Promise<Record<string, unknown> | null>
  execute: RawPrintExecutor
  now?: () => Date
  jobId?: string
}

function statusOf(items: readonly PrintJobItemResult[]): PrintJobStatus {
  if (items.length === 0) return 'FAILED'
  const submitted = items.filter((item) => item.status === 'SUBMITTED').length
  if (submitted === 0) return 'FAILED'
  // SESSİZ DÜŞME YOK: bir kalem bile kabul edilmediyse iş PARTIAL'dır ve
  // o kalem AÇIKÇA başarısız olarak raporlanır.
  return submitted === items.length ? 'SUBMITTED' : 'PARTIAL'
}

const failedItem = (
  request: PrintJobItemRequest,
  failure: PrintItemFailure,
  artifact?: CanonicalPrintArtifact,
): PrintJobItemResult => ({
  orderId: String(request.orderId ?? ''),
  orderNumber: String(request.orderNumber ?? ''),
  shipmentId: artifact?.shipmentId ?? null,
  status: 'FAILED',
  failure,
  printJobId: null,
  pageCount: artifact?.pages.length ?? 0,
  // Sayfa bazında da AÇIK: hangi sayfa gitmedi görünür.
  pages: (artifact?.pages ?? []).map((page) => ({
    index: page.index,
    kind: page.kind,
    status: 'FAILED' as const,
    failure,
  })),
})

/**
 * SUNUCU YETKİLİ BASKI İŞİ.
 *
 * Sıra KASITLIDIR:
 *   1) kiracı kapsamında sipariş → gönderi anahtarı
 *   2) KALICI artefakt çözümü (hash zinciri doğrulanır, FAIL-CLOSED)
 *   3) sıra değişmezliği
 *   4) YALNIZ bundan sonra taşıma
 *
 * İstemci ham ZPL GÖNDEREMEZ: bu fonksiyonun girdisinde içerik alanı YOKTUR.
 */
export async function submitPrintJob(
  db: Db,
  params: SubmitPrintJobParams,
): Promise<PrintJobResult> {
  const organizationId = String(params.organizationId ?? '').trim()
  const now = params.now ?? (() => new Date())
  const requestedAt = now().toISOString()
  const jobId = params.jobId ?? `print-${requestedAt}-${params.items.length}`

  const items: PrintJobItemResult[] = []
  for (const request of params.items) {
    const orderId = String(request.orderId ?? '').trim()
    if (organizationId === '' || orderId === '') {
      items.push(failedItem(request, 'ORDER_NOT_FOUND'))
      continue
    }

    // 1) KİRACI KAPSAMI — başka kiracının siparişi "yok" ile AYNI cevabı alır.
    const key = await resolveShipmentKeyForOrder(db, {
      organizationId,
      orderId,
      marketplaceAccountId: params.marketplaceAccountId ?? null,
      getOrder: params.getOrder,
    })
    if (!key) {
      items.push(failedItem(request, 'ORDER_NOT_FOUND'))
      continue
    }

    // 2) KALICI ARTEFAKT — yeniden üretim/refetch YOK, hash FAIL-CLOSED.
    const resolution = await resolveCanonicalPrintArtifact(db, key)
    if (!resolution.ok) {
      items.push(failedItem(request, resolution.failure))
      continue
    }
    const artifact = resolution.artifact

    // 3) TAŞIMA — YALNIZ sunucuda çözülmüş baytlar.
    //    Sayfalar KALICI SIRADA birleştirilir; taşıma sıralamaya karışmaz.
    const outcome = await params.execute({
      printerName: params.printerName,
      documentName: `CargoFlow-${request.orderNumber || orderId}`,
      content: artifact.pages.map((page) => page.content).join('\n'),
    })

    if (!outcome.ok) {
      items.push(failedItem(request, outcome.failure, artifact))
      continue
    }
    items.push({
      orderId,
      orderNumber: String(request.orderNumber ?? ''),
      shipmentId: artifact.shipmentId,
      status: 'SUBMITTED',
      failure: null,
      printJobId: outcome.printJobId,
      pageCount: artifact.pages.length,
      pages: artifact.pages.map((page) => ({
        index: page.index,
        kind: page.kind,
        status: 'SUBMITTED' as const,
        failure: null,
      })),
    })
  }

  return {
    jobId,
    organizationId,
    transport: params.transport,
    requestedAt,
    status: statusOf(items),
    items,
  }
}

/**
 * MANTIKSAL "ETİKET BASILDI" İNDİRGEYİCİSİ — TEK KARAR.
 *
 * Her taşıma KENDİ BAŞINA sipariş durumu değiştiremez. Hangi siparişlerin
 * mantıksal basılı sayılacağı YALNIZ burada belirlenir ve mevcut kabul
 * edilmiş sipariş-bazlı semantik korunur: TÜM sayfaları taşımaya kabul
 * ettirilen sipariş sayılır.
 */
export function resolvePrintedOrderIds(result: PrintJobResult): string[] {
  return result.items
    .filter(
      (item) =>
        item.status === 'SUBMITTED' &&
        item.pages.length > 0 &&
        item.pages.every((page) => page.status === 'SUBMITTED'),
    )
    .map((item) => item.orderId)
}
