// ARKA PLAN ETİKET HAZIRLAMA — POLİTİKA VE DURUM MAKİNESİ (SAF).
//
// ═══ NEDEN BU KADAR TEMKİNLİ ═════════════════════════════════════════════
//
// Taşıyıcı etiketi GERİ ALINAMAZ ve FATURALANABİLİR bir işlemdir. Otomatik
// üretim, "her satır için çalıştır" olarak kurulursa tek bir hatalı koşu
// yüzlerce gerçek gönderi yaratır. Bu yüzden:
//
//   · kiracı bazlı açık onay ZORUNLU (varsayılan KAPALI),
//   · uygunluk GERÇEK create kapısının AYNISI,
//   · ağ sınırı geçildikten sonra OTOMATİK ikinci create YOK,
//   · eşzamanlılık SINIRLI.
//
// AĞ YOK · DB YOK · TAŞIYICI YOK. Bu modül yalnız KARAR verir.

/** Varsayılan KAPALI. Mevcut hiçbir kiracı sessizce etkinleşmez. */
export const AUTO_LABEL_DEFAULT_ENABLED = false

/** Merkezî eşzamanlılık sınırları — kod tabanına dağıtılmaz. */
export const AUTO_LABEL_CONCURRENCY = {
  perCarrier: 2,
  perTenant: 2,
  global: 4,
} as const

export const AUTO_LABEL_JOB_STATES = [
  'QUEUED',
  'PREPARING',
  'READY',
  'BLOCKED',
  'FAILED_SAFE_TO_RETRY',
  // Ağ sınırı GEÇİLDİ, sonuç BİLİNMİYOR. Otomatik create ASLA.
  'UNKNOWN_AFTER_NETWORK',
] as const

export type AutoLabelJobState = (typeof AUTO_LABEL_JOB_STATES)[number]

export const AUTO_LABEL_BLOCK_REASONS = [
  'AUTO_LABEL_DISABLED',
  'MARKETPLACE_NOT_ENABLED',
  'CARRIER_NOT_ENABLED',
  'NOT_ELIGIBLE',
  'BILLING_UNRESOLVED',
  'CREDENTIAL_UNRESOLVED',
  'LABEL_ALREADY_PRESENT',
  'CARRIER_ARTIFACT_PRESENT',
  'PREVIOUS_NETWORK_CROSSED',
  // Aktivasyon sınırından ÖNCE görülmüş paket — geçmiş yığın otomatik
  // etiketlenmez.
  'BEFORE_ACTIVATION_BOUNDARY',
] as const

export type AutoLabelBlockReason = (typeof AUTO_LABEL_BLOCK_REASONS)[number]

export interface AutoLabelScope {
  organizationId: string
  marketplace: string
  carrier: string
}

/** Kiracı ayarı (`organization_settings.settings_json`) — şema göçü GEREKMEZ. */
export interface AutoLabelSettings {
  enabled?: boolean
  marketplaces?: string[]
  carriers?: string[]
  /**
   * ═══ AKTİVASYON SINIRI ═══════════════════════════════════════════════
   *
   * Otomatik etiketin AÇILDIĞI an (ISO). YALNIZ bu andan SONRA ilk kez
   * görülen paketler otomatik sıraya girer.
   *
   * NEDEN ZORUNLU: bayrak açıldığında kiracının açık sekmesinde binlerce
   * uygun geçmiş paket bekliyor olabilir. Sınır olmasaydı tek bir ayar
   * değişikliği binlerce GERİ ALINAMAZ ve FATURALANABİLİR Sürat etiketi
   * üretirdi. Sınır yoksa politika hiçbir paketi kabul etmez (fail-safe).
   */
  activatedAt?: string
}

/**
 * Aktivasyon sınırını ms olarak çözer.
 *
 * FAIL-SAFE: sınır yoksa veya okunamıyorsa `null` döner ve hiçbir paket
 * otomatik sıraya girmez. "Sınır tanımsız" ASLA "sınırsız" demek değildir.
 */
