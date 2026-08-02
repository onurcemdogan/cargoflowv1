import type { Label } from '../../types/cargoflow'
import { createId } from '../../utils/ids'
import { buildLabelData, type LabelData, type LabelDataItem } from '../../utils/labelData'
import {
  buildProductItemBlocks,
  paginateProductBlocks,
  type LabelProductLine,
} from '../../utils/labelProductLines'
import { verifySuratShipment } from '../../utils/suratVerification'
import { resolveSuratPrintEligibility } from '../../utils/suratPrintEligibility'
import { resolveSuratBarcodeRawZpl } from '../../utils/zpl'
import {
  buildDesiDebug,
  desiValuesDiffer,
  extractZplDesi,
  formatDesi,
  resolveNormalizedDesi,
} from '../../utils/desi'
import type { GenerateLabelInput, LabelProvider } from './LabelProvider'

const LABEL_WIDTH_DOTS = 799
const LABEL_HEIGHT_DOTS = 799
const RAIL_WIDTH = 58

// ── Ürün bölümü (etiket ALT şeridi) — sabit, deterministik yerleşim ─────────
// Etiketin fiziksel yüksekliği (^LL799) DEĞİŞMEZ. Son yatay çizgi y=696'da,
// dış çerçeve 799'da biter; ürün şeridi bu aralıkta kalır ve barkod/QR
// alanlarına ASLA taşmaz.
// Ana etiketin ALT ürün şeridi. Son yatay çizgi y=696; dış çerçeve 799.
// 5 satır: y = 703,722,741,760,779 → en alt 779+17 = 796 ≤ 797 (taşma yok).
const PRODUCT_START_Y = 703
const PRODUCT_LINE_HEIGHT = 19
const PRODUCT_MAX_LINES = 5
const PRODUCT_X = 72
const PRODUCT_TITLE_FONT = 19
const PRODUCT_META_FONT = 17
// Font genişliği ≈0.58×yükseklik; x=72'den 793'e ≈ 721 nokta kullanılabilir.
const PRODUCT_TITLE_MAX_CHARS = 64
const PRODUCT_META_MAX_CHARS = 72

// ── DEVAM (continuation) ürün etiketi ───────────────────────────────────────
// Ana etikete sığmayan ürünler için ek SAYFA(lar). Kargo barkodu/QR/T.No
// İÇERMEZ, yeni gönderi OLUŞTURMAZ, desi/parça adedini DEĞİŞTİRMEZ; yalnız
// ürün detayı taşır. Aynı ^PW/^LL (10×10 cm) kullanılır.
const CONT_START_Y = 122
const CONT_LINE_HEIGHT = 21
const CONT_TITLE_FONT = 20
const CONT_META_FONT = 18
const CONT_TITLE_MAX_CHARS = 60
const CONT_META_MAX_CHARS = 66
// y = 122 + n*21 ≤ 742 (alt not için yer bırakılır) → 30 satır.
const CONT_MAX_LINES = 30

// Ortalama ^A0 (scalable) glif genişliği / yükseklik oranı. Metnin verilen
// piksel genişliğine sığıp sığmadığını kestirmek için kullanılır.
const GLYPH_WIDTH_RATIO = 0.58

// Yönlendirme bandı satır yerleşimi. Metin ASLA kesilmez: önce iri puntoda tek
// satır denenir, sığmazsa punto küçültülür, gerekirse en fazla 2 satıra sarılır.
// Seçilen kombinasyon bandın dikey bütçesine (598..694) sığmak zorundadır.
export interface RoutingRow {
  text: string
  font: number
  lines: number
  y: number
}

export function layoutRoutingRows(
  texts: string[],
  options: {
    widthDots: number
    top: number
    bottom: number
    ladder: number[]
    gap?: number
  },
): RoutingRow[] {
  const gap = options.gap ?? 4
  const budget = options.bottom - options.top
  for (const font of options.ladder) {
    const charsPerLine = Math.max(
      1,
      Math.floor(options.widthDots / (font * GLYPH_WIDTH_RATIO)),
    )
    const rows = texts.map((text) => ({
      text,
      font,
      lines: Math.max(1, Math.ceil(text.length / charsPerLine)),
    }))
    // En fazla 2 satır ve toplam yükseklik banda sığmalı.
    if (rows.some((row) => row.lines > 2)) continue
    const total =
      rows.reduce((sum, row) => sum + row.font * row.lines, 0) +
      gap * (rows.length - 1)
    if (total > budget) continue
    let cursor = options.top
    return rows.map((row) => {
      const placed = { ...row, y: cursor }
      cursor += row.font * row.lines + gap
      return placed
    })
  }
  // Son çare: en küçük punto, 2 satır sınırı (içerik yine kesilmez).
  const font = options.ladder[options.ladder.length - 1]
  let cursor = options.top
  return texts.map((text) => {
    const placed = { text, font, lines: 2, y: cursor }
    cursor += font * 2 + gap
    return placed
  })
}

