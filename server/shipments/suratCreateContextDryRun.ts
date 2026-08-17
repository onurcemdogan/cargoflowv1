// SÜRAT CREATE-CONTEXT KURU ÇALIŞTIRMA — AĞSIZ, YAZMASIZ, SIRSIZ.
//
// AMAÇ: "EXPECTED_BILLING_PARTY = TRENDYOL olan gerçek bir sipariş Sürat'e
// create edilseydi TAM OLARAK hangi gövdeyle giderdi" sorusunu HİÇBİR ağ
// çağrısı yapmadan yanıtlamak.
//
// EN ÖNEMLİ KURAL — GERÇEK BUILDER: gövde burada yeniden yazılmaz. Üretimin
// kullandığı `resolveSuratMarketplaceContext` · `buildSuratCanonicalGonderiModel`
// · `buildSuratOrtakBarkodRequest` · `resolveSuratBillingParty` ·
// `resolveCanonicalTenantSuratAccount` AYNEN çağrılır. Mock gövde uydurmak
// denetimi değersiz kılardı.
//
// GİZLİLİK: `KullaniciAdi`/`Sifre` DEĞERLERİ hiçbir koşulda çıkmaz — yalnız
// çözülüp çözülmediği ve maskeli parmak izi. Alıcı adı/adres/telefon/e-posta
// da basılmaz; yalnız hangi ALAN ADLARININ dolduğu raporlanır.
import {
  resolveSuratMarketplaceContext,
  validateSuratBillingContext,
  buildSuratOrtakBarkodRequest,
  CANONICAL_GONDERI_FIELDS,
  FORBIDDEN_CANONICAL_FIELDS,
  SURAT_SERVICE_DEFAULTS,
} from './suratCanonicalGonderiModel.ts'
import {
  resolveSuratBillingParty,
  resolveCanonicalTenantSuratAccount,
  SURAT_CANONICAL_SERVICE_MODE,
  SURAT_CANONICAL_SERVICE_TYPE,
  SURAT_CANONICAL_OPERATION_NAME,
} from './suratCanonicalCreateAdapter.ts'
import {
  SURAT_CANONICAL_CREATE_PATH,
  SURAT_CANONICAL_ALLOWED_HOSTS,
} from './suratWebApiClient.ts'

const text = (value: unknown): string => String(value ?? '').trim()

/* ═══ KREDENSİYAL VARLIK PROBU — DEĞER OKUNMAZ ═════════════════════════ */

/** `hasOwnProperty` + dolu mu — DEĞER hiçbir koşulda dışarı çıkmaz. */
function filled(config: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(config, key)) return false
  return text(config[key]) !== ''
}

export interface CredentialPresence {
  primaryUsername: boolean
  primaryPassword: boolean
  sellerPaysUsername: boolean
  sellerPaysPassword: boolean
  codUsername: boolean
  codPassword: boolean
  legacyWhoPaysPresent: boolean
  legacyWhoPaysValue: string | null
  /** Türev uygulanmadan önce ham anahtarlar da doluysa raporlanır. */
  rawKullaniciAdi: boolean
  rawSifre: boolean
}

/**
 * TENANT KREDENSİYAL VARLIĞI — SIRSIZ.
 *
 * `deriveCanonicalPrimaryAccount` UYGULANMAZ: bu prob yapılandırmanın
 * OLDUĞU GİBİ hâlini gösterir. Türevin uygulanıp uygulanmadığı ayrı bir
 * sorudur ve `describeBillingWiring` tarafından yanıtlanır.
 *
 * `whoPays` bir kimlik bilgisi değil, tek haneli legacy faturalama kodudur;
 * H6'yı kapatabilmek için DEĞERİ raporlanır.
 */
