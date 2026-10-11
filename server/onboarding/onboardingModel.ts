// İLK KURULUM (ONBOARDING) — TEK KANONİK TAMAMLANMA DEĞERLENDİRİCİSİ.
//
// ═══ ÖLÇÜLEN KUSURLAR (YAMADAN ÖNCE YENİDEN ÜRETİLDİ) ════════════════════
//
//   R1  Üretim yolu HESAP KAPSAMLI senkron satırı yazar (`marketplaceAccountId`
//       dolu); eski durum okuyucusu YALNIZ hesapsız (NULL) satırları okuyordu.
//       Sonuç: ilk sipariş senkronu MEŞRU olarak SIFIR satır dönen yeni bir
//       organizasyon kurulumu HİÇ tamamlayamıyordu.
//   R2  `suratConnectionVerified = suratConfigured` — kimlik VARLIĞI
//       "doğrulandı" diye etiketleniyordu.
//   R3  Başarılı senkrondan sonra alınan `running` kilidi, ilk-senkron adımını
//       geri `false`a çeviriyordu (statü anlık okunuyordu).
//   R4  Organizasyon geneli satır SAYISI (`count > 0`) kanıt sayılıyordu: PASİF
//       bir kardeş hesabın tek sipariş satırı, senkron kaydı OLMADAN kurulumu
//       tamamlanabilir kılıyordu.
//   R5  Tamamlanma kuralı tek bir pazaryeri ADINA bağlıydı (`trendyolConfigured`).
//
// ═══ MODEL ════════════════════════════════════════════════════════════════
//
// Bu dosya SAFTIR: DB/ağ YOK. Girdi, yükleyicinin (`onboardingService.ts`)
// kabul edilmiş kaynaklardan topladığı anlık görüntüdür:
//
//   · sağlayıcı uygunluğu → sağlayıcı kataloğu + yayın aşaması politikası
//     (`capabilityIsLive`, `stageAffectsLiveBehavior` — İKİNCİ YORUM YOK)
//   · bağlantı/kimlik/senkron gerçeği → Entegrasyon Sağlığı (TÜKETİLİR,
//     KOPYALANMAZ)
//   · hesap kimliği → `marketplace_accounts`
//
// Onboarding şu soruyu yanıtlar: "Bu organizasyon ilk kurulumun asgarisini
// tamamladı mı?" Bağlantının SÜREGELEN sağlığı Entegrasyon Sağlığı'nındır.
import {
  capabilityIsLive,
  stageAffectsLiveBehavior,
  type CapabilityStage,
  type ConnectorCapability,
  type ConnectorDescriptor,
  type ConnectorRegistry,
  type ProviderKind,
} from '../connectors/connectorKernel.ts'
import type { IntegrationHealth } from '../connectors/integrationHealth.ts'
import {
  resolveCarrierAccountFromRecords,
  type CarrierAccountRecord,
  type CarrierMappingRecord,
  type CarrierResolutionSource,
} from '../carriers/carrierResolution.ts'

/**
 * Siparişinde doğrulanmış ödeyen sinyali taşıyan pazaryerleri. KAYNAK:
 * `shipments/shippingBillingParty.MARKETPLACES_WITH_VERIFIED_ORDER_SIGNAL`
 * (aynı liste; burada saflık için kopyalanmaz, test eşitliği kilitler).
 */
export const PAYER_SIGNAL_MARKETPLACES: readonly string[] = ['trendyol']

/**
 * İlk senkron (bootstrap) kaynakları ve onları CANLI kılan yetenekler.
 *
 * Bir sağlayıcı yalnız CANLI olarak sunduğu kaynaklarla bootstrap edilebilir:
 * canlı `products.read` sunmayan bir sağlayıcıdan ürün senkronu İSTENMEZ.
 */
export const BOOTSTRAP_RESOURCES: ReadonlyArray<{
  resource: 'orders' | 'products'
  capability: ConnectorCapability
}> = [
  { resource: 'orders', capability: 'orders.read' },
  { resource: 'products', capability: 'products.read' },
]

export type BootstrapResource = (typeof BOOTSTRAP_RESOURCES)[number]['resource']

