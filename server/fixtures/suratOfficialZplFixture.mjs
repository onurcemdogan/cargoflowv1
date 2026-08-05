// SENTETİK RESMÎ SÜRAT ZPL FIXTURE'I — TEK KAYNAK.
//
// Tüm renderer testleri (snapshot, landmark, DataMatrix, şablon seçimi) BU
// dosyadaki şablonu kullanır; üç ayrı yerde kopya ZPL tutulmaz.
//
// GİZLİLİK: burada GERÇEK müşteri verisi, gerçek adres/telefon, gerçek
// sipariş numarası veya gerçek provider ZPL'i YOKTUR. Tüm değerler
// "ORNEK…", "0120…", "1000…" önekli sentetik değerlerdir ve hiçbir harici
// servise (Labelary dâhil) gönderilmez.
//
// ŞABLON GERÇEKÇİLİĞİ: resmî etikette bölümler ^GB ile çizilen YATAY ve
// DİKEY çizgilerle ayrılır. Önceki fixture yalnız dış çerçeveyi içeriyordu,
// bu yüzden "eksik çizgi" hatası testlerde HİÇ görünmüyordu. Bu şablon
// bilerek şunları içerir:
//   - dış kutu            ^GB760,770,3
//   - dikey çizgiler      ^GB0,h,t        (sıfır GENİŞLİK)
//   - yatay çizgiler      ^GBw,0,t        (sıfır YÜKSEKLİK)
//   - ^FT taban çizgisi ve ^FO sol-üst köşe alanları KARIŞIK
//   - ^FB sarma + sağa hizalama
//   - ^A0B ile dikey sipariş numarası rayı
//   - ^BC / ^BX / ^BQ

/** Etiket ölçüsü (203 dpi, 100 × 100 mm). */
export const FIXTURE_PRINT_WIDTH = 799
export const FIXTURE_LABEL_LENGTH = 799

/** Şablonun sabit bölüm çizgileri (dot) — landmark testleri buna dayanır. */
export const FIXTURE_LAYOUT = {
  frame: { x: 20, y: 15, width: 760, height: 770, thickness: 3 },
  railLine: { x: 65, y: 15, height: 770, thickness: 2 },
  sectionLines: [110, 275, 455, 545, 700],
  sectionLineThickness: 2,
  senderBranchBaseline: { x: 75, y: 45, height: 22 },
  senderNameBaseline: { x: 75, y: 75, height: 30 },
  trackingBaseline: { x: 470, y: 45, height: 20 },
  barcode: { x: 80, y: 125, height: 110, module: 3 },
  recipientBaseline: { x: 75, y: 305, height: 26 },
  addressOrigin: { x: 75, y: 315, height: 18, blockWidth: 690, lines: 3, lineGap: 2 },
  dataMatrix: { x: 80, y: 560, module: 5 },
  qr: { x: 660, y: 565, magnification: 4 },
  routeBaseline: { x: 300, y: 635, height: 34 },
  transferBaseline: { x: 300, y: 675, height: 30 },
  verticalOrderBaseline: { x: 45, y: 760, height: 18 },
  productFooterBaseline: { x: 75, y: 730, height: 18 },
}

/** Sentetik (maskelenmiş) alan değerleri. */
export const FIXTURE_DATA = {
  branch: 'ORNEK',
  sender: 'ORNEK GONDERICI',
  orderNumber: '1000000000000001',
  trackingNumber: '10000000000001',
  barcode: '01200000001',
  recipient: 'SENTETIK ALICI',
  address: 'ORNEK MAHALLESI ORNEK CADDESI NUMARA 12 DAIRE 3 ORNEK ILCE',
  phone: 'TEL: 555*****01',
  region: 'ORNEKSEHIR / ORNEKILCE',
  route: 'ORNEKSEHIR/01',
  transfer: 'ORNEKSEHIR AKTARMA',
  product: '1 x Ornek Elbise (Renk: Siyah, Beden: 42) [ORN-001]',
}