export function probeCredentialPresence(
  config: Record<string, unknown> = {},
): CredentialPresence {
  const whoPaysPresent = filled(config, 'whoPays')
  return {
    primaryUsername:
      filled(config, 'canonicalPrimaryKullaniciAdi') ||
      filled(config, 'liveKullaniciAdi'),
    primaryPassword:
      filled(config, 'canonicalPrimarySifre') || filled(config, 'liveSifre'),
    sellerPaysUsername: filled(config, 'sellerPaysKullaniciAdi'),
    sellerPaysPassword: filled(config, 'sellerPaysSifre'),
    codUsername: filled(config, 'codKullaniciAdi'),
    codPassword: filled(config, 'codSifre'),
    legacyWhoPaysPresent: whoPaysPresent,
    legacyWhoPaysValue: whoPaysPresent ? text(config.whoPays) : null,
    rawKullaniciAdi: filled(config, 'kullaniciAdi'),
    rawSifre: filled(config, 'sifre'),
  }
}

/* ═══ GERÇEK RUNTIME BAĞLANTISI ════════════════════════════════════════ */

/**
 * `resolveSuratBillingParty`nin GERÇEKTEN okuduğu sipariş alanları.
 * Kaynak: suratCanonicalCreateAdapter.ts — `order.sellerPays`,
 * `order.payer`, `order.shippingPayer`, `params.cashOnDelivery`.
 *
 * DİKKAT: Trendyol'dan türetilen `expectedBillingParty` bu listede YOKTUR.
 */
export const REAL_RUNTIME_BILLING_INPUT_FIELDS = [
  'sellerPays',
  'payer',
  'shippingPayer',
] as const

export interface BillingWiring {
  /** Gerçek siparişte bulunan payer sinyalleri (yoksa boş). */
  presentInputs: string[]
  /** Beklenen taraf create seçimine bağlı mı? */
  expectedPartyWiredToCreate: boolean
  /** SELLER_PAYS sınıfı gerçek çalışma zamanında seçilebilir mi? */
  sellerPaysReachable: boolean
  sellerPaysUnreachableReason: string | null
}

/**
 * GERÇEK ÇALIŞMA ZAMANI BAĞLANTISI — kaynak-türetilmiş, simülasyonsuz.
 *
 * `expectedPartyWiredToCreate` SABİT `false`'tur ve bu bir varsayım değil,
 * ölçülebilir bir olgudur: `resolveSuratBillingParty` yalnız yukarıdaki üç
 * sipariş alanına ve COD bayrağına bakar; Trendyol `whoPays` türevine
 * HİÇBİR yerden erişmez. Bu olgu testle kilitlenir.
 *
 * `sellerPaysReachable` iki AYRI koşula bağlıdır ve ikisi de gereklidir:
 *   (1) sipariş üzerinde açık bir satıcı-öder sinyali BULUNMALI,
 *   (2) tenant'ta sellerPays kredensiyali TANIMLI olmalı.
 * Biri bile yoksa sınıf pratikte seçilemez.
 */
export function describeBillingWiring(params: {
  order: Record<string, unknown>
  credentials: CredentialPresence
}): BillingWiring {
  const presentInputs = REAL_RUNTIME_BILLING_INPUT_FIELDS.filter(
    (field) => text(params.order[field]) !== '',
  )
  const hasSignal = presentInputs.length > 0
  const hasCredential =
    params.credentials.sellerPaysUsername && params.credentials.sellerPaysPassword
  return {
    presentInputs: [...presentInputs],
    expectedPartyWiredToCreate: false,
    sellerPaysReachable: hasSignal && hasCredential,
    sellerPaysUnreachableReason: hasSignal && hasCredential
      ? null
      : !hasSignal && !hasCredential
        ? 'NO_ORDER_SIGNAL_AND_NO_CREDENTIAL'
        : !hasSignal
          ? 'NO_ORDER_SIGNAL'
          : 'NO_CREDENTIAL',
  }
}

/** Gövdede ASLA görünmemesi gereken kök alanlar (değer bazında). */
export const SECRET_REQUEST_FIELDS = ['KullaniciAdi', 'Sifre'] as const

/** Sızıntı taramasının anlamlı olduğu en kısa değer uzunluğu. */
export const SECRET_LEAK_MIN_LENGTH = 6

/**
 * Faturalama açısından anlamlı olduğu KANITLANMIŞ ya da şüpheli alanlar.
 * Değerleri operasyoneldir (PII değil), bu yüzden basılabilir.
 */