/**
 * ESKİ (hesapsız) senkron satırı uyumluluğu — AÇIK ve SINIRLI.
 *
 * Hesap kimliğinden ÖNCEKİ dönemde Trendyol senkronu `marketplace_account_id
 * = NULL` satırı yazıyordu. Bu satırlar YALNIZ:
 *   · burada listelenen sağlayıcı için,
 *   · organizasyonun o sağlayıcıda HİÇ hesabı YOKKEN
 * sayılır. Hesap varsa hesap gerçeği OTORİTERDİR ve eski satır HİÇBİR hesaba
 * EŞLENMEZ — kardeş hesabı doğrulayamaz.
 */
export const LEGACY_SYNC_COMPAT_PROVIDERS: readonly string[] = ['trendyol']

/**
 * İlk kurulumda operasyonel taşıyıcı. Taşıyıcı mimarisi bu biletin konusu
 * DEĞİLDİR; mevcut ürün Sürat'ı gerektirdiği için gereklilik korunur.
 */
export const ONBOARDING_CARRIER = {
  providerKey: 'surat',
  displayName: 'Sürat Kargo',
} as const

export const ONBOARDING_STEP_KEYS = [
  'WELCOME',
  // İşletme bilgileri (firma adı, telefon, adres) — `organizations` satırından.
  'BUSINESS',
  'MARKETPLACE',
  'CARRIER',
  // Satış hesabı ↔ kargo hesabı eşlemesi + ödeyen politikası çözülebilir mi.
  'OPERATIONS',
  'FIRST_SYNC',
  'READY',
] as const
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number]

/** Kararlı engel kodları — ham sağlayıcı metni TAŞIMAZ. */
export const ONBOARDING_BLOCKERS = {
  BUSINESS_PROFILE_INCOMPLETE: 'BUSINESS_PROFILE_INCOMPLETE',
  NO_ELIGIBLE_MARKETPLACE: 'NO_ELIGIBLE_MARKETPLACE',
  MARKETPLACE_NOT_CONFIGURED: 'MARKETPLACE_NOT_CONFIGURED',
  MARKETPLACE_NOT_VERIFIED: 'MARKETPLACE_NOT_VERIFIED',
  MARKETPLACE_VERIFICATION_REQUIRED: 'MARKETPLACE_VERIFICATION_REQUIRED',
  FIRST_SYNC_REQUIRED: 'FIRST_SYNC_REQUIRED',
  CARRIER_NOT_CONFIGURED: 'CARRIER_NOT_CONFIGURED',
  CARRIER_NOT_VERIFIED: 'CARRIER_NOT_VERIFIED',
  OPERATIONS_UNRESOLVED: 'OPERATIONS_UNRESOLVED',
} as const
export type OnboardingBlocker = (typeof ONBOARDING_BLOCKERS)[keyof typeof ONBOARDING_BLOCKERS]

/* ─── SAĞLAYICI UYGUNLUĞU ────────────────────────────────────────────── */

/**
 * SİPARİŞ KAYNAĞI aileleri — kurulumun "pazaryeri" adımı bunları kapsar.
 *
 * Çekirdek iki ayrı aile tanımlar: pazaryeri (Trendyol) ve kendi mağazası
 * (WooCommerce, ikas, Ticimax — `commerce_platform`). İkisi de sipariş
 * kaynağıdır; yalnız `marketplace` süzülseydi, bir mağaza altyapısı `pilot`a
 * terfi ettiğinde kurulumda ASLA görünmezdi. Taşıyıcı (`shipping`) hariçtir.
 */
export const ORDER_SOURCE_KINDS: readonly ProviderKind[] = ['marketplace', 'commerce_platform']

export interface OnboardingProviderEligibility {
  providerKey: string
  displayName: string
  rolloutStage: CapabilityStage
  eligibleForOnboarding: boolean
  /** Canlı bootstrap kaynakları (canlı olmayan kaynak İSTENMEZ). */
  bootstrapResources: BootstrapResource[]
}

