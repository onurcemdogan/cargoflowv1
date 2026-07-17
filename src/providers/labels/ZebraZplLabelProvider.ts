import type { Label } from '../../types/cargoflow'
import { createId } from '../../utils/ids'
import { buildLabelData, type LabelData, type LabelDataItem } from '../../utils/labelData'
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

function productTitle(item?: LabelDataItem): string {
  if (!item) return 'Ürün bilgisi yok'
  return `${item.quantity || 1} x ${item.productName}`
}

function productMeta(item?: LabelDataItem): string {
  if (!item) return ''
  return [
    item.color ? `Renk: ${item.color}` : '',
    item.size ? `Beden: ${item.size}` : '',
    item.sku ? `SKU: ${item.sku}` : '',
  ]
    .filter(Boolean)
    .join(' | ')
}

function buildZpl(labelData: LabelData): string {
  const trackingText = labelData.tNo || '-'
  const leftReference =
    labelData.leftVerticalReference ||
    labelData.shipmentReference ||
    labelData.orderNumber
  const primaryItem = labelData.items[0]
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

    '^FO14,92^A0B,24,24^FDSURAT KARGO^FS',
    `^FO16,560^A0B,17,17^FDRef No: ${zplSafe(
      leftReference,
      48,
    )}^FS`,

    `^FO72,12^A0N,22,22^FDSube: ${zplSafe(labelData.branchName, 24)}^FS`,
    `^FO72,38^A0N,29,29^FD${zplUpper(labelData.recipientName, 34)}^FS`,
    `^FO72,70^A0N,18,18^FDMUST.IRS.NO: ${zplSafe(
      labelData.orderNumber,
      42,
    )}^FS`,
    `^FO500,18^A0N,22,22^FDT.No: ${zplSafe(trackingText, 30)}^FS`,
    `^FO500,58^A0N,16,16^FDTEL: ${zplSafe(
      maskPhone(labelData.recipientPhone),
      20,
    )}^FS`,

    `^FO88,104^BY3,2,120^BCN,120,Y,N,N^FD${zplSafe(
      labelData.barcodeValue,
      60,
    )}^FS`,

    '^FO68,250^GB720,180,1^FS',
    '^FO568,250^GB1,180,1^FS',
    `^FO80,260^A0N,24,24^FD${zplUpper(labelData.recipientName, 38)}^FS`,
    `^FO80,290^A0N,20,20^FB468,3,4,L,0^FD${zplUpper(
      labelData.address,
      150,
    )}^FS`,
    `^FO80,375^A0N,22,22^FD${zplUpper(labelData.routeCenter, 42)}^FS`,
    `^FO80,408^A0N,18,18^FDTEL: ${zplSafe(
      maskPhone(labelData.recipientPhone),
      24,
    )}^FS`,
    `^FO586,335^A0N,27,27^FB188,2,4,C,0^FD${zplUpper(
      labelData.routeCenter,
      38,
    )}^FS`,

    '^FO58,440^GB247,80,1^FS',
    '^FO305,440^GB247,80,1^FS',
    '^FO552,440^GB247,80,1^FS',
    '^FO74,450^A0N,17,17^FDOdemeTipi^FS',
    '^FO318,450^A0N,17,17^FDBirim^FS',
    '^FO566,450^A0N,17,17^FDTop Ds/Kg^FS',
    '^FO74,478^A0N,35,35^FDPOCH^FS',
    '^FO318,478^A0N,35,35^FDKOLI^FS',
    `^FO566,478^A0N,35,35^FD${desiKg}^FS`,

    `^FO74,538^BQN,2,7^FDLA,${zplSafe(
      `${labelData.orderNumber}|${labelData.barcodeValue}`,
      90,
    )}^FS`,
    '^FO222,528^A0N,20,20^FDParca Adedi^FS',
    '^FO222,556^A0N,38,38^FD1 / 1^FS',
    '^FO344,528^A0N,36,36^FDAdrese Teslim^FS',
    `^FO222,598^A0N,49,49^FB430,1,0,L,0^FD${zplUpper(
      labelData.routeCenter,
      32,
    )}^FS`,
    `^FO222,648^A0N,50,50^FB430,1,0,L,0^FD${zplUpper(
      labelData.transferCenter,
      32,
    )}^FS`,
    `^FO696,540^BQN,2,4^FDLA,${zplSafe(labelData.barcodeValue, 60)}^FS`,

    `^FO72,708^A0N,20,20^FB704,2,4,L,0^FD${zplSafe(
      productTitle(primaryItem),
      120,
    )}^FS`,
    `^FO72,754^A0N,17,17^FB704,2,4,L,0^FD${zplSafe(
      productMeta(primaryItem),
      150,
    )}^FS`,
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
    if (normalizedDesi.desi == null) {
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
    const apiBarcodeRaw = resolveSuratBarcodeRawZpl(
      shipment.barcodeRaw,
      shipment.suratCreateLog?.BarcodeRaw,
      verification.barcodeRaw,
    )
    const apiResponseDesi = extractZplDesi(apiBarcodeRaw)
    const desiMismatch = desiValuesDiffer(
      normalizedDesi.desi,
      apiResponseDesi,
    )
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