export const BILLING_RELEVANT_GONDERI_FIELDS = [
  'OzelKargoTakipNo',
  'Pazaryerimi',
  'EntegrasyonFirmasi',
  'OdemeTipi',
  'KapidanOdemeTahsilatTipi',
  'KapidanOdemeTutari',
  'Iademi',
  'ReferansNo',
] as const

export interface CreateContextSummary {
  serviceMode: string
  serviceType: string
  operationName: string
  createHost: string
  createPath: string
  /** `PRIMARY` | `SELLER_PAYS` | `CASH_ON_DELIVERY` — gerçek çözücüden. */
  credentialClass: string
  credentialResolved: boolean
  accountFingerprint: string
  /** Kök gövde alan ADLARI (değer YOK). */
  requestRootFields: string[]
  /** `Gonderi` içinde GERÇEKTEN üretilen alan adları. */
  gonderiFieldNames: string[]
  /** Sözleşmede tanımlı olup üretilmeyen alanlar (denetim şeffaflığı). */
  gonderiFieldsOmitted: string[]
  billingRelevantValues: Record<string, unknown>
  billingContextValid: boolean
  billingContextError: string | null
  marketplaceIdentityPresent: boolean
  odemeTipiPresent: boolean
  odemeTipiValue: unknown
  odemeTipiSource: string
  whoPaysPresent: boolean
  kimOderPresent: boolean
  firmaIdPresentInRequest: boolean
  restSenderIdPresentInRequest: boolean
  forbiddenFieldsPresent: string[]
  secretValuesLeaked: string[]
  /** Faturalama dışı sayısal alanların nereden geldiği (dürüstlük notu). */
  nonBillingSimulatedFields: string[]
}

export interface CreateContextInput {
  order: Record<string, unknown>
  suratConfig: Record<string, unknown>
  reference: string
  cashOnDelivery?: boolean
  /** Tenant varsayılanından gelen desi; yoksa BOŞ bırakılır (uydurulmaz). */
  birimDesi?: string
  packageCount?: number
}

/**
 * ÜRETİM GÖVDESİNİ KURU ÜRETİR.
 *
 * `buildCanonicalShipmentInput` burada KULLANILMAZ: o fonksiyon desi yoksa
 * fırlatır ve teşhis aracının üretim verisinde çökmesi kabul edilemez. Bunun
 * yerine aynı kanonik model builder'ı doğrudan beslenir ve desi/kg/adet gibi
 * FATURALAMA DIŞI alanların simüle edildiği açıkça raporlanır.
 */
