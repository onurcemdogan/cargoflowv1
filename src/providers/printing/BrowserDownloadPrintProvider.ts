import type { PrintInput, PrintProvider, PrintResult } from './PrintProvider'
import type { LabelBaseLayer } from '../../labels/labelBaseLayer'
// Kanonik tuval ölçüsü: iki SAYI sabiti. Statik import edilir — dinamik
// import bir başarısızlık noktası ekliyordu ve ağır render yığınını
// GETİRMEZ (labelGeometry saf sabit/matematik modülüdür).
import {
  LABEL_CANVAS_HEIGHT_MM,
  LABEL_CANVAS_WIDTH_MM,
} from '../../labels/labelGeometry'

/** Taban katmanın bölge listesi — tip statik, modül çalışma zamanında yüklenir. */
type CarrierBaseZones = LabelBaseLayer['carrierZones']
import { defaultLabelTemplate } from '../../services/integrationConfigService'
// ═══ RENDER YIGINI TALEP UZERINE ════════════════════════════════════════
//
// OLCULDU: `App` → `appServices` → bu saglayici → `officialSuratPrintRunner`
// → `browserLabelPrint` zinciri, JsBarcode + qrcode-generator + ~62 kB
// etiket kodunu ILK YUKE sokuyordu. Panoyu acan kullanici hic basmayacagi
// yigini indiriyordu.
//
// Tip bilgisi statik kalir (silinir, calisma zamanina TASINMAZ); gercek
// moduller YALNIZ baski aninda yuklenir.
import type { BrowserLabelPrintError as BrowserLabelPrintErrorType } from '../../utils/browserLabelPrint'

const loadLabelRenderer = () => import('../../utils/browserLabelPrint')
const loadOfficialRunner = () => import('../../services/officialSuratPrintRunner')
import { NOT_IN_PRINT_DOCUMENT_MESSAGE } from '../../utils/suratPrintFailureReasons'

// Browser-print başarısı TEKNİK koşullara bağlıdır; kullanıcıdan ayrıca baskı
// doğrulaması İSTENMEZ (bloklayan dialog da, inline panel de YOK).
// Başarı için gereken TÜM koşullar:
//   (1) baskı host/iframe hazırlandı ve belge yazıldı,
//   (2) sipariş baskı belgesine GERÇEKTEN girdi (render + product-fit geçti),
//   (3) window.print çağrısı başarıyla yapıldı,
//   (4) provider teknik hata fırlatmadı.
// Bu koşulları geçmeyen sipariş BAŞARILI SAYILMAZ.
export interface BrowserPrintJobDecision {
  jobs: NonNullable<PrintResult['jobs']>
  /** En az bir sipariş belgeye girdi ve print çağrısı yapıldı. */
  printed: boolean
}

export interface BrowserPrintDebugLike {
  printCalled?: boolean
  printedOrderNumbers?: string[]
  skipped?: Array<{ orderNumber: string; reason: string }>
  rejectionReason?: string
}

// Teknik olarak basılmış sayılabilecek bir iş var mı? (print çağrıldı VE en az
// bir sipariş belgeye girdi)
export function hasPrintedDocument(
  debug: BrowserPrintDebugLike | undefined,
  orderNumbers: string[],
): boolean {
  const rendered = new Set(debug?.printedOrderNumbers ?? [])
  return (
    Boolean(debug?.printCalled) &&
    orderNumbers.some((orderNumber) => rendered.has(orderNumber))
  )
}

// Belgeye GERÇEKTEN giren sipariş numaraları (doğrulama grubu).
export function resolvePrintDocumentOrderNumbers(
  debug: BrowserPrintDebugLike | undefined,
  orderNumbers: string[],
): string[] {
  const rendered = new Set(debug?.printedOrderNumbers ?? [])
  return orderNumbers.filter((orderNumber) => rendered.has(orderNumber))
}

