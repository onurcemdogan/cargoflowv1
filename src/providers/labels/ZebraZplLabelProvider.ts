import type { Label } from '../../types/cargoflow'
import { createId } from '../../utils/ids'
import { buildLabelData, type LabelData, type LabelDataItem } from '../../utils/labelData'
import { buildLabelProductLines } from '../../utils/labelProductLines'
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
const PRODUCT_START_Y = 701
const PRODUCT_LINE_HEIGHT = 18
const PRODUCT_MAX_LINES = 5
const PRODUCT_X = 72
const PRODUCT_TITLE_FONT = 17
const PRODUCT_META_FONT = 15
// Font genişliği ~0.58×yükseklik; x=72'den 795'e ≈ 723 nokta kullanılabilir.
const PRODUCT_TITLE_MAX_CHARS = 66
const PRODUCT_META_MAX_CHARS = 74

// ZPL'de yerleşik "bold" komutu YOKTUR. Termal baskıda metni koyulaştırmanın
// güvenli yolu aynı METİN alanını 1 nokta kaydırarak iki kez basmaktır
// (double-strike / faux bold). Bu teknik YALNIZ metin (^A0/^FD) alanlarına
// uygulanır; ^BC (1D barkod) ve ^BQ (QR) alanlarına ASLA dokunulmaz ve genel
// baskı koyuluğu (^MD/~SD) DEĞİŞTİRİLMEZ → barkod taranabilirliği korunur.
function boldText(x: number, y: number, body: string): string[] {
  return [`^FO${x},${y}${body}`, `^FO${x + 1},${y}${body}`]
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
function productZplLines(items: LabelDataItem[]): string[] {
  const lines = buildLabelProductLines(items ?? [], {
    maxLines: PRODUCT_MAX_LINES,
    titleMaxChars: PRODUCT_TITLE_MAX_CHARS,
    metaMaxChars: PRODUCT_META_MAX_CHARS,
  })
  return lines.flatMap((line, index) => {
    const y = PRODUCT_START_Y + index * PRODUCT_LINE_HEIGHT
    const font = line.kind === 'title' ? PRODUCT_TITLE_FONT : PRODUCT_META_FONT
    const body = `^A0N,${font},${font}^FD${zplSafe(line.text, 160)}^FS`
    // Başlık satırları koyu (faux bold); meta satırı normal kalır ki küçük
    // punto okunaklılığı bozulmasın.
    return line.kind === 'title'
      ? boldText(PRODUCT_X, y, body)
      : [`^FO${PRODUCT_X},${y}${body}`]
  })
}

function buildZpl(labelData: LabelData): string {
  const trackingText = labelData.tNo || '-'
  const leftReference =
    labelData.leftVerticalReference ||
    labelData.shipmentReference ||
    labelData.orderNumber
  const desiKg = formatDesi(labelData.desi)

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

    // Sol dikey ray (marka + referans).
    ...boldText(14, 92, '^A0B,24,24^FDSURAT KARGO^FS'),
    `^FO16,560^A0B,17,17^FDRef No: ${zplSafe(leftReference, 48)}^FS`,

    // Üst bölüm: şube / gönderici / müşteri irsaliye + T.No.
    ...boldText(72, 12, `^A0N,22,22^FDSube: ${zplSafe(labelData.branchName, 24)}^FS`),
    // NOT: üst bölüm ad/telefon kaynağı MEVCUT sözleşmedir (HTML önizleme ile
    // aynı: recipientName/recipientPhone). Bu tur yalnız okunabilirlik
    // (kalınlaştırma) değiştirir; alan kaynakları DEĞİŞMEZ.
    ...boldText(72, 38, `^A0N,29,29^FD${zplUpper(labelData.recipientName, 34)}^FS`),
    `^FO72,70^A0N,18,18^FDMUST.IRS.NO: ${zplSafe(labelData.orderNumber, 42)}^FS`,
    ...boldText(500, 18, `^A0N,22,22^FDT.No: ${zplSafe(trackingText, 30)}^FS`),
    `^FO500,58^A0N,16,16^FDTEL: ${zplSafe(
      maskPhone(labelData.recipientPhone),
      20,
    )}^FS`,

    // Büyük yatay 1D barkod + altında okunabilir takip numarası (^BC ... ,Y,).
    // PROVIDER İÇERİĞİ: barcodeValue aynen basılır, kalınlaştırma UYGULANMAZ.
    `^FO88,104^BY3,2,120^BCN,120,Y,N,N^FD${zplSafe(
      labelData.barcodeValue,
      60,
    )}^FS`,

    // Alıcı bölümü.
    '^FO68,250^GB720,180,1^FS',
    '^FO568,250^GB1,180,1^FS',
    ...boldText(80, 260, `^A0N,24,24^FD${zplUpper(labelData.recipientName, 38)}^FS`),
    `^FO80,290^A0N,20,20^FB468,3,4,L,0^FD${zplUpper(
      labelData.address,
      150,
    )}^FS`,
    ...boldText(80, 375, `^A0N,22,22^FD${zplUpper(labelData.routeCenter, 42)}^FS`),
    `^FO80,408^A0N,18,18^FDTEL: ${zplSafe(
      maskPhone(labelData.recipientPhone),
      24,
    )}^FS`,
    ...boldText(
      586,
      335,
      `^A0N,27,27^FB188,2,4,C,0^FD${zplUpper(labelData.routeCenter, 38)}^FS`,
    ),

    // Gönderi özeti: ödeme tipi / birim / desi-kg.
    '^FO58,440^GB247,80,1^FS',
    '^FO305,440^GB247,80,1^FS',
    '^FO552,440^GB247,80,1^FS',
    '^FO74,450^A0N,17,17^FDOdemeTipi^FS',
    '^FO318,450^A0N,17,17^FDBirim^FS',
    '^FO566,450^A0N,17,17^FDTop Ds/Kg^FS',
    ...boldText(74, 478, '^A0N,35,35^FDPOCH^FS'),
    ...boldText(318, 478, '^A0N,35,35^FDKOLI^FS'),
    ...boldText(566, 478, `^A0N,35,35^FD${desiKg}^FS`),

    // QR (provider referans içeriği AYNEN; boyut/quiet-zone değişmez).
    `^FO74,538^BQN,2,7^FDLA,${zplSafe(
      `${labelData.orderNumber}|${labelData.barcodeValue}`,
      90,
    )}^FS`,
    '^FO222,528^A0N,20,20^FDParca Adedi^FS',
    ...boldText(222, 556, '^A0N,38,38^FD1 / 1^FS'),
    ...boldText(344, 528, '^A0N,36,36^FDAdrese Teslim^FS'),
    // Büyük yönlendirme alanı: uzaktan okunabilir, kalın.
    ...boldText(
      222,
      598,
      `^A0N,49,49^FB430,1,0,L,0^FD${zplUpper(labelData.routeCenter, 32)}^FS`,
    ),
    ...boldText(
      222,
      648,
      `^A0N,50,50^FB430,1,0,L,0^FD${zplUpper(labelData.transferCenter, 32)}^FS`,
    ),
    `^FO696,540^BQN,2,4^FDLA,${zplSafe(labelData.barcodeValue, 60)}^FS`,

    // En alt: ürün/model, renk, beden, varyant, SKU (tüm satırlar).
    ...productZplLines(labelData.items),
    '^XZ',
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