export function resolveActivationBoundary(
  settings?: AutoLabelSettings | null,
): number | null {
  const raw = String(settings?.activatedAt ?? '').trim()
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

const norm = (value: unknown): string =>
  String(value ?? '').trim().toLocaleLowerCase('tr-TR')

/**
 * İş anahtarı — MÜKERRER İŞİ İMKÂNSIZ KILAR.
 *
 * Webhook ve stream mutabakatı AYNI paketi bulabilir; ikisi de sıraya
 * girmeye çalışır. Anahtar aynı olduğu için DB tekilliği tek işe indirger.
 */
export function autoLabelJobKey(params: {
  organizationId: string
  marketplace: string
  carrier: string
  packageId: string
  operation?: string
}): string {
  return [
    norm(params.organizationId), norm(params.marketplace), norm(params.carrier),
    String(params.packageId ?? '').trim(),
    norm(params.operation ?? 'LABEL_PREPARE'),
  ].join(':')
}

/** Kiracı bu pazaryeri+taşıyıcı için otomatik etiketi AÇTI mı? */
export function isAutoLabelEnabledForScope(params: {
  settings?: AutoLabelSettings | null
  scope: AutoLabelScope
}): { enabled: boolean; reason: AutoLabelBlockReason | null } {
  const settings = params.settings ?? null
  if (!settings || settings.enabled !== true) {
    return { enabled: false, reason: 'AUTO_LABEL_DISABLED' }
  }
  const marketplaces = (settings.marketplaces ?? []).map(norm)
  if (marketplaces.length > 0 && !marketplaces.includes(norm(params.scope.marketplace))) {
    return { enabled: false, reason: 'MARKETPLACE_NOT_ENABLED' }
  }
  const carriers = (settings.carriers ?? []).map(norm)
  if (carriers.length > 0 && !carriers.includes(norm(params.scope.carrier))) {
    return { enabled: false, reason: 'CARRIER_NOT_ENABLED' }
  }
  return { enabled: true, reason: null }
}

export interface AutoLabelEnqueueDecision {
  enqueue: boolean
  jobKey: string
  blockReason: AutoLabelBlockReason | null
  reason: string
}

/**
 * Sıraya alınsın mı?
 *
 * Uygunluk BURADA YENİDEN TANIMLANMAZ: çağıran, GERÇEK create kapısının
 * (`resolveSuratCreateEligibility`) sonucunu geçirir. İkinci bir uygunluk
 * kopyası, elle create ile arka planın ayrışması demektir.
 */
export function resolveAutoLabelEnqueue(params: {
  scope: AutoLabelScope
  packageId: string
  settings?: AutoLabelSettings | null
  /** Gerçek create kapısının sonucu. */
  eligibility: { eligible: boolean; reasons?: string[] }
  billingResolved: boolean
  credentialResolved: boolean
  hasLabelArtifact: boolean
  hasCarrierArtifact: boolean
  /** Önceki denemede ağ sınırı geçildi mi? (Trace V2 kanıtı) */
  previousNetworkCrossed: boolean
  /**
   * Paketin YEREL olarak İLK GÖRÜLDÜĞÜ an (ms). Aktivasyon sınırıyla
   * karşılaştırılır; bilinmiyorsa paket otomatik sıraya GİRMEZ.
   */
  firstSeenAtMs?: number
  /**
   * YALNIZ tek seferlik yakalama (catch-up) için. Normal üretici bunu
   * ASLA vermez; verilirse aktivasyon sınırı ATLANIR ama diğer hiçbir
   * kapı gevşemez.
   */
  skipActivationBoundary?: boolean
}): AutoLabelEnqueueDecision {
  const jobKey = autoLabelJobKey({ ...params.scope, packageId: params.packageId })
  const block = (
    blockReason: AutoLabelBlockReason, reason: string,
  ): AutoLabelEnqueueDecision => ({ enqueue: false, jobKey, blockReason, reason })

  const gate = isAutoLabelEnabledForScope({
    settings: params.settings, scope: params.scope,
  })
  if (!gate.enabled) {
    return block(gate.reason ?? 'AUTO_LABEL_DISABLED', 'Kiracı kapsamı kapalı.')
  }
  // ═══ AKTİVASYON SINIRI — GEÇMİŞ YIĞIN OTOMATİK ETİKETLENMEZ ═════════
  //
  // Paket, otomatik etiket AÇILMADAN ÖNCE görüldüyse otomatik sıraya
  // GİRMEZ. Operatör onu elle etiketleyebilir; karar insanındır.
  //
  // TEK İSTİSNA: açıkça çalıştırılan TEK SEFERLİK yakalama işlemi
  // (`skipActivationBoundary`). Bu bayrak YALNIZ `autoLabelCatchup`
  // tarafından ve YALNIZ operatörün elle verdiği komutla set edilir;
  // normal üretici onu ASLA geçmez (POLICY-CATCHUP-1 bunu kilitler).
  // Diğer TÜM kapılar (etiket/artefakt/ağ/uygunluk/faturalama/kimlik)
  // yakalama yolunda da AYNEN uygulanır.
  if (params.skipActivationBoundary !== true) {
    const boundary = resolveActivationBoundary(params.settings)
    if (boundary === null) {
      return block(
        'BEFORE_ACTIVATION_BOUNDARY',
        'Aktivasyon sınırı yok; geçmiş yığın otomatik etiketlenmez.',
      )
    }
    const firstSeen = Number(params.firstSeenAtMs)
    if (!Number.isFinite(firstSeen) || firstSeen < boundary) {
      return block(
        'BEFORE_ACTIVATION_BOUNDARY',
        'Paket aktivasyon sınırından önce görülmüş.',
      )
    }
  }
  // Zaten etiket varsa taşıyıcıya GİDİLMEZ.
  if (params.hasLabelArtifact) {
    return block('LABEL_ALREADY_PRESENT', 'Etiket zaten mevcut.')
  }
  if (params.hasCarrierArtifact) {
    return block('CARRIER_ARTIFACT_PRESENT', 'Taşıyıcı artefaktı mevcut.')
  }
  // Ağ geçilmiş ve sonuç belirsizse OTOMATİK create YOK.
  if (params.previousNetworkCrossed) {
    return block(
      'PREVIOUS_NETWORK_CROSSED',
      'Önceki denemede ağ sınırı geçildi; salt-okunur mutabakat gerekir.',
    )
  }
  if (!params.eligibility?.eligible) {
    return block(
      'NOT_ELIGIBLE',
      `Uygun değil: ${(params.eligibility?.reasons ?? []).join(', ') || 'bilinmiyor'}`,
    )
  }
  // BELİRSİZLİK create AÇMAZ.
  if (!params.billingResolved) {
    return block('BILLING_UNRESOLVED', 'Faturalama tarafı çözülemedi.')
  }
  if (!params.credentialResolved) {
    return block('CREDENTIAL_UNRESOLVED', 'Kimlik rolü çözülemedi.')
  }
  return { enqueue: true, jobKey, blockReason: null, reason: 'Uygun.' }
}

/**
 * İş sonucundan yeni durum.
 *
 * `networkCrossed && !labelReady` → `UNKNOWN_AFTER_NETWORK`. Bu durumdan
 * otomatik çıkış YOKTUR; yalnız salt-okunur mutabakat çözer.
 */
/**
 * AGDAN ONCEKI DETERMINISTIK ENGELLER.
 *
 * Bu kodlar "ayni veri + ayni yapilandirma → ayni sonuc" anlamina gelir.
 * Otomatik tekrar denemek SONSUZ bir dongudur: her worker turunda
 * `attempt_count` artar, hicbir sey degismez ve taşıyıcıya da gidilmez.
 *
 * URETIMDE GORULDU (paket 4110109345): desi eksikligi `FAILED_SAFE_TO_RETRY`
 * olarak yaziliyor ve is her turda yeniden talep ediliyordu.
 *
 * Bu yuzden BLOKE edilirler ve ancak bir BAGIMLILIK degistiginde
 * (kiracı ayarı/paket verisi) yeniden etkinlestirilirler.
 */
export const DETERMINISTIC_PRE_NETWORK_BLOCKERS: readonly string[] = [
  'SURAT_PREFLIGHT_DESI_MISSING',
  'SURAT_CREDENTIAL_CONFIG_INVALID',
  'SURAT_PREFLIGHT_FAILED',
  'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
  // Trendyol paket statusu uygun degil: create handler taşıyıcıya
  // CIKMADAN reddeder. Statu degismeden tekrar denemek AYNI reddi uretir;
  // sonsuz `attempt_count` artisi olur. Statu degistiginde is
  // `reactivateBlockedLabelJobs` ile ACIKCA canlandirilir.
  'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  // Pazaryeri Picking guncellemesi basarisiz: Surat'a CIKILMADI.
  'TRENDYOL_PICKING_UPDATE_FAILED',
]

export function isDeterministicPreNetworkBlocker(code: unknown): boolean {
  return DETERMINISTIC_PRE_NETWORK_BLOCKERS.includes(String(code ?? ''))
}

export function resolveAutoLabelJobState(params: {
  networkCrossed: boolean
  labelReady: boolean
  blocked?: boolean
  /** Ağdan önceki ret kodu — deterministik engelleri bloke etmek için. */
  errorCode?: string | null
}): { state: AutoLabelJobState; retryAllowed: boolean } {
  if (params.blocked) return { state: 'BLOCKED', retryAllowed: false }
  if (params.labelReady) return { state: 'READY', retryAllowed: false }
  // Ağa çıkılmadı VE sebep deterministik: tekrar denemek anlamsızdır.
  if (!params.networkCrossed && isDeterministicPreNetworkBlocker(params.errorCode)) {
    return { state: 'BLOCKED', retryAllowed: false }
  }
  if (params.networkCrossed) {
    // Taşıyıcı durumu değişmiş OLABİLİR: ikinci create MÜKERRER gönderidir.
    return { state: 'UNKNOWN_AFTER_NETWORK', retryAllowed: false }
  }
  // Ağa hiç çıkılmadı: taşıyıcı durumu değişmedi, güvenle tekrar denenebilir.
  return { state: 'FAILED_SAFE_TO_RETRY', retryAllowed: true }
}

export const LABEL_BUTTON_ACTIONS = [
  'OPEN_STORED_LABEL',
  'SHOW_PREPARING',
  'MANUAL_CREATE',
  'REQUIRES_RECONCILIATION',
  'SHOW_BLOCKED',
] as const

export type LabelButtonAction = (typeof LABEL_BUTTON_ACTIONS)[number]

/**
 * Butonun ne yapacağı — ve taşıyıcıya gidip gitmeyeceği.
 *
 * Etiket HAZIRSA taşıyıcı çağrısı SIFIRDIR: buton tıklaması mükerrer create
 * fırsatı DEĞİLDİR.
 */
export function resolveLabelButtonAction(params: {
  jobState?: AutoLabelJobState | null
  hasStoredLabel: boolean
  eligible: boolean
}): { action: LabelButtonAction; carrierCalls: 0 | 1 } {
  if (params.hasStoredLabel || params.jobState === 'READY') {
    return { action: 'OPEN_STORED_LABEL', carrierCalls: 0 }
  }
  if (params.jobState === 'UNKNOWN_AFTER_NETWORK') {
    return { action: 'REQUIRES_RECONCILIATION', carrierCalls: 0 }
  }
  if (params.jobState === 'QUEUED' || params.jobState === 'PREPARING') {
    return { action: 'SHOW_PREPARING', carrierCalls: 0 }
  }
  if (params.jobState === 'BLOCKED') {
    return { action: 'SHOW_BLOCKED', carrierCalls: 0 }
  }
  if (params.eligible) return { action: 'MANUAL_CREATE', carrierCalls: 1 }
  return { action: 'SHOW_BLOCKED', carrierCalls: 0 }
}

/** Sıralı partileri sınırlı eşzamanlılıkla böler — `Promise.all(binlerce)` YOK. */
export function planAutoLabelBatches<T>(
  items: T[], limit = AUTO_LABEL_CONCURRENCY.perTenant,
): T[][] {
  const size = Math.max(1, Math.min(Number(limit) || 1, AUTO_LABEL_CONCURRENCY.global))
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}