// Browser-print job sonuçları — SAF karar. Başarı üç koşulun HEPSİNİ ister:
//   (1) print gerçekten çağrıldı, (2) sipariş belgeye GERÇEKTEN girdi,
//   (3) kullanıcı çıktıyı onayladı.
// Dialog açılması / printCalled TEK BAŞINA başarı DEĞİLDİR.
export function resolveBrowserPrintJobs(
  debug: BrowserPrintDebugLike | undefined,
  orderNumbers: string[],
): BrowserPrintJobDecision {
  const rendered = new Set(debug?.printedOrderNumbers ?? [])
  const skipReason = new Map(
    (debug?.skipped ?? []).map((item) => [item.orderNumber, item.reason]),
  )
  const printCalled = Boolean(debug?.printCalled)
  const jobs = orderNumbers.map((orderNumber) => {
    const inDocument = rendered.has(orderNumber)
    // KISMİ BAŞARI: belgeye giren siparişler başarılıdır; product-fit veya
    // render nedeniyle girmeyen sipariş DİĞERLERİNİ düşürmez.
    const ok = inDocument && printCalled
    if (ok) {
      return {
        orderNumber,
        ok: true,
        printJobId: `browser-${orderNumber}-${Date.now()}`,
      }
    }
    return {
      orderNumber,
      ok: false,
      errorMessage:
        skipReason.get(orderNumber) ??
        debug?.rejectionReason ??
        NOT_IN_PRINT_DOCUMENT_MESSAGE,
    }
  })
  return { jobs, printed: hasPrintedDocument(debug, orderNumbers) }
}