export function buildCreateContextSummary(
  input: CreateContextInput,
): CreateContextSummary {
  const context = resolveSuratMarketplaceContext(input.order)
  const validation = validateSuratBillingContext(context)

  const billingParty = resolveSuratBillingParty({
    order: input.order,
    cashOnDelivery: input.cashOnDelivery,
  })
  const account = resolveCanonicalTenantSuratAccount(input.suratConfig, billingParty)

  const request = buildSuratOrtakBarkodRequest({
    credentials: {
      kullaniciAdi: account?.kullaniciAdi ?? '',
      sifre: account?.sifre ?? '',
    },
    shipment: {
      order: input.order,
      context,
      referansNo: text(
        input.order.packageId ?? input.order.shipmentPackageId ?? input.reference,
      ) || input.reference,
      adet: Math.max(1, Math.round(Number(input.packageCount ?? 1) || 1)),
      birimDesi: text(input.birimDesi),
      birimKg: text(input.birimDesi),
      kargoIcerigi: '',
    },
  })

  const gonderi = request.Gonderi as unknown as Record<string, unknown>
  const gonderiFieldNames = Object.keys(gonderi)
  const gonderiFieldsOmitted = CANONICAL_GONDERI_FIELDS.filter(
    (field) => !gonderiFieldNames.includes(field),
  )

  const billingRelevantValues: Record<string, unknown> = {}
  for (const field of BILLING_RELEVANT_GONDERI_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(gonderi, field)) {
      billingRelevantValues[field] = gonderi[field]
    }
  }

  // Yasak alan sızıntısı: kök gövdede VEYA Gonderi içinde aranır.
  const allFieldNames = [...Object.keys(request), ...gonderiFieldNames]
  const forbiddenFieldsPresent = FORBIDDEN_CANONICAL_FIELDS.filter((field) =>
    allFieldNames.includes(field),
  )

  // Sır sızıntısı denetimi: credential DEĞERİ raporlanan hiçbir alanda olmamalı.
  const reportable = JSON.stringify({
    gonderiFieldNames,
    billingRelevantValues,
    fingerprint: account?.accountFingerprint ?? '',
  })
  // ALT SINIR: çok kısa bir değer ("P" gibi) rapor metninde tesadüfen geçer
  // ("Pazaryerimi"). Uzunluk eşiği olmadan bu dedektör her çalıştırmada
  // yanlış alarm verir ve yanlış alarm veren bir dedektör okunmaz olur.
  // Gerçek Sürat kimlikleri bu eşiğin çok üzerindedir.
  const secretValuesLeaked: string[] = []
  for (const field of SECRET_REQUEST_FIELDS) {
    const value = text((request as unknown as Record<string, unknown>)[field])
    if (value.length < SECRET_LEAK_MIN_LENGTH) continue
    if (reportable.includes(value)) secretValuesLeaked.push(field)
  }

  return {
    serviceMode: SURAT_CANONICAL_SERVICE_MODE,
    serviceType: SURAT_CANONICAL_SERVICE_TYPE,
    operationName: SURAT_CANONICAL_OPERATION_NAME,
    createHost: SURAT_CANONICAL_ALLOWED_HOSTS[0],
    createPath: SURAT_CANONICAL_CREATE_PATH,
    credentialClass: billingParty,
    credentialResolved: account !== null,
    accountFingerprint: account?.accountFingerprint ?? '',
    requestRootFields: Object.keys(request),
    gonderiFieldNames,
    gonderiFieldsOmitted: [...gonderiFieldsOmitted],
    billingRelevantValues,
    billingContextValid: validation.valid,
    billingContextError: validation.errorCode ?? null,
    marketplaceIdentityPresent:
      text(gonderi.OzelKargoTakipNo) !== '' && Number(gonderi.Pazaryerimi) === 1,
    odemeTipiPresent: Object.prototype.hasOwnProperty.call(gonderi, 'OdemeTipi'),
    odemeTipiValue: gonderi.OdemeTipi,
    // KANIT: kanonik builder tenant `odemeTipi` ayarını OKUMAZ; sabit
    // `SURAT_SERVICE_DEFAULTS.OdemeTipi` yazar. Tenant ayarı YALNIZ legacy
    // SOAP zincirinde (`enrichKargoBarkoduSiparisPayload`) kullanılır.
    odemeTipiSource:
      gonderi.OdemeTipi === SURAT_SERVICE_DEFAULTS.OdemeTipi
        ? 'HARDCODED_SURAT_SERVICE_DEFAULTS'
        : 'UNEXPECTED',
    whoPaysPresent: allFieldNames.includes('WhoPays'),
    kimOderPresent: allFieldNames.includes('KimOder'),
    firmaIdPresentInRequest: allFieldNames.includes('FirmaId'),
    restSenderIdPresentInRequest: allFieldNames.some((field) =>
      field.startsWith('Gonderen'),
    ),
    forbiddenFieldsPresent: [...forbiddenFieldsPresent],
    secretValuesLeaked,
    nonBillingSimulatedFields: ['Adet', 'BirimDesi', 'BirimKg', 'KargoIcerigi'],
  }
}

export interface CreateContextComparison {
  identical: boolean
  differences: string[]
}

/**
 * İKİ SEMANTİK DURUMUN GÖVDESİNİ KARŞILAŞTIRIR.
 *
 * Karşılaştırma faturalamayla ilgili HER unsuru kapsar: credential sınıfı,
 * hesap parmak izi, alan kümesi ve faturalama değerleri. Fark yoksa create
 * bağlamı "beklenen ödeyen taraf"a KÖRDÜR.
 */