// ZPL'de yerleşik "bold" komutu YOKTUR. Metni koyulaştırmanın güvenli yolu aynı
// METİN alanını 1 nokta kaydırarak iki kez basmaktır (double-strike).
//
// 203 DPI'da 1 nokta ≈ 0,125 mm'dir. KÜÇÜK puntolarda (adres, telefon, ürün
// satırı) bu kaydırma gövde kalınlığına oranla büyük kalır ve harfler fiziksel
// baskıda birbirine girip BULANIKLAŞIR. Bu yüzden double-strike YALNIZ
// BOLD_MIN_FONT ve üzeri (iri) metinlerde uygulanır — gerçek Sürat etiketinde de
// yalnız iri başlıklar kalındır. Küçük metinler tek geçiş (net) kalır.
// ^BC/^BQ alanlarına ASLA uygulanmaz; ^MD/~SD (genel koyuluk) DEĞİŞTİRİLMEZ.
const BOLD_MIN_FONT = 24

function textField(x: number, y: number, font: number, body: string): string[] {
  const field = `^A0N,${font},${font}${body}`
  return font >= BOLD_MIN_FONT
    ? [`^FO${x},${y}${field}`, `^FO${x + 1},${y}${field}`]
    : [`^FO${x},${y}${field}`]
}

function zplSafe(value: string | number, maxLength = 160): string {
  return String(value ?? '')
    .replace(/\^/g, '')
    .replace(/~/g, '')
    .replace(/\r?\n/g, ' ')
    .slice(0, maxLength)
}

function zplUpper(value: string, maxLength = 160): string {
  return zplSafe(value, maxLength).toLocaleUpperCase('tr-TR')
}

function maskPhone(phone: string): string {
  const normalized = String(phone ?? '').replace(/\s+/g, '')
  if (normalized.length < 7) return zplSafe(phone || '-')
  return `${normalized.slice(0, 3)}*****${normalized.slice(-2)}`
}

// Etiket alt şeridi: TÜM ürün satırları (yalnız ilki değil). Adet, ürün/model
// adı, renk, beden, diğer varyant ve SKU/barkod deterministik olarak yerleşir;
// sığmayan ürünler "+X ürün daha" ile özetlenir.
// Ürünleri sayfalara böler: [0] = ana etiketin alt şeridi, [1..] = DEVAM
// etiketleri. Hiçbir ürün özetlenmez/gizlenmez.
function paginateProducts(items: LabelDataItem[]): LabelProductLine[][] {
  const source = items ?? []
  if (source.length === 0) {
    return [[{ text: 'Ürün bilgisi yok', kind: 'title' }]]
  }
  const blocks = buildProductItemBlocks(source, {
    titleMaxChars: PRODUCT_TITLE_MAX_CHARS,
    metaMaxChars: PRODUCT_META_MAX_CHARS,
  })
  return paginateProductBlocks(blocks, {
    firstPageLines: PRODUCT_MAX_LINES,
    continuationPageLines: CONT_MAX_LINES,
  })
}

// Ana etiketin alt şeridi (ilk sayfa). Küçük punto → tek geçiş (net).
function productZplLines(page: LabelProductLine[]): string[] {
  return page.flatMap((line, index) => {
    const y = PRODUCT_START_Y + index * PRODUCT_LINE_HEIGHT
    const font = line.kind === 'title' ? PRODUCT_TITLE_FONT : PRODUCT_META_FONT
    return textField(PRODUCT_X, y, font, `^FD${zplSafe(line.text, 160)}^FS`)
  })
}

