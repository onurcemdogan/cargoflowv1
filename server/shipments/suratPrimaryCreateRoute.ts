// SÜRAT — BİRİNCİL CREATE ROTASI (PAZARYERİ).
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// Kanonik REST yolu (`SURAT_CANONICAL_API`) üretimde DOĞRU kiracı, DOĞRU
// birincil kimlik ve tam parite ile çağrıldı ve yine reddedildi:
//
//   System.InvalidCastException: Unable to cast object of type 'System.String'
//   to type 'KargoBarkod'  ·  OrtakBarkodOlusturSonuc line 1836
//
// Hata taşıyıcının KENDİ sonuç kurucusundadır. Depoda TARİHSEL ve DOĞRULANMIŞ
// başarı ise SOAP yolundadır (`docs/surat-finalization/`):
//
//   serviceType=OrtakBarkodOlusturSoap · operationName=OrtakBarkodOlustur
//   responseCode=013 · BARCODE_SUCCESS · verifiedShipment=true
//
// Bu modül YENİ uygun pazaryeri gönderileri için birincil rotayı o
// doğrulanmış yola çevirir.
//
// ═══ BU BİR GERİ DÜŞÜŞ DEĞİLDİR ══════════════════════════════════════════
//
// Fonksiyon, önceki bir denemenin sonucunu GİRDİ OLARAK ALMAZ. Alamaması
// bilinçlidir: "kanonik başarısız oldu → SOAP'ı dene" akışı, taşıyıcıda
// FİZİKSEL gönderi zaten oluşmuşken ikinci bir gönderi yaratabilir. Cast
// hatası sonuç kurucusunda oluştuğu için kaydın oluşmamış olduğu
// KANITLANMAMIŞTIR.

/** Tarihsel olarak doğrulanmış SOAP create kimliği. */
export const SOAP_PRIMARY_SERVICE_MODE = 'ORTAK_BARKOD_SOAP'
export const SOAP_PRIMARY_SERVICE_TYPE = 'OrtakBarkodOlusturSoap'
export const SOAP_PRIMARY_OPERATION = 'OrtakBarkodOlustur'
export const SOAP_PRIMARY_CREATE_PATH = '/api/OrtakBarkodOlustur'

/**
 * Yalnız DOĞRULANMIŞ pazaryeri akışı.
 *
 * Depo kanıtı Trendyol içindir. Başka pazaryeri için aynı kanıt YOKTUR ve
 * bu yüzden onların modu DEĞİŞTİRİLMEZ.
 */
export const SOAP_PRIMARY_ELIGIBLE_MARKETPLACES = ['trendyol'] as const

/**
 * DEĞİŞTİRİLEN modlar — ARTIK HİÇBİRİ.
 *
 * ═══ NEDEN BOŞ ═══════════════════════════════════════════════════════════
 *
 * Bu liste `'SURAT_CANONICAL_API'` içeriyordu ve ÜRETİM REGRESYONUNUN kendisi
 * buydu. Kiracı (TarzimTuba) kayıtlı olarak `SURAT_CANONICAL_API` seçmiştir —
 * Sürat entegrasyon ekibinin bu müşteri için verdiği RESMÎ servistir
 * (api02 · POST /api/OrtakBarkodOlustur, bkz. ef944e2). Buradaki eşleşme,
 * çalışma zamanında o seçimi `ORTAK_BARKOD_SOAP` +
 * `serviceType='OrtakBarkodOlusturSoap'` olarak YENİDEN YAZIYORDU.
 *
 * Sonuçları zincirleme oldu:
 *   1. Resmî kanonik dal (`createSuratShipmentCore` içinde) HİÇ ULAŞILMAZ
 *      hâle geldi — kiracı resmî servisi seçmişken legacy servise gidiyordu.
 *   2. Yazılan `serviceType` tam olarak `labelOnlyChain` yordamını (index.mjs)
 *      tetikliyor ve legacy İKİ ÇAĞRILI zinciri (`GonderiyiKargoyaGonder` →
 *      `OrtakBarkodOlustur` SOAP) seçiyordu. Kanıtlanmış akış TEK çağrıdır.
 *   3. Sonraki tüm düzeltmeler (kayıt doğrulama kapısı, TDZ çökmesi) bu
 *      seçilmemesi gereken zincirin hasar kontrolüydü.
 *
 * Gerekçe olarak gösterilen `11415535074` artefaktı bir ETİKET kaydıdır
 * (`/api/shipments/surat/label`), CREATE kaydı DEĞİL; create sözleşmesi diye
 * okunması hatalıydı.
 *
 * Kiracının AÇIKÇA seçtiği mod hiçbir koşulda çalışma zamanında ezilmez.
 * `SOAP_PRIMARY_*` sabitleri KALIR: gerçekten `ORTAK_BARKOD_SOAP` seçmiş
 * kiracılar için SOAP otorite katmanı aynen çalışmaya devam eder.
 */
