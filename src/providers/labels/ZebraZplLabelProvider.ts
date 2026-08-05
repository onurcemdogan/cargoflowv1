import type { Label } from '../../types/cargoflow'
import { createId } from '../../utils/ids'
import type { LabelData, LabelDataItem } from '../../utils/labelData'
import {
  buildProductItemBlocks,
  paginateProductBlocks,
  type LabelProductLine,
} from '../../utils/labelProductLines'
import { verifySuratShipment } from '../../utils/suratVerification'
import { resolveSuratPrintEligibility } from '../../utils/suratPrintEligibility'
import { resolveSuratBarcodeRawZpl } from '../../utils/zpl'
import { validateOfficialSuratZpl } from '../../utils/officialSuratLabel'
import { deriveAugmentedSuratZplWithHashes } from '../../utils/augmentedSuratZpl'
import {
  DEFAULT_DESI_MISSING_MESSAGE,
  resolveEffectiveLabelDesi,
} from '../../utils/labelDesi'
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
// Referans etikette sol dikey ray DAR bir şerittir (önceki 58 çok genişti).
const RAIL_WIDTH = 44
// Çerçeve/ayraç kalınlığı: referans baskıda çizgiler İNCE (önceki 2 kalındı).
const LINE = 1

// Yatay bant sınırları (referans fotoğraftaki dikey oranlara göre).
const Y_HEADER_END = 88
const Y_BARCODE_END = 232
const Y_RECIPIENT_END = 392
const Y_SUMMARY_END = 452
const Y_ROUTING_END = 690