// DEVAM ürün etiketi. Sürat takip barkodu (^BC), QR (^BQ), T.No veya yeni
// gönderi YOKTUR; yalnız sipariş no + ürün detayı. Deterministiktir.
function buildContinuationZpl(
  labelData: LabelData,
  page: LabelProductLine[],
  pageIndex: number,
  pageTotal: number,
): string {
  return [
    '^XA',
    '^CI28',
    `^PW${LABEL_WIDTH_DOTS}`,
    `^LL${LABEL_HEIGHT_DOTS}`,
    '^LH0,0',
    '^FO0,0^GB799,799,2^FS',
    '^FO30,104^GB739,2,2^FS',
    ...textField(30, 26, 30, '^FDSIPARIS URUNLERI - DEVAM^FS'),
    `^FO30,68^A0N,22,22^FDSiparis No: ${zplSafe(labelData.orderNumber, 42)}^FS`,
    `^FO520,68^A0N,20,20^FB249,1,0,R,0^FDSayfa ${pageIndex} / ${pageTotal}^FS`,
    ...page.flatMap((line, index) => {
      const y = CONT_START_Y + index * CONT_LINE_HEIGHT
      const font = line.kind === 'title' ? CONT_TITLE_FONT : CONT_META_FONT
      const maxChars =
        line.kind === 'title' ? CONT_TITLE_MAX_CHARS : CONT_META_MAX_CHARS
      return textField(30, y, font, `^FD${zplSafe(line.text, maxChars + 20)}^FS`)
    }),
    // Bu sayfanın kargo etiketi OLMADIĞI açıkça yazılır (yanlış okutma önlenir).
    '^FO30,760^A0N,17,17^FDBu sayfa kargo etiketi degildir; kargo barkodu ve QR icermez.^FS',
    '^XZ',
  ].join('\n')
}

// Yönlendirme bandı metin genişliği: x=222'den küçük QR'ın (x=696) soluna.
const ROUTE_WIDTH = 462
// Dikey bütçe: "Adrese Teslim/1-1" satırlarının altından ürün çizgisinin (696) üstüne.
const ROUTE_BAND_TOP = 598
const ROUTE_BAND_BOTTOM = 694
// İri→küçük punto merdiveni (kesme yerine güvenli küçültme).
const ROUTE_FONT_LADDER = [50, 44, 38, 33, 28, 24]