export function compareCreateContexts(
  a: CreateContextSummary,
  b: CreateContextSummary,
): CreateContextComparison {
  const differences: string[] = []
  const scalarKeys = [
    'serviceMode',
    'serviceType',
    'createHost',
    'createPath',
    'credentialClass',
    'accountFingerprint',
    'credentialResolved',
    'odemeTipiValue',
    'whoPaysPresent',
    'kimOderPresent',
    'firmaIdPresentInRequest',
    'marketplaceIdentityPresent',
  ] as const
  for (const key of scalarKeys) {
    if (a[key] !== b[key]) differences.push(`${key}: ${a[key]} != ${b[key]}`)
  }
  const fieldsA = a.gonderiFieldNames.join(',')
  const fieldsB = b.gonderiFieldNames.join(',')
  if (fieldsA !== fieldsB) differences.push('gonderiFieldNames farkli')
  const billingA = JSON.stringify(a.billingRelevantValues)
  const billingB = JSON.stringify(b.billingRelevantValues)
  if (billingA !== billingB) differences.push('billingRelevantValues farkli')
  return { identical: differences.length === 0, differences }
}

/** Rapor satırları — SIR YOK, PII YOK. */
export function formatCreateContextReport(
  summary: CreateContextSummary,
  label: string,
): string[] {
  const lines = [
    `CASE                    ${label}`,
    `SERVICE_MODE            ${summary.serviceMode}`,
    `SERVICE_TYPE            ${summary.serviceType}`,
    `CREATE_PATH             ${summary.createHost}${summary.createPath}`,
    `OPERATION               ${summary.operationName}`,
    '',
    `CREDENTIAL_CLASS        ${summary.credentialClass}`,
    `CREDENTIAL_RESOLVED     ${summary.credentialResolved ? 'YES' : 'NO'}`,
    `ACCOUNT_FINGERPRINT     ${summary.accountFingerprint || '—'}`,
    '',
    `REQUEST_ROOT_FIELDS     ${summary.requestRootFields.join(', ')}`,
    `GONDERI_FIELDS          ${summary.gonderiFieldNames.join(', ')}`,
    `GONDERI_FIELDS_OMITTED  ${summary.gonderiFieldsOmitted.join(', ') || '—'}`,
    '',
    `BILLING_CONTEXT_VALID   ${summary.billingContextValid ? 'YES' : 'NO'}`,
    `BILLING_CONTEXT_ERROR   ${summary.billingContextError ?? '—'}`,
    `MARKETPLACE_IDENTITY    ${summary.marketplaceIdentityPresent ? 'PRESENT' : 'ABSENT'}`,
  ]
  for (const [field, value] of Object.entries(summary.billingRelevantValues)) {
    lines.push(`  ${field.padEnd(26)}${String(value)}`)
  }
  lines.push(
    '',
    `ODEMETIPI_PRESENT       ${summary.odemeTipiPresent ? 'YES' : 'NO'}`,
    `ODEMETIPI_VALUE         ${String(summary.odemeTipiValue)}`,
    `ODEMETIPI_SOURCE        ${summary.odemeTipiSource}`,
    `WHO_PAYS_PRESENT        ${summary.whoPaysPresent ? 'YES' : 'NO'}`,
    `KIM_ODER_PRESENT        ${summary.kimOderPresent ? 'YES' : 'NO'}`,
    `FIRMA_ID_PRESENT        ${summary.firmaIdPresentInRequest ? 'YES' : 'NO'}`,
    `REST_SENDER_PRESENT     ${summary.restSenderIdPresentInRequest ? 'YES' : 'NO'}`,
    `FORBIDDEN_FIELDS        ${summary.forbiddenFieldsPresent.join(', ') || 'NONE'}`,
    `SECRET_LEAK             ${summary.secretValuesLeaked.join(', ') || 'NONE'}`,
    `NON_BILLING_SIMULATED   ${summary.nonBillingSimulatedFields.join(', ')}`,
  )
  return lines
}