export function liveBootstrapResources(descriptor: ConnectorDescriptor): BootstrapResource[] {
  return BOOTSTRAP_RESOURCES.filter((entry) =>
    capabilityIsLive(descriptor, entry.capability),
  ).map((entry) => entry.resource)
}

/**
 * Normal ilk kurulumda sunulabilecek pazaryerleri.
 *
 * İKİ KAPI birlikte geçilmelidir ve İKİSİ DE mevcut yorumdur:
 *   1) sağlayıcı yayın aşaması canlı davranışı etkileyebilir
 *      (`stageAffectsLiveBehavior`) — `internal_test`/`off` GEÇEMEZ;
 *   2) en az bir bootstrap yeteneği CANLIDIR (`capabilityIsLive`).
 *
 * Kod/sözleşme VAR olması uygunluk DEĞİLDİR.
 */
export function resolveOnboardingProviders(
  registry: ConnectorRegistry,
  resolveStage: (providerKey: string) => CapabilityStage,
): OnboardingProviderEligibility[] {
  return registry
    .list()
    .filter((descriptor) => ORDER_SOURCE_KINDS.includes(descriptor.kind))
    .map((descriptor) => {
      const rolloutStage = resolveStage(descriptor.providerKey)
      const bootstrapResources = liveBootstrapResources(descriptor)
      return {
        providerKey: descriptor.providerKey,
        displayName: descriptor.displayName,
        rolloutStage,
        eligibleForOnboarding:
          stageAffectsLiveBehavior(rolloutStage) && bootstrapResources.length > 0,
        bootstrapResources,
      }
    })
}

/* ─── ANLIK GÖRÜNTÜ (yükleyicinin topladığı gerçek) ─────────────────── */

export interface OnboardingAccountRecord {
  id: string
  /** `marketplace_accounts.marketplace` (büyük/küçük harf farklı olabilir). */
  marketplace: string
  displayName: string | null
  isActive: boolean
  /** Kalıcı kimlik doğrulaması (`marketplace_accounts.verification_status`). */
  verificationStatus?: string | null
}

export interface OnboardingSnapshot {
  completed: boolean
  completedAt: string | null
  providers: OnboardingProviderEligibility[]
  /** Kaynak başına Entegrasyon Sağlığı kayıtları (aynı loader'dan). */
  healthByResource: Partial<Record<BootstrapResource, IntegrationHealth[]>>
  accounts: OnboardingAccountRecord[]
  /** Kimliği HESAP BAZINDA tutan sağlayıcılar (sağlık servisinin beyanı). */
  accountScopedCredentialProviders: readonly string[]
  carrierConfigured: boolean
  defaultUnitDesiConfigured: boolean
  counts: { products: number; orders: number }
  /**
   * İşletme bilgileri tam mı (`isOrganizationProfileComplete`)? Alan YOKSA
   * (eski çağıran) tamamlanmamış sayılır — sessizce "tamam" varsayılmaz.
   */
  businessProfileComplete?: boolean
  /** Taşıyıcı hesapları (sır YOK) ve açık eşlemeler. */
  carrierAccounts?: readonly CarrierAccountRecord[]
  carrierMappings?: readonly CarrierMappingRecord[]
  /** Hesap düzeyinde ödeyen ayarı yapılmış pazaryeri hesapları. */
  payerConfiguredAccountIds?: readonly string[]
}

/* ─── GÜVENLİ PROJEKSİYON ────────────────────────────────────────────── */

export type OnboardingCredentialState = 'PRESENT' | 'ABSENT' | 'NOT_BOUND'

export interface OnboardingResourceSync {
  resource: BootstrapResource
  /** Entegrasyon Sağlığı senkron durumu (NEVER_RUN / RUNNING / FAILED / …). */
  state: string
  lastSuccessfulSyncAt: string | null
}

export interface OnboardingAccountView {
  marketplaceAccountId: string
  displayName: string
  isActive: boolean
  credentials: OnboardingCredentialState
  /** Sağlık bağlantı durumu (CONNECTED / DISCONNECTED / NOT_CONFIGURED). */
  connection: string
  credentialsRejected: boolean
  sync: OnboardingResourceSync[]
  bootstrapReady: boolean
  /** Kalıcı doğrulama kaydı (`verified`, `auth_failed`, …). */
  verificationStatus: string
  /** Kimliği gerçek bir kontrolle doğrulandı mı (kalıcı kayıt VEYA başarılı senkron). */
  verified: boolean
}