function buildZpl(labelData: LabelData): string {
  const trackingText = labelData.tNo || '-'
  const leftReference =
    labelData.leftVerticalReference ||
    labelData.shipmentReference ||
    labelData.orderNumber
  const desiKg = formatDesi(labelData.desi)
  const senderPhone = String(labelData.senderPhone ?? '').trim()
  // TÜM ürünler sayfalanır: [0] ana etiket şeridi, [1..] DEVAM etiketleri.
  const productPages = paginateProducts(labelData.items)
  // Varış şubesi + aktarma merkezi: KESİLMEZ. Sığacak en iri punto seçilir,
  // gerekirse en fazla 2 satıra sarılır; band bütçesine (598..694) uyar.
  const routingRows = layoutRoutingRows(
    [zplUpper(labelData.routeCenter, 60), zplUpper(labelData.transferCenter, 60)],
    {
      widthDots: ROUTE_WIDTH,
      top: ROUTE_BAND_TOP,
      bottom: ROUTE_BAND_BOTTOM,
      ladder: ROUTE_FONT_LADDER,
    },
  )

  return [
    '^XA',
    '^CI28',
    `^PW${LABEL_WIDTH_DOTS}`,
    `^LL${LABEL_HEIGHT_DOTS}`,
    '^LH0,0',
    '^FO0,0^GB799,799,2^FS',
    `^FO${RAIL_WIDTH},0^GB2,799,2^FS`,
    '^FO58,96^GB741,2,2^FS',
    '^FO58,240^GB741,2,2^FS',
    '^FO58,440^GB741,2,2^FS',
    '^FO58,520^GB741,2,2^FS',
    '^FO58,696^GB741,2,2^FS',

    // ── Sol dikey ray: marka + sipariş referansı (gerçek etiketteki gibi). ──
    ...['^FO14,92^A0B,24,24^FDSURAT KARGO^FS', '^FO15,92^A0B,24,24^FDSURAT KARGO^FS'],
    `^FO16,600^A0B,17,17^FDSiparis No: ${zplSafe(leftReference, 48)}^FS`,

    // ── Üst blok: Sube / GÖNDERİCİ adı / MUST.IRS.NO — sağda T.No (+ varsa
    // gönderici TEL). Alıcı adı/telefonu BURAYA GİRMEZ; onlar yalnız ortadaki
    // alıcı kutusundadır (gerçek etiket sözleşmesi).
    ...textField(72, 12, 22, `^FDSube: ${zplSafe(labelData.branchName, 24)}^FS`),
    ...textField(72, 38, 29, `^FD${zplUpper(labelData.senderName ?? '', 34)}^FS`),
    `^FO72,70^A0N,18,18^FDMUST.IRS.NO: ${zplSafe(labelData.orderNumber, 42)}^FS`,
    ...textField(500, 14, 22, `^FDT.No: ${zplSafe(trackingText, 30)}^FS`),
    // Gönderici telefonu YALNIZ gerçekten varsa basılır (sahte numara YOK).
    ...(senderPhone
      ? [`^FO500,58^A0N,16,16^FDTEL: ${zplSafe(maskPhone(senderPhone), 20)}^FS`]
      : []),

    // ── Büyük yatay 1D barkod + altında okunabilir takip no (^BC ... ,Y,).
    // PROVIDER İÇERİĞİ: barcodeValue aynen; kalınlaştırma UYGULANMAZ.
    `^FO88,104^BY3,2,120^BCN,120,Y,N,N^FD${zplSafe(
      labelData.barcodeValue,
      60,
    )}^FS`,

    // ── Alıcı kutusu: ad, açık adres, telefon; sağ altta il/ilçe (varış).
    // routeCenter burada TEK KEZ görünür (ayrı sağ hücrede tekrar edilmez).
    '^FO68,250^GB720,180,1^FS',
    ...textField(80, 260, 24, `^FD${zplUpper(labelData.recipientName, 38)}^FS`),
    `^FO80,292^A0N,20,20^FB700,4,4,L,0^FD${zplUpper(labelData.address, 220)}^FS`,
    `^FO80,398^A0N,18,18^FDTEL: ${zplSafe(
      maskPhone(labelData.recipientPhone),
      24,
    )}^FS`,
    `^FO420,398^A0N,20,20^FB360,1,0,R,0^FD${zplUpper(
      labelData.routeCenter,
      42,
    )}^FS`,

    // ── Gönderi özeti: OdemeTipi / Birim / Top Ds/Kg (foto oranları).
    '^FO58,440^GB247,80,1^FS',
    '^FO305,440^GB247,80,1^FS',
    '^FO552,440^GB247,80,1^FS',
    '^FO74,450^A0N,17,17^FDOdemeTipi^FS',
    '^FO318,450^A0N,17,17^FDBirim^FS',
    '^FO566,450^A0N,17,17^FDTop Ds/Kg^FS',
    ...textField(74, 478, 35, '^FDPOCH^FS'),
    ...textField(318, 478, 35, '^FDKOLI^FS'),
    ...textField(566, 478, 35, `^FD${desiKg}^FS`),

    // ── Yönlendirme bandı: sol büyük QR, Parca Adedi / Adrese Teslim,
    // altında iki KALIN satır (varış şubesi + aktarma merkezi), sağda küçük QR.
    // QR payload'ları provider içeriğidir; AYNEN korunur.
    `^FO74,538^BQN,2,7^FDLA,${zplSafe(
      `${labelData.orderNumber}|${labelData.barcodeValue}`,
      90,
    )}^FS`,
    '^FO222,528^A0N,20,20^FDParca Adedi^FS',
    ...textField(222, 556, 38, '^FD1 / 1^FS'),
    ...textField(344, 528, 36, '^FDAdrese Teslim^FS'),
    // Uzun metin KESİLMEZ: sığan en iri punto seçilir, gerekirse ^FB ile en
    // fazla 2 satıra sarılır. Genişlik küçük QR'ın (x=696) solunda biter →
    // QR alanına taşma yok.
    ...routingRows.flatMap((row) =>
      textField(
        222,
        row.y,
        row.font,
        `^FB${ROUTE_WIDTH},${row.lines},0,L,0^FD${row.text}^FS`,
      ),
    ),
    `^FO696,540^BQN,2,4^FDLA,${zplSafe(labelData.barcodeValue, 60)}^FS`,

    // En alt: ürün/model, renk, beden, varyant, SKU, barkod (ilk sayfa).
    ...productZplLines(productPages[0] ?? []),
    '^XZ',
    // Sığmayan ürünler için DEVAM etiketleri (aynı ZPL akışında ayrı sayfalar).
    // Kargo barkodu/QR/T.No YOK; desi ve parça adedi DEĞİŞMEZ.
    ...productPages
      .slice(1)
      .map((page, index) =>
        buildContinuationZpl(
          labelData,
          page,
          index + 2,
          productPages.length,
        ),
      ),
  ].join('\n')
}