/**
 * Sentetik resmî Sürat ZPL'i üretir. Seçenekler YALNIZ test senaryosunu
 * değiştirir; koordinatlar FIXTURE_LAYOUT'tan gelir ve alan adına göre elle
 * yeniden kurulmaz.
 */
export function buildSyntheticSuratZpl(options = {}) {
  const {
    recipient = FIXTURE_DATA.recipient,
    address = FIXTURE_DATA.address,
    route = FIXTURE_DATA.route,
    transfer = FIXTURE_DATA.transfer,
    product = FIXTURE_DATA.product,
    barcodeModule = FIXTURE_LAYOUT.barcode.module,
    includeCode128 = true,
    includeDataMatrix = true,
    includeQr = true,
    includeSectionLines = true,
    dataMatrixQuality = 200,
    // GERÇEKÇİ VARSAYILAN: Sürat'in resmî ZPL'inde ürün satırı YOKTUR —
    // o satırı CargoFlow augmentation'ı final ^PQ öncesine ekler. Fixture
    // ürün satırını içerseydi footer alanı dolu olur ve augmentation
    // sürekli overflow'a düşerdi.
    includeProductFooter = false,
  } = options
  const L = FIXTURE_LAYOUT
  const lines = [
    '^XA',
    '^CI28',
    `^PW${FIXTURE_PRINT_WIDTH}`,
    `^LL0${FIXTURE_LABEL_LENGTH}`,
    '^LS0',
    // Dış çerçeve (kutu).
    `^FO${L.frame.x},${L.frame.y}^GB${L.frame.width},${L.frame.height},${L.frame.thickness}^FS`,
    // Dikey ray çizgisi: SIFIR GENİŞLİK.
    `^FO${L.railLine.x},${L.railLine.y}^GB0,${L.railLine.height},${L.railLine.thickness}^FS`,
  ]
  if (includeSectionLines) {
    for (const y of L.sectionLines) {
      // Yatay bölüm ayırıcı: SIFIR YÜKSEKLİK.
      lines.push(`^FO20,${y}^GB760,0,${L.sectionLineThickness}^FS`)
    }
  }
  lines.push(
    `^FT${L.senderBranchBaseline.x},${L.senderBranchBaseline.y}^A0N,${L.senderBranchBaseline.height},${L.senderBranchBaseline.height}^FDSube: ${FIXTURE_DATA.branch}^FS`,
    `^FT${L.senderNameBaseline.x},${L.senderNameBaseline.y}^A0N,${L.senderNameBaseline.height},${L.senderNameBaseline.height}^FD${FIXTURE_DATA.sender}^FS`,
    `^FT75,100^A0N,18,18^FDMUST.IRS.NO: ${FIXTURE_DATA.orderNumber}^FS`,
    `^FT${L.trackingBaseline.x},${L.trackingBaseline.y}^A0N,${L.trackingBaseline.height},${L.trackingBaseline.height}^FDT.No: ${FIXTURE_DATA.trackingNumber}^FS`,
  )
  if (includeCode128) {
    lines.push(
      `^FO${L.barcode.x},${L.barcode.y}^BY${barcodeModule}^BCN,${L.barcode.height},Y,N,N^FD${FIXTURE_DATA.barcode}^FS`,
    )
  }
  lines.push(
    `^FT${L.recipientBaseline.x},${L.recipientBaseline.y}^A0N,${L.recipientBaseline.height},${L.recipientBaseline.height}^FD${recipient}^FS`,
    `^FO${L.addressOrigin.x},${L.addressOrigin.y}^A0N,${L.addressOrigin.height},${L.addressOrigin.height}` +
      `^FB${L.addressOrigin.blockWidth},${L.addressOrigin.lines},${L.addressOrigin.lineGap},L^FD${address}^FS`,
    `^FT75,445^A0N,18,18^FD${FIXTURE_DATA.phone}^FS`,
    // Sağa hizalı blok (^FB ... ,R).
    `^FO400,427^A0N,20,20^FB365,1,0,R^FD${FIXTURE_DATA.region}^FS`,
    '^FT75,500^A0N,16,16^FDOdemeTipi^FS',
    '^FT250,500^A0N,16,16^FDBirim^FS',
    '^FT430,500^A0N,16,16^FDTop Ds/Kg^FS',
    '^FT75,535^A0N,30,30^FDPOCH^FS',
    '^FT250,535^A0N,30,30^FDKOLI^FS',
    '^FT430,535^A0N,30,30^FD2,00^FS',
  )
  if (includeDataMatrix) {
    lines.push(
      `^FO${L.dataMatrix.x},${L.dataMatrix.y}^BXN,${L.dataMatrix.module},${dataMatrixQuality}^FD${FIXTURE_DATA.orderNumber}^FS`,
    )
  }
  lines.push(
    '^FT300,600^A0N,20,20^FDParca Adedi 1 / 1^FS',
    `^FT${L.routeBaseline.x},${L.routeBaseline.y}^A0N,${L.routeBaseline.height},${L.routeBaseline.height}^FD${route}^FS`,
    `^FT${L.transferBaseline.x},${L.transferBaseline.y}^A0N,${L.transferBaseline.height},${L.transferBaseline.height}^FD${transfer}^FS`,
  )
  if (includeQr) {
    lines.push(
      `^FO${L.qr.x},${L.qr.y}^BQN,2,${L.qr.magnification}^FDLA,${FIXTURE_DATA.barcode}^FS`,
    )
  }
  lines.push(
    // Dikey sipariş rayı: ^FW varsayılanı + AÇIK ^A0B yönü.
    '^FWB',
    `^FT${L.verticalOrderBaseline.x},${L.verticalOrderBaseline.y}^A0B,${L.verticalOrderBaseline.height},${L.verticalOrderBaseline.height}^FDSiparis No: ${FIXTURE_DATA.orderNumber}^FS`,
    '^FWN',
  )
  if (includeProductFooter) {
    lines.push(
      `^FT${L.productFooterBaseline.x},${L.productFooterBaseline.y}^A0N,${L.productFooterBaseline.height},${L.productFooterBaseline.height}^FD${product}^FS`,
    )
  }
  lines.push('^PQ1,0,1,Y', '^XZ')
  return lines.join('\n')
}