export interface OnboardingLegacyConnectionView {
  /** Eski satır bu organizasyon için SAYILIYOR mu? */
  counted: boolean
  reason: 'NO_ACCOUNT_FOR_PROVIDER' | 'ACCOUNT_STATE_AUTHORITATIVE'
  sync: OnboardingResourceSync[]
  bootstrapReady: boolean
}

export interface OnboardingMarketplaceView {
  providerKey: string
  displayName: string
  rolloutStage: CapabilityStage
  eligibleForOnboarding: true
  bootstrapResources: BootstrapResource[]
  configured: boolean
  credentialsRejected: boolean
  /** Kimlik doğrulanmış GERÇEK bir okuma başarılı oldu mu? */
  bootstrapReady: boolean
  /** Kimlik bilgisi gerçek bir kontrolle doğrulandı mı? */
  verified: boolean
  accounts: OnboardingAccountView[]
  legacyConnection: OnboardingLegacyConnectionView | null
}

export type CarrierVerificationState = 'NOT_CONFIGURED' | 'UNVERIFIED' | 'VERIFIED' | 'FAILED'

export interface OnboardingOperationsAccountView {
  marketplaceAccountId: string | null
  providerKey: string
  displayName: string
  carrier:
    | { ok: true; carrierAccountId: string; carrierName: string; source: CarrierResolutionSource }
    | { ok: false; code: string }
  payer: { ok: boolean; source: 'ORDER_CONTRACT' | 'ACCOUNT_CONFIG' | null }
}

export interface OnboardingStepView {
  key: OnboardingStepKey
  required: boolean
  done: boolean
}

export interface OnboardingStatus {
  /** TARİHSEL tamamlanma — OTORİTERDİR; güncel sağlıkla YENİDEN AÇILMAZ. */
  completed: boolean
  completedAt: string | null
  /** Tamamlanmamış organizasyon için sunucunun YENİDEN hesapladığı uygunluk. */
  eligibleToComplete: boolean
  blockers: OnboardingBlocker[]
  /** Sürdürülecek adım: ilk eksik ZORUNLU adım (hepsi tamamsa READY). */
  resumeStep: OnboardingStepKey
  steps: OnboardingStepView[]
  marketplaces: OnboardingMarketplaceView[]
  carrier: {
    providerKey: string
    displayName: string
    configured: boolean
    /**
     * Taşıyıcı hesabındaki KALICI doğrulama kaydından (gönderi oluşturmayan
     * gerçek kimlik kontrolü). Kimlik VARLIĞI doğrulama DEĞİLDİR.
     */
    verification: CarrierVerificationState
    lastVerifiedAt: string | null
  }
  /** Satış hesabı ↔ kargo hesabı + ödeyen politikası çözümü. */
  operations: {
    resolved: boolean
    accounts: OnboardingOperationsAccountView[]
  }
  shipmentDefaults: {
    /** Kanıtlanmış çalışma zamanı gereği ZORUNLU DEĞİL (ONB-23). */
    required: false
    defaultUnitDesiConfigured: boolean
  }
  /** Bilgi amaçlı sayılar — tamamlanma KANITI DEĞİL. */
  counts: { products: number; orders: number }
}

/* ─── DEĞERLENDİRİCİ ─────────────────────────────────────────────────── */