export class ZebraZplLabelProvider implements LabelProvider {
  async generateSingle(input: GenerateLabelInput): Promise<Label> {
    const { order, shipment, template, mappingConfig } = input
    const labelData = buildLabelData(order, shipment, template, mappingConfig)
    const verification = verifySuratShipment(order, shipment)
    const normalizedDesi = resolveNormalizedDesi(order, shipment)
    // Render ve click AYNI eligibility helper'ını kullanır: VERIFIED veya
    // LABEL_READY_AWAITING_ACCEPTANCE + T.No + barkod etiket üretebilir.
    // Eski verifiedShipment / dispatchRegistrationConfirmed / Serendip
    // zorunluluğu kaldırıldı. Not: bu sağlayıcı ZPL'i KENDİSİ ürettiği için
    // Sürat ham ZPL'inin varlığı burada şart değildir.
    const eligibility = resolveSuratPrintEligibility(order, shipment)
    const printableState =
      eligibility.verified || eligibility.awaitingAcceptance
    if (
      !printableState ||
      !eligibility.trackingNumber ||
      !eligibility.barcode
    ) {
      const reason = !printableState
        ? 'Etiket doğrulanmış veya kabul-bekleyen (LABEL_READY_AWAITING_ACCEPTANCE) durumda değil.'
        : 'T.No veya barkod çözülemedi.'
      throw new Error(`Etiket yazdırılamadı: ${reason}`)
    }
    const apiBarcodeRaw = resolveSuratBarcodeRawZpl(
      shipment.barcodeRaw,
      shipment.suratCreateLog?.BarcodeRaw,
      verification.barcodeRaw,
    )
    // KAYITLI taşıyıcı ZPL'i (reprint) varsa doğrudan o basılır: yeni ZPL
    // ÜRETİLMEZ, bu yüzden desi GEREKMEZ. Desi doğrulaması YALNIZ ZPL'i
    // CargoFlow'un üreteceği (kayıtlı ZPL yok — fresh create / legacy HTML)
    // durumda çalışır. Böylece daha önce basılmış (LABEL_PRINTED) siparişte
    // "Etiketi Yazdır" desi istemeden kayıtlı etiketi yeniden basar.
    const hasPersistedZpl = Boolean(apiBarcodeRaw)
    if (!hasPersistedZpl && normalizedDesi.desi == null) {
      throw new Error(
        'Desi bilgisi eksik. Etiket oluşturmadan önce sipariş desisini girin.',
      )
    }
    const officialSource = eligibility.verified
      ? verification.barcodeSource || 'surat.verifiedBarcode'
      : 'surat.create.preassignedBarkod'
    const liveLabelData: LabelData = {
      ...labelData,
      tNo: eligibility.trackingNumber,
      trackingNumber: eligibility.trackingNumber,
      barcodeValue: eligibility.barcode,
      mainBarcodeValue: eligibility.barcode,
      barcodeSource: officialSource,
      tNoSource: eligibility.verified
        ? verification.tNoSource
        : 'surat.create.preassignedTNo',
      mainBarcodeSource: officialSource,
    }
    const apiResponseDesi = extractZplDesi(apiBarcodeRaw)
    const desiMismatch = desiValuesDiffer(
      normalizedDesi.desi,
      apiResponseDesi,
    )
    // Reprint: kayıtlı taşıyıcı ZPL'i olduğu gibi kullanılır. Fresh create:
    // canonical alanlardan üretilir.
    // Etiket içeriği HER ZAMAN canonical alanlardan yeniden üretilir (temiz
    // CargoFlow ZPL). Reprint'te tek fark desi DOĞRULAMASININ atlanmasıdır;
    // içerik üretimi/kaynağı değişmez (fresh-create ile aynı davranış korunur).
    const zplContent = buildZpl(liveLabelData)
    const zplSource = 'generated'
    const desiMismatchWarning = desiMismatch
      ? 'API’den dönen etiket desisi, CargoFlow önizlemesinden farklı.'
      : undefined
    const desiDebug = buildDesiDebug(
      order,
      {
        ...normalizedDesi,
        apiResponseDesi:
          apiResponseDesi ?? normalizedDesi.apiResponseDesi,
      },
      normalizedDesi.desi,
    )

    return {
      id: createId('lbl'),
      labelType: 'zpl',
      barcodeFormat: 'Code128',
      barcodeValue: eligibility.barcode,
      templateId: template.id,
      zplContent,
      zplSource,
      desi: normalizedDesi.desi,
      desiSource: normalizedDesi.desiSource,
      desiDebug,
      desiMismatchWarning,
      createdAt: new Date().toISOString(),
    }
  }

  async generateBatch(input: GenerateLabelInput[]): Promise<Label[]> {
    return Promise.all(input.map((item) => this.generateSingle(item)))
  }
}