export class BrowserDownloadPrintProvider implements PrintProvider {
  async print(input: PrintInput): Promise<PrintResult> {
    // ŞABLON KARARI, ŞABLONA ÖZEL İÇERİK KOŞULUNDAN ÖNCE.
    //
    // KÖK NEDEN (canlı): `order.label` (CargoFlow HTML/ZPL etiketi) varlığı
    // ŞABLONDAN BAĞIMSIZ ön koşul olarak uygulanıyordu. Resmî Sürat modunda
    // baskı içeriği sunucudaki kayıtlı printZpl'den PNG olarak gelir; CargoFlow
    // etiketi ARANMAZ. Aksi hâlde CargoFlow etiketi üretilememiş bir sipariş,
    // render ucu HİÇ çağrılmadan eleniyordu.
    const officialSuratTemplate =
      input.labelPrintTemplate === 'surat_official_zpl'
    const printableOrders = officialSuratTemplate
      ? input.orders
      : input.orders.filter((order) => order.label)
    const content = printableOrders
      .map((order) => order.label?.zplContent)
      .filter(Boolean)
      .join('\n')
    const suffix =
      printableOrders.length === 1 ? printableOrders[0].orderNumber : 'toplu'
    const fileName = `cargoflow-${suffix}.zpl`

    if (input.action === 'download') {
      return {
        fileName,
        content,
        status: 'download_required',
        ok: true,
        provider: 'browser-download',
        printerName: input.printerSettings.printerName,
      }
    }

    if (input.printerSettings.mode === 'browser-print') {
      try {
        // ŞABLON SEÇİMİ: iki yol YAN YANA yaşar. Varsayılan (ve seçim
        // verilmediğinde) mevcut CargoFlow HTML yoludur — davranış değişmez.
        //
        // Moduller BURADA cozulur; cagri ifadeleri SADE kalir. Cagriyi
        // `(await loadX()).fn(...)` biciminde yazmak, yollarin birbirine
        // sizmadigini olcen kontrolleri (LIVE-21/22) korlestiriyordu:
        // dal sinirlari cagri ifadesinden bulunuyor.
        const { printOfficialSuratLabels } = await loadOfficialRunner()
        const { printCleanLabelDocument } = await loadLabelRenderer()
        const browserPrintDebug =
          input.labelPrintTemplate === 'surat_official_zpl'
            ? (await printOfficialSuratLabels(printableOrders)).debug
            : await printCleanLabelDocument(
                printableOrders,
                input.labelTemplate ?? defaultLabelTemplate,
                input.mappingConfig,
                input.products ?? [],
                input.labelDocument,
                // TABAN KATMAN YÜKLEYİCİ — overlay belgede taşıyıcının
                // GERÇEK etiketi baskıya girer. Modül dinamik yüklenir:
                // standalone yolda hiç indirilmez.
                async (order) => {
                  const { fetchCarrierBaseLayer } = await import(
                    '../../services/labelDocumentService'
                  )
                  const payload = await fetchCarrierBaseLayer(
                    String(order.id ?? ''),
                  )
                  if (!payload) return null
                  return {
                    kind: 'surat_official',
                    imageBase64: payload.imageBase64,
                    widthMm: LABEL_CANVAS_WIDTH_MM,
                    heightMm: LABEL_CANVAS_HEIGHT_MM,
                    renderSha256: payload.renderSha256,
                    printZplSha256: payload.printZplSha256,
                    templateFingerprint: payload.carrierTemplateFingerprint,
                    carrierZones:
                      payload.carrierZones as CarrierBaseZones,
                  }
                },
              )
        const orderNumbers = printableOrders.map((order) => order.orderNumber)
        // Kullanıcıya AYRICA doğrulama sorulmaz: baskı yoluna teknik olarak
        // verilen siparişler başarılı sayılır.
        const decision = resolveBrowserPrintJobs(browserPrintDebug, orderNumbers)
        return {
          fileName,
          content,
          status: decision.printed ? 'queued' : 'failed',
          ok: decision.printed,
          provider: 'browser-label-document',
          printerName: input.printerSettings.printerName,
          printJobId: `browser-${Date.now()}`,
          browserPrintDebug,
          jobs: decision.jobs,
        }
      } catch (error) {
        const browserPrintDebug =
          // Sinif calisma zamaninda gerekir; modul zaten yuklenmistir
          // (hata ancak baski denendikten sonra olusabilir).
          error instanceof (await loadLabelRenderer()).BrowserLabelPrintError
            ? (error as BrowserLabelPrintErrorType).debug
            : undefined
        const reason =
          error instanceof Error
            ? error.message
            : 'Temiz etiket baskı belgesi oluşturulamadı.'
        return {
          fileName,
          content,
          status: 'failed',
          ok: false,
          provider: 'browser-label-document',
          printerName: input.printerSettings.printerName,
          browserPrintDebug,
          errorMessage: reason,
          // Hata dalinda da SIPARIS BAZINDA sebep tasinir; bos jobs[] her
          // siparisi generic "Baski dogrulanmadi" mesajina dusuruyordu.
          jobs: printableOrders.map((order) => ({
            orderNumber: order.orderNumber,
            ok: false,
            errorMessage: reason,
          })),
        }
      }
    }

    if (input.printerSettings.mode === 'download') {
      return {
        fileName,
        content,
        status: 'download_required',
        ok: true,
        provider: 'browser-download',
        printerName: input.printerSettings.printerName,
      }
    }

    // ── SUNUCU YETKİLİ HAM BASKI (SERVER_WINDOWS_RAW) ───────────────────
    //
    // ═══ ÖLÇÜLEN GÜVEN SINIRI KUSURU — KAPATILDI ══════════════════════
    //
    // Bu dal ESKİDEN etiket BAYTLARINI istemcide kurup sunucuya
    // gönderiyordu (`labels[].zpl`). Sunucu o baytları doğrudan yazıcı
    // komutuna veriyordu; yani kimlik doğrulanmış bir tarayıcı KENDİ
    // uydurduğu ZPL'i "taşıyıcı etiketi" diye bastırabiliyordu. Taşıyıcı
    // artefaktı SUNUCU YETKİLİDİR ve istemci onu YERİNE KOYAMAZ.
    //
    // Artık YALNIZ KİMLİK gönderilir. Baytları sunucu çözer: kiracı
    // kapsamı → kalıcı artefakt → hash zinciri → değişmez sayfa sırası.
    // İstemci `technicalZpl`e GERİ DÖNMEZ ve ham ZPL'i HİÇ görmez.
    const items = printableOrders.map((order) => ({
      orderId: String(order.id ?? ''),
      orderNumber: order.orderNumber,
    }))
    try {
      const response = await fetch('/api/printing/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerName: input.printerSettings.printerName,
          items,
        }),
      })
      const data = await response.json()
      return {
        fileName,
        content,
        // "gönderildi" ≠ "kâğıt çıktı": durum işletim sistemi/yazıcı
        // kuyruğunun KABULÜNÜ ifade eder.
        status: data.ok ? 'printed' : 'failed',
        ok: Boolean(response.ok && data.ok),
        provider: data.provider ?? 'server-windows-raw',
        printerName: input.printerSettings.printerName,
        printJobId: data.jobId,
        errorMessage: data.ok ? undefined : data.message ?? data.code,
        jobs: data.jobs,
      }
    } catch (error) {
      return {
        fileName,
        content,
        status: 'failed',
        ok: false,
        provider: 'server-windows-raw',
        printerName: input.printerSettings.printerName,
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Yazdırma servisine erişilemedi.',
      }
    }
  }
}