/** Testlerde tekrar tekrar kurulan sentetik sipariş. */
export function buildSyntheticSuratOrder(over = {}) {
  const zpl = over.barcodeRaw ?? buildSyntheticSuratZpl()
  const base = {
    id: 'snap-1',
    marketplace: 'Trendyol',
    orderNumber: FIXTURE_DATA.orderNumber,
    packageId: 'PKG-SNAP-1',
    customerName: FIXTURE_DATA.recipient,
    address: 'ORNEK MAH ORNEK SOK NO 1',
    city: 'ORNEKSEHIR',
    district: 'ORNEKILCE',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    hasPrintableLabel: true,
    desi: 2,
    desiSource: 'manual_total',
    items: [
      {
        id: 'snap-l-1',
        productName: 'Ornek Elbise',
        quantity: 1,
        color: 'Siyah',
        size: '42',
        merchantSku: 'ORN-001',
      },
    ],
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: FIXTURE_DATA.trackingNumber,
      tNo: FIXTURE_DATA.trackingNumber,
      barcode: FIXTURE_DATA.barcode,
      barkodNo: FIXTURE_DATA.barcode,
      barcodeValue: FIXTURE_DATA.barcode,
      ozelKargoTakipNo: FIXTURE_DATA.orderNumber,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true,
      printEnabled: true,
      barcodeRaw: zpl,
      desi: 2,
    },
  }
  const { barcodeRaw, shipment, ...rest } = over
  void barcodeRaw
  return {
    ...base,
    ...rest,
    shipment: { ...base.shipment, ...(shipment ?? {}) },
  }
}