export const SOAP_PRIMARY_REPLACEABLE_MODES = [] as const

export interface SuratPrimaryCreateRoute {
  /** Bu istekte GERÇEKTEN kullanılacak mod. */
  serviceMode: string
  serviceType: string
  createShipmentPath: string
  operation: string
  /** Doğrulanmış SOAP rotası seçildi mi? */
  soapPrimarySelected: boolean
  /** Kayıtlı mod eziliyor mu? (görünürlük — sessiz değişiklik OLMAZ) */
  overrodeConfiguredMode: boolean
  configuredServiceMode: string
  reason: string
}

const normalizeMarketplace = (value: unknown): string =>
  String(value ?? '').trim().toLocaleLowerCase('tr-TR')

/**
 * Birincil rota kararı — SALT HESAP, yan etki YOK.
 *
 * Uygun DEĞİLSE kayıtlı mod AYNEN korunur: bu değişiklik ilgisiz servis
 * modlarını yeniden yazmaz.
 */
export function resolveSuratPrimaryCreateRoute(params: {
  configuredServiceMode?: unknown
  marketplace?: unknown
}): SuratPrimaryCreateRoute {
  const configuredServiceMode = String(params.configuredServiceMode ?? '').trim()
  const marketplace = normalizeMarketplace(params.marketplace)
  const marketplaceEligible =
    (SOAP_PRIMARY_ELIGIBLE_MARKETPLACES as readonly string[]).includes(marketplace)
  const modeReplaceable = (SOAP_PRIMARY_REPLACEABLE_MODES as readonly string[])
    .includes(configuredServiceMode)
  const eligible = marketplaceEligible && modeReplaceable

  if (!eligible) {
    return {
      serviceMode: configuredServiceMode,
      serviceType: '',
      createShipmentPath: '',
      operation: '',
      soapPrimarySelected: false,
      overrodeConfiguredMode: false,
      configuredServiceMode,
      reason: !marketplaceEligible
        ? (marketplace
            ? `MARKETPLACE_NOT_ELIGIBLE:${marketplace}`
            : 'MARKETPLACE_ABSENT')
        : `CONFIGURED_MODE_NOT_REPLACEABLE:${configuredServiceMode}`,
    }
  }

  return {
    serviceMode: SOAP_PRIMARY_SERVICE_MODE,
    serviceType: SOAP_PRIMARY_SERVICE_TYPE,
    createShipmentPath: SOAP_PRIMARY_CREATE_PATH,
    operation: SOAP_PRIMARY_OPERATION,
    soapPrimarySelected: true,
    overrodeConfiguredMode:
      configuredServiceMode !== '' &&
      configuredServiceMode !== SOAP_PRIMARY_SERVICE_MODE,
    configuredServiceMode,
    reason: 'VERIFIED_SOAP_PRIMARY_FOR_MARKETPLACE',
  }
}