// Ödeme/birim/desi satırı üç eşit hücre (ray sağından etiket sonuna).
const CELL_1 = RAIL_WIDTH
const CELL_2 = 295
const CELL_3 = 546

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
  // TEK fiziksel etiket: devam sayfası ÜRETİLMEZ.
  return paginateProductBlocks(blocks, {
    firstPageLines: PRODUCT_MAX_LINES,
    continuationPageLines: PRODUCT_MAX_LINES,
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


// Yönlendirme bandı metin genişliği: x=222'den küçük QR'ın (x=696) soluna.
const ROUTE_X = 196
const QR_LEFT_X = 56
const QR_LEFT_Y = 468
const QR_LEFT_MAG = 5
const QR_RIGHT_X = 688
const QR_RIGHT_Y = 468
const QR_RIGHT_MAG = 3
const ROUTE_WIDTH = 476
// Dikey bütçe: parça/teslim satırlarının altından ürün çizgisinin üstüne.
const ROUTE_BAND_TOP = 536
const ROUTE_BAND_BOTTOM = Y_ROUTING_END - 4
// İri→küçük punto merdiveni (kesme yerine güvenli küçültme).
const ROUTE_FONT_LADDER = [48, 42, 36, 31, 27, 23]

// NOT: Sürat için ARTIK KULLANILMAZ (resmî provider ZPL'i tek kaynak doğrusudur).
// Diğer/legacy entegrasyonlar için korunur ve dışa açılır.
export function buildZpl(labelData: LabelData): string {
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
    // ── Çerçeve + İNCE ayraçlar (referans baskıdaki gibi) ────────────────
    `^FO0,0^GB${LABEL_WIDTH_DOTS},${LABEL_HEIGHT_DOTS},${LINE}^FS`,
    `^FO${RAIL_WIDTH},0^GB${LINE},${LABEL_HEIGHT_DOTS},${LINE}^FS`,
    `^FO${RAIL_WIDTH},${Y_HEADER_END}^GB${799 - RAIL_WIDTH},${LINE},${LINE}^FS`,
    `^FO${RAIL_WIDTH},${Y_BARCODE_END}^GB${799 - RAIL_WIDTH},${LINE},${LINE}^FS`,
    `^FO${RAIL_WIDTH},${Y_RECIPIENT_END}^GB${799 - RAIL_WIDTH},${LINE},${LINE}^FS`,
    `^FO${RAIL_WIDTH},${Y_SUMMARY_END}^GB${799 - RAIL_WIDTH},${LINE},${LINE}^FS`,
    `^FO${RAIL_WIDTH},${Y_ROUTING_END}^GB${799 - RAIL_WIDTH},${LINE},${LINE}^FS`,

    // ── Sol dikey DAR ray: marka + sipariş referansı ──────────────────────
    ...['^FO10,84^A0B,22,22^FDSURAT KARGO^FS', '^FO11,84^A0B,22,22^FDSURAT KARGO^FS'],
    `^FO12,600^A0B,15,15^FDSiparis No: ${zplSafe(leftReference, 48)}^FS`,

    // ── Üst blok (kompakt): Sube / GÖNDERİCİ adı / MUST.IRS.NO — sağda T.No.
    // Alıcı adı/telefonu BURAYA GİRMEZ (yalnız alıcı kutusunda).
    ...textField(56, 8, 20, `^FDSube: ${zplSafe(labelData.branchName, 24)}^FS`),
    ...textField(56, 32, 26, `^FD${zplUpper(labelData.senderName ?? '', 34)}^FS`),
    `^FO56,62^A0N,16,16^FDMUST.IRS.NO: ${zplSafe(labelData.orderNumber, 42)}^FS`,
    ...textField(480, 10, 20, `^FDT.No: ${zplSafe(trackingText, 30)}^FS`),
    // Gönderici telefonu YALNIZ gerçekten varsa (alıcı telefonu BURAYA GİRMEZ).
    ...(senderPhone
      ? [`^FO480,42^A0N,15,15^FDTEL: ${zplSafe(maskPhone(senderPhone), 20)}^FS`]
      : []),

    // ── Büyük 1D barkod: kullanılabilir yatay alanın neredeyse tamamı.
    // PROVIDER İÇERİĞİ AYNEN; kalınlaştırma UYGULANMAZ.
    `^FO88,98^BY4,2,110^BCN,110,Y,N,N^FD${zplSafe(labelData.barcodeValue, 60)}^FS`,

    // ── Alıcı kutusu: TEK geniş alan, dikey ayraç YOK, kompakt.
    ...textField(56, 240, 22, `^FD${zplUpper(labelData.recipientName, 40)}^FS`),
    `^FO56,268^A0N,18,18^FB731,3,3,L,0^FD${zplUpper(labelData.address, 220)}^FS`,
    `^FO56,358^A0N,16,16^FDTEL: ${zplSafe(maskPhone(labelData.recipientPhone), 24)}^FS`,
    `^FO420,358^A0N,18,18^FB367,1,0,R,0^FD${zplUpper(labelData.routeCenter, 42)}^FS`,

    // ── Ödeme / Birim / Top Ds/Kg: ince ayraç, küçük başlık, kontrollü kalın değer.
    `^FO${CELL_2},${Y_RECIPIENT_END}^GB${LINE},${Y_SUMMARY_END - Y_RECIPIENT_END},${LINE}^FS`,
    `^FO${CELL_3},${Y_RECIPIENT_END}^GB${LINE},${Y_SUMMARY_END - Y_RECIPIENT_END},${LINE}^FS`,
    `^FO${CELL_1 + 12},398^A0N,15,15^FDOdemeTipi^FS`,
    `^FO${CELL_2 + 12},398^A0N,15,15^FDBirim^FS`,
    `^FO${CELL_3 + 12},398^A0N,15,15^FDTop Ds/Kg^FS`,
    ...textField(CELL_1 + 12, 418, 28, '^FDPOCH^FS'),
    ...textField(CELL_2 + 12, 418, 28, '^FDKOLI^FS'),
    ...textField(CELL_3 + 12, 418, 28, `^FD${desiKg}^FS`),

    // ── Yönlendirme: sol BÜYÜK QR, orta parça/teslim + rota, sağ KÜÇÜK QR.
    // QR payload'ları provider içeriğidir; AYNEN korunur.
    `^FO${QR_LEFT_X},${QR_LEFT_Y}^BQN,2,${QR_LEFT_MAG}^FDLA,${zplSafe(
      `${labelData.orderNumber}|${labelData.barcodeValue}`,
      90,
    )}^FS`,
    `^FO${ROUTE_X},462^A0N,17,17^FDParca Adedi^FS`,
    ...textField(ROUTE_X, 484, 32, '^FD1 / 1^FS'),
    ...textField(ROUTE_X + 130, 462, 30, '^FDAdrese Teslim^FS'),
    // Uzun metin KESİLMEZ: sığan en iri punto, gerekirse 2 satır; sağ QR'a taşmaz.
    ...routingRows.flatMap((row) =>
      textField(
        ROUTE_X,
        row.y,
        row.font,
        `^FB${ROUTE_WIDTH},${row.lines},0,L,0^FD${row.text}^FS`,
      ),
    ),
    `^FO${QR_RIGHT_X},${QR_RIGHT_Y}^BQN,2,${QR_RIGHT_MAG}^FDLA,${zplSafe(
      labelData.barcodeValue,
      60,
    )}^FS`,

    // En alt: ürün/model, renk, beden, varyant, SKU, barkod (ilk sayfa).
    ...productZplLines(productPages[0] ?? []),
    '^XZ',
  ].join('\n')
}

export class ZebraZplLabelProvider implements LabelProvider {
  async generateSingle(input: GenerateLabelInput): Promise<Label> {
    const { order, shipment, template } = input
    // NOT: Sürat etiket İÇERİĞİ artık buildLabelData/buildZpl'den ÜRETİLMEZ;
    // provider'ın resmî ZPL'i aynen kullanılır. Bu yüzden burada yalnız
    // doğrulama ve desi için gereken canonical alanlar çözülür.
    const verification = verifySuratShipment(order, shipment)
    // Efektif desi: kayıtlı/geçmiş değer varsa o; yoksa Ayarlar'daki
    // "Varsayılan Gönderi Desisi" × adet (mevcut çarpan sözleşmesi).
    // Kullanıcı sipariş bazında desi GİRMEZ.
    const effectiveDesi = resolveEffectiveLabelDesi(
      order,
      shipment,
      input.products ?? [],
      input.desiConfig,
    )
    const baseDesi = resolveNormalizedDesi(order, shipment)
    const normalizedDesi = {
      ...baseDesi,
      desi: effectiveDesi.desi ?? baseDesi.desi,
      desiSource: effectiveDesi.desiSource ?? baseDesi.desiSource,
    }
    // Render ve click AYNI eligibility helper'ını kullanır: VERIFIED veya
    // LABEL_READY_AWAITING_ACCEPTANCE + T.No + barkod etiket üretebilir.
    // Eski verifiedShipment / dispatchRegistrationConfirmed / Serendip
    // zorunluluğu kaldırıldı. Bu ilk kapı YALNIZ kimlik kapısıdır (T.No +
    // barkod çözülebiliyor mu). Sürat'in resmî ZPL'inin varlığı aşağıda,
    // validateOfficialSuratZpl ile ayrıca ZORUNLU tutulur.
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
    // Persistence katmanı provider BarcodeRaw'ını `technicalZpl` adı altında
    // normalize eder (server buildSafeZplReference). Bu yüzden technicalZpl de
    // resmî ZPL kaynağıdır ve zincire DAHİLDİR.
    const apiBarcodeRaw = resolveSuratBarcodeRawZpl(
      shipment.barcodeRaw,
      shipment.technicalZpl,
      shipment.suratCreateLog?.BarcodeRaw,
      shipment.suratCreateLog?.technicalZpl,
      verification.barcodeRaw,
    )
    // KAYITLI taşıyıcı ZPL'i (reprint) varsa doğrudan o basılır: yeni ZPL
    // ÜRETİLMEZ, bu yüzden desi GEREKMEZ. Desi doğrulaması YALNIZ ZPL'i
    // CargoFlow'un üreteceği (kayıtlı ZPL yok — fresh create / legacy HTML)
    // durumda çalışır. Böylece daha önce basılmış (LABEL_PRINTED) siparişte
    // "Etiketi Yazdır" desi istemeden kayıtlı etiketi yeniden basar.
    // Kayıtlı taşıyıcı ZPL (reprint) varsa desi GEREKMEZ; eski etiket aynen
    // basılır. Yalnız YENİ etiket üretiminde efektif desi zorunludur ve
    // kaynağı Ayarlar'daki varsayılandır (per-order desi girişi YOK).
    const hasPersistedZpl = Boolean(apiBarcodeRaw)
    if (!hasPersistedZpl && normalizedDesi.desi == null) {
      throw new Error(
        effectiveDesi.blockedReason ?? DEFAULT_DESI_MISSING_MESSAGE,
      )
    }
    const apiResponseDesi = extractZplDesi(apiBarcodeRaw)
    const desiMismatch = desiValuesDiffer(
      normalizedDesi.desi,
      apiResponseDesi,
    )
    // ── TEK KAYNAK DOĞRUSU: SÜRAT'İN RESMÎ ZPL'İ ────────────────────────────
    // Sürat etiketi CargoFlow tarafından yeniden TASARLANMAZ. Provider'ın kendi
    // ZPL'i (OrtakBarkodOlustur → BarcodeRaw) doğrulanır ve BYTE-FOR-BYTE aynen
    // kullanılır: ^PW/^LL/^FO/^GB/^BC/^BQ, font, rota ve kutu koordinatlarına
    // DOKUNULMAZ, buildZpl'den GEÇİRİLMEZ. Devam/ikinci sayfa ÜRETİLMEZ.
    //
    // Resmî ZPL yoksa veya doğrulamayı geçmezse CargoFlow şablonuna FALLBACK
    // YAPILMAZ; kullanıcıya açık hata verilir (sahte/yanlış etiket basılmaz).
    const official = validateOfficialSuratZpl(apiBarcodeRaw, {
      trackingNumber: eligibility.trackingNumber,
      barcode: eligibility.barcode,
    })
    if (!official.ok) {
      throw new Error(`Sürat resmî etiketi alınamadı: ${official.reason}`)
    }
    // TÜRETİLMİŞ baskı ZPL'i: resmî kaynak AYNEN korunur (technicalZpl
    // ÜZERİNE YAZILMAZ), yalnız final ^PQ / ^XZ öncesine ürün satırı eklenir.
    // Native/raw-ZPL yolu bu türetilmiş çıktıyı gönderir; indirme ve önizleme
    // ile AYNI deterministik artefakt ve AYNI SHA kullanılır.
    const augmented = deriveAugmentedSuratZplWithHashes(
      official.zpl,
      (order.items ?? []).map((item) => ({
        productName: String(item.productName ?? ''),
        quantity: Number(item.quantity) || 1,
        color: item.color,
        size: item.size,
        sku: item.merchantSku || item.sku,
      })),
    )
    const zplContent = augmented.printZpl
    const zplSource = 'surat.ortakBarkod.BarcodeRaw'
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
      // Kaynak ZPL ve hash'ler audit/teşhis içindir; kullanıcıya ayrı bir
      // "Kaynak ZPL indir" aksiyonu SUNULMAZ.
      sourceZplContent: augmented.sourceZpl,
      printZplSha256: augmented.printZplSha256,
      printZplSourceSha256: augmented.printZplSourceSha256,
      printZplVersion: augmented.printZplVersion,
      printZplFooterProfile: augmented.printZplFooterProfile ?? undefined,
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