function toIso(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function syncFor(
  health: IntegrationHealth | undefined,
  resource: BootstrapResource,
): OnboardingResourceSync {
  return {
    resource,
    state: health?.sync ?? 'NEVER_RUN',
    // Yalnız `status === 'success'` yazımında dolar; başarısız/kısmi senkron
    // bu alanı ASLA doldurmaz ve sonradan gelen kilit/başarısızlık SİLMEZ.
    lastSuccessfulSyncAt: toIso(health?.lastSuccessfulSyncAt),
  }
}

/**
 * Tek kanonik değerlendirici. Hem durum ucu hem tamamlama ucu BUNU çağırır;
 * ikinci bir tamamlanma algoritması YOKTUR.
 */
export function evaluateOnboarding(snapshot: OnboardingSnapshot): OnboardingStatus {
  const eligible = snapshot.providers.filter((provider) => provider.eligibleForOnboarding)
  const accountScoped = new Set(
    snapshot.accountScopedCredentialProviders.map((key) => key.toLowerCase()),
  )

  const marketplaces: OnboardingMarketplaceView[] = eligible.map((provider) => {
    const key = provider.providerKey
    const entriesFor = (resource: BootstrapResource) =>
      (snapshot.healthByResource[resource] ?? []).filter((entry) => entry.providerKey === key)
    const allEntries = provider.bootstrapResources.flatMap(entriesFor)

    // SAĞLAYICI GENELİ kimlik varlığı: sağlık bunu HER bağlantısına aynen
    // uygular; `NOT_CONFIGURED` yalnız kimlik YOKKEN çıkar.
    const providerCredentialPresent = allEntries.some(
      (entry) => entry.connection !== 'NOT_CONFIGURED',
    )

    const accounts: OnboardingAccountView[] = snapshot.accounts
      .filter((account) => String(account.marketplace).toLowerCase() === key)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((account) => {
        const accountEntries = allEntries.filter(
          (entry) => entry.marketplaceAccountId === account.id,
        )
        let credentials: OnboardingCredentialState
        if (accountScoped.has(key)) {
          // Hesap kapsamlı kimlik: YALNIZ bu hesabın sağlık kaydı konuşur.
          credentials = accountEntries.some((entry) => entry.connection !== 'NOT_CONFIGURED')
            ? 'PRESENT'
            : 'ABSENT'
        } else if (!providerCredentialPresent) {
          credentials = 'ABSENT'
        } else {
          // Sağlayıcı geneli kimlik YALNIZ aktif hesaba aittir: pasif (eski
          // satıcı kimliği) hesabın geçmiş başarısı bugünkü kimliği KANITLAMAZ.
          credentials = account.isActive ? 'PRESENT' : 'NOT_BOUND'
        }
        const credentialsRejected = accountEntries.some(
          (entry) => entry.connection === 'DISCONNECTED',
        )
        const sync = provider.bootstrapResources.map((resource) =>
          syncFor(
            entriesFor(resource).find((entry) => entry.marketplaceAccountId === account.id),
            resource,
          ),
        )
        const connection = credentials !== 'PRESENT'
          ? 'NOT_CONFIGURED'
          : credentialsRejected
            ? 'DISCONNECTED'
            : 'CONNECTED'
        const bootstrapReady =
          credentials === 'PRESENT' &&
          !credentialsRejected &&
          sync.some((entry) => entry.lastSuccessfulSyncAt !== null)
        const verificationStatus = String(account.verificationStatus ?? 'unverified')
        return {
          marketplaceAccountId: account.id,
          displayName: account.displayName || provider.displayName,
          isActive: account.isActive,
          credentials,
          connection,
          credentialsRejected,
          sync,
          bootstrapReady,
          verificationStatus,
          verified:
            credentials === 'PRESENT' &&
            !credentialsRejected &&
            (bootstrapReady || verificationStatus === 'verified'),
        }
      })

    let legacyConnection: OnboardingLegacyConnectionView | null = null
    if (LEGACY_SYNC_COMPAT_PROVIDERS.includes(key)) {
      const legacyEntries = allEntries.filter((entry) => entry.connectionScope === 'legacy')
      if (legacyEntries.length > 0) {
        const counted = accounts.length === 0
        const sync = provider.bootstrapResources.map((resource) =>
          syncFor(
            entriesFor(resource).find((entry) => entry.connectionScope === 'legacy'),
            resource,
          ),
        )
        const rejected = legacyEntries.some((entry) => entry.connection === 'DISCONNECTED')
        legacyConnection = {
          counted,
          reason: counted ? 'NO_ACCOUNT_FOR_PROVIDER' : 'ACCOUNT_STATE_AUTHORITATIVE',
          sync,
          bootstrapReady:
            counted &&
            providerCredentialPresent &&
            !rejected &&
            sync.some((entry) => entry.lastSuccessfulSyncAt !== null),
        }
      }
    }

    const configured =
      accounts.some((account) => account.credentials === 'PRESENT') ||
      (accounts.length === 0 && providerCredentialPresent)
    const credentialsRejected =
      accounts.some((account) => account.credentials === 'PRESENT' && account.credentialsRejected) ||
      (accounts.length === 0 &&
        allEntries.some((entry) => entry.connection === 'DISCONNECTED'))
    const bootstrapReady =
      accounts.some((account) => account.bootstrapReady) ||
      Boolean(legacyConnection?.bootstrapReady)
    const verified =
      accounts.some((account) => account.verified) || Boolean(legacyConnection?.bootstrapReady)

    return {
      providerKey: key,
      displayName: provider.displayName,
      rolloutStage: provider.rolloutStage,
      eligibleForOnboarding: true,
      bootstrapResources: provider.bootstrapResources,
      configured,
      credentialsRejected,
      bootstrapReady,
      verified,
      accounts,
      legacyConnection,
    }
  })

  const marketplaceConfigured = marketplaces.some((entry) => entry.configured)
  const marketplaceVerified = marketplaces.some((entry) => entry.verified)
  const bootstrapReady = marketplaces.some((entry) => entry.bootstrapReady)
  const anyRejected = marketplaces.some((entry) => entry.credentialsRejected)

  // ── Taşıyıcı: KALICI doğrulama kaydı ────────────────────────────────
  const carrierAccounts = snapshot.carrierAccounts ?? []
  const carrierMappings = snapshot.carrierMappings ?? []
  const onboardingCarrierAccounts = carrierAccounts.filter(
    (account) => account.enabled && account.provider.toLowerCase() === ONBOARDING_CARRIER.providerKey,
  )
  const carrierConfigured = Boolean(snapshot.carrierConfigured) || onboardingCarrierAccounts.length > 0
  const verifiedCarrier = onboardingCarrierAccounts.find((account) => account.verificationStatus === 'verified')
  const failedCarrier = onboardingCarrierAccounts.find(
    (account) => account.verificationStatus !== 'verified' && account.verificationStatus !== 'unverified',
  )
  const carrierVerification: CarrierVerificationState = !carrierConfigured
    ? 'NOT_CONFIGURED'
    : verifiedCarrier
      ? 'VERIFIED'
      : failedCarrier
        ? 'FAILED'
        : 'UNVERIFIED'
  const carrierVerified = carrierVerification === 'VERIFIED'

  // ── Operasyon: her etkin satış hesabı için kargo hesabı + ödeyen ────
  const payerConfigured = new Set(snapshot.payerConfiguredAccountIds ?? [])
  const operationsAccounts: OnboardingOperationsAccountView[] = []
  for (const marketplace of marketplaces) {
    const live = marketplace.accounts.filter((account) => account.credentials === 'PRESENT' && account.isActive)
    const targets: Array<{ id: string | null; displayName: string }> = live.map((account) => ({
      id: account.marketplaceAccountId,
      displayName: account.displayName,
    }))
    if (targets.length === 0 && marketplace.legacyConnection?.counted && marketplace.configured) {
      targets.push({ id: null, displayName: marketplace.displayName })
    }
    for (const target of targets) {
      const resolution = resolveCarrierAccountFromRecords(carrierAccounts, carrierMappings, {
        provider: ONBOARDING_CARRIER.providerKey,
        marketplaceAccountId: target.id,
      })
      const signal = PAYER_SIGNAL_MARKETPLACES.includes(marketplace.providerKey)
      const accountConfig = target.id != null && payerConfigured.has(target.id)
      operationsAccounts.push({
        marketplaceAccountId: target.id,
        providerKey: marketplace.providerKey,
        displayName: target.displayName,
        carrier: resolution.ok
          ? {
              ok: true,
              carrierAccountId: resolution.account.id,
              carrierName: resolution.account.displayName,
              source: resolution.source,
            }
          : { ok: false, code: resolution.code },
        payer: {
          ok: signal || accountConfig,
          source: signal ? 'ORDER_CONTRACT' : accountConfig ? 'ACCOUNT_CONFIG' : null,
        },
      })
    }
  }
  const operationsResolved =
    operationsAccounts.length > 0 && operationsAccounts.every((entry) => entry.carrier.ok && entry.payer.ok)

  const businessProfileComplete = snapshot.businessProfileComplete === true

  const blockers: OnboardingBlocker[] = []
  if (!businessProfileComplete) blockers.push(ONBOARDING_BLOCKERS.BUSINESS_PROFILE_INCOMPLETE)
  if (marketplaces.length === 0) {
    blockers.push(ONBOARDING_BLOCKERS.NO_ELIGIBLE_MARKETPLACE)
  } else if (!marketplaceConfigured) {
    blockers.push(ONBOARDING_BLOCKERS.MARKETPLACE_NOT_CONFIGURED)
  } else if (!marketplaceVerified) {
    blockers.push(
      anyRejected
        ? ONBOARDING_BLOCKERS.MARKETPLACE_NOT_VERIFIED
        : ONBOARDING_BLOCKERS.MARKETPLACE_VERIFICATION_REQUIRED,
    )
  }
  if (!carrierConfigured) blockers.push(ONBOARDING_BLOCKERS.CARRIER_NOT_CONFIGURED)
  else if (!carrierVerified) blockers.push(ONBOARDING_BLOCKERS.CARRIER_NOT_VERIFIED)
  // Değerlendirilecek satış hesabı henüz yoksa (kimlik kaydı bir hesaba
  // bağlanmadan) pazaryeri engelleri zaten konuşur; gürültü ÜRETİLMEZ.
  if (
    marketplaceConfigured &&
    carrierConfigured &&
    !operationsResolved &&
    (operationsAccounts.length > 0 || marketplaceVerified)
  ) {
    blockers.push(ONBOARDING_BLOCKERS.OPERATIONS_UNRESOLVED)
  }
  if (marketplaceConfigured && !bootstrapReady && !(anyRejected && !marketplaceVerified)) {
    blockers.push(ONBOARDING_BLOCKERS.FIRST_SYNC_REQUIRED)
  }

  const steps: OnboardingStepView[] = [
    { key: 'WELCOME', required: false, done: true },
    { key: 'BUSINESS', required: true, done: businessProfileComplete },
    { key: 'MARKETPLACE', required: true, done: marketplaceVerified },
    { key: 'CARRIER', required: true, done: carrierVerified },
    { key: 'OPERATIONS', required: true, done: operationsResolved },
    { key: 'FIRST_SYNC', required: true, done: bootstrapReady },
    { key: 'READY', required: false, done: snapshot.completed },
  ]
  const required = steps.filter((step) => step.required)
  const firstIncomplete = required.find((step) => !step.done)
  // Hiçbir zorunlu adım başlamamışsa karşılama gösterilir; aksi hâlde kurulum
  // GERÇEKTEN kaldığı yerden sürer. Hepsi tamamsa Hazır adımı açılır.
  const resumeStep: OnboardingStepKey = !firstIncomplete
    ? 'READY'
    : required.every((step) => !step.done)
      ? 'WELCOME'
      : firstIncomplete.key

  return {
    completed: Boolean(snapshot.completed),
    completedAt: snapshot.completedAt,
    // İKİ KAT GÜVENCE: engel yok VE her zorunlu adım gerçekten tamam.
    eligibleToComplete: blockers.length === 0 && required.every((step) => step.done),
    blockers,
    resumeStep,
    steps,
    marketplaces,
    carrier: {
      providerKey: ONBOARDING_CARRIER.providerKey,
      displayName: ONBOARDING_CARRIER.displayName,
      configured: carrierConfigured,
      verification: carrierVerification,
      lastVerifiedAt: verifiedCarrier?.lastVerifiedAt ?? null,
    },
    operations: { resolved: operationsResolved, accounts: operationsAccounts },
    shipmentDefaults: {
      required: false,
      defaultUnitDesiConfigured: Boolean(snapshot.defaultUnitDesiConfigured),
    },
    counts: snapshot.counts,
  }
}
