// KALICI AUGMENTED BASKI ZPL'İ (printZpl) — tek kaynak okuma/yazma katmanı.
//
// KAYNAK KUTSALDIR: technicalZpl (carrier payload içindeki resmî ZPL) ASLA
// üzerine yazılmaz, normalize edilmez, satır sonu değiştirilmez. Türetilmiş
// printZpl AYRI alanlarda saklanır.
//
// SAKLAMA YERİ: mevcut şifreli `shipments.carrier_payload_encrypted` sütunu
// (AES-256-GCM). YENİ KOLON veya MIGRATION GEREKMEZ.
//
// SÖZLEŞME:
//  1) Kalıcı printZpl varsa ve hash'leri geçerliyse AYNEN kullanılır —
//     metadata resolver ÇALIŞMAZ, ürün kataloğu OKUNMAZ, ZPL yeniden
//     ÜRETİLMEZ. Reprint byte-for-byte aynıdır.
//  2) Legacy kayıtta (technicalZpl var, printZpl yok) ilk kullanımda
//     compare-and-set ile YALNIZ BİR KEZ üretilip yazılır; eşzamanlı ikinci
//     istek kazananın kaydını okur.
//  3) printZplSourceSha256 !== technicalZplSha256 ise sessizce eski kayıt
//     KULLANILMAZ ve üzerine YAZILMAZ: açık hata verilir.
//
// Hata mesajları ve loglar ham ZPL veya müşteri verisi İÇERMEZ.
import { and, eq, isNull } from 'drizzle-orm'
import { shipments } from '../db/schema.ts'
import {
  decryptShipmentPayload,
  encryptShipmentPayload,
} from './shipmentEncryption.ts'
import {
  deriveAugmentedSuratZplWithHashes,
  sha256Hex,
  type AugmentationStatus as DomainAugmentationStatus,
} from '../../src/utils/augmentedSuratZpl.ts'
import type { SuratProductLineItem } from '../../src/utils/suratZplProductLine.ts'
import {
  buildProductDetailLabels,
  planProductDetailPages,
  type ProductDetailContext,
} from '../../src/utils/suratProductDetailLabel.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const PRINT_ZPL_SOURCE_MISMATCH_MESSAGE =
  'Baskı etiketi kayıtlı kaynak ZPL ile eşleşmiyor.'
export const PRINT_ZPL_SOURCE_MISSING_MESSAGE =
  'Bu gönderi için kayıtlı resmî kargo etiketi (ZPL) bulunamadı.'

export interface PersistedPrintZpl {
  printZpl: string
  printZplLength: number
  printZplSha256: string
  printZplSourceSha256: string
  printZplVersion: string
  printZplFooterProfile: string | null
  templateFingerprint: string
  printZplCreatedAt: string
  /**
   * DOMAIN augmentation sonucu (success | overflow | unsupported_template |
   * unavailable). Kalıcı artefaktta saklanır ki reprint'te ürün satırının
   * NEDEN eklenemediği yeniden augmentation ÇALIŞTIRMADAN bilinebilsin.
   * Eski kayıtlarda bulunmaz (opsiyonel).
   */
  augmentationReason?: DomainAugmentationStatus
  /**
   * Artefaktın hangi RENDER SÖZLEŞMESİYLE üretildiği. Reprint'te yeniden
   * türetme YAPILMADAN raporlanabilsin diye kalıcı tutulur.
   * Eski kayıtlarda bulunmaz → 'official_augmented' varsayılır (doğrudur:
   * composer'dan önce üretilen her artefakt augmentation-only'dir).
   */
  renderContract?: 'official_augmented' | 'durusoft_composed'
  /** Composer denendiyse sonucu (fallback sebebi dahil). */
  composeMode?: string
  /**
   * BUNDLE SÖZLEŞMESİ SÜRÜMÜ. Ürün detay sayfalarının biçimi ileride
   * değişirse eski kalıcı kayıtların nasıl okunacağı bu alanla belirlenir.
   * Taşıyıcı `printZpl` sözleşmesini ETKİLEMEZ.
   */
  bundleVersion?: number
  /**
   * EK ÜRÜN DETAY SAYFALARI — taşıyıcı etiketinden AYRI fiziksel sayfalar.
   * Eski kayıtlarda YOKTUR ve reprint'te SENTEZLENMEZ (immutable reprint).
   */
  supplementalLabels?: PersistedSupplementalLabel[]
  /** Ek sayfa durumu: yok · hazır · geometri nedeniyle üretilemedi. */
  supplementalStatus?: SupplementalStatus
  /** Minimal sunum özeti (tam ürün listesi ZPL içinde, İKİ KEZ tutulmaz). */
  productSnapshot?: { aggregatedLineCount: number; totalQuantity: number }
}

export type SupplementalStatus = 'none' | 'ready' | 'geometry_failure'

/**
 * EK SAYFA ZORUNLULUK EŞİĞİ.
 *
 * Toplanmış görüntü satırı sayısı bu değeri AŞIYORSA ürün detay sayfası
 * OPERASYONEL OLARAK ZORUNLUDUR. O durumda taşıyıcı-only bir artefaktı
 * "başarılı" saymak, depoda ürün bilgisini SESSİZCE kaybettirir.
 */
export const SUPPLEMENTAL_REQUIRED_ABOVE = 2

export const SUPPLEMENTAL_GEOMETRY_FAILURE = 'supplemental_geometry_failure'
export const SUPPLEMENTAL_VALIDATION_FAILURE = 'supplemental_validation_failure'

/**
 * BUNDLE INVARIANT — kalıcılık sınırındaki TEK merkezi kontrol.
 *
 * Kural: `aggregatedLineCount > SUPPLEMENTAL_REQUIRED_ABOVE` ise
 *   - durum 'ready' OLMALI
 *   - en az bir ek sayfa OLMALI
 *   - sayfa dizisi kendi içinde tutarlı OLMALI
 * Aksi halde artefakt GEÇERSİZDİR ve KALICI HALE GETİRİLMEZ.
 *
 * `<= eşik` durumunda ek sayfa YOKLUĞU normal ve geçerli bir başarıdır.
 */
export function verifyBundleInvariants(
  artifact: PersistedPrintZpl,
): { ok: true } | { ok: false; reason: string } {
  const lineCount = artifact.productSnapshot?.aggregatedLineCount ?? 0
  const labels = artifact.supplementalLabels ?? []
  if (lineCount > SUPPLEMENTAL_REQUIRED_ABOVE) {
    if (artifact.supplementalStatus !== 'ready') {
      return {
        ok: false,
        reason: `${lineCount} satır için ek sayfa ZORUNLU (durum: ${artifact.supplementalStatus ?? 'yok'})`,
      }
    }
    if (labels.length === 0) {
      return { ok: false, reason: `${lineCount} satır için ek sayfa YOK` }
    }
  }
  return verifySupplementalLabels(labels)
}

export const PRINT_BUNDLE_VERSION = 1

export interface PersistedSupplementalLabel {
  kind: 'product_detail'
  page: number
  totalPages: number
  zpl: string
  sha256: string
}

export type AugmentationStatus = 'augmented' | 'source_only'

export interface PrintableLabelModel extends PersistedPrintZpl {
  sourceZpl: string
  sourceZplSha256: string
  augmentationStatus: AugmentationStatus
  /** Bu çağrıda mı üretildi (legacy hydration) yoksa kayıttan mı geldi. */
  hydrated: boolean
  /** Bu turda Chrome rasterizasyonu YOK; native/indirme ZPL kullanır. */
  renderMode: 'raw-zpl'
}

// Payload içindeki resmî ZPL alan adları (persistence katmanının kullandığı
// isimler). Sıra ÖNCELİKTİR.
const SOURCE_KEYS = ['technicalZpl', 'barcodeRaw', 'BarcodeRaw']

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function pickSourceZpl(payload: Record<string, unknown>): string {
  for (const key of SOURCE_KEYS) {
    const direct = readString(payload[key])
    if (direct.trim()) return direct
  }
  const shipment = (payload.shipment ?? {}) as Record<string, unknown>
  for (const key of SOURCE_KEYS) {
    const nested = readString(shipment[key])
    if (nested.trim()) return nested
  }
  return ''
}

function readPersisted(
  payload: Record<string, unknown>,
): PersistedPrintZpl | null {
  const block = payload.printZplArtifact as Record<string, unknown> | undefined
  if (!block || typeof block !== 'object') return null
  const printZpl = readString(block.printZpl)
  if (!printZpl.trim()) return null
  return {
    printZpl,
    printZplLength: Number(block.printZplLength ?? printZpl.length),
    printZplSha256: readString(block.printZplSha256),
    printZplSourceSha256: readString(block.printZplSourceSha256),
    printZplVersion: readString(block.printZplVersion),
    printZplFooterProfile: block.printZplFooterProfile
      ? readString(block.printZplFooterProfile)
      : null,
    templateFingerprint: readString(block.templateFingerprint),
    printZplCreatedAt: readString(block.printZplCreatedAt),
    // Eski kayıtlarda YOKTUR; okunamıyorsa undefined kalır.
    ...(typeof block.augmentationReason === 'string'
      ? { augmentationReason: block.augmentationReason as DomainAugmentationStatus }
      : {}),
    ...(block.renderContract === 'durusoft_composed' ||
    block.renderContract === 'official_augmented'
      ? { renderContract: block.renderContract }
      : {}),
    ...(typeof block.composeMode === 'string'
      ? { composeMode: block.composeMode }
      : {}),
    // BUNDLE ALANLARI — eski kayıtlarda YOKTUR. Burada ASLA sentezlenmez:
    // ek sayfa üretmek YALNIZ ilk artefakt oluşturmanın işidir.
    ...(Number.isFinite(Number(block.bundleVersion))
      ? { bundleVersion: Number(block.bundleVersion) }
      : {}),
    ...(Array.isArray(block.supplementalLabels)
      ? { supplementalLabels: readSupplementalLabels(block.supplementalLabels) }
      : {}),
    ...(block.supplementalStatus === 'ready' ||
    block.supplementalStatus === 'none' ||
    block.supplementalStatus === 'geometry_failure'
      ? { supplementalStatus: block.supplementalStatus }
      : {}),
    ...(block.productSnapshot && typeof block.productSnapshot === 'object'
      ? {
          productSnapshot: {
            aggregatedLineCount: Number(
              (block.productSnapshot as Record<string, unknown>)
                .aggregatedLineCount ?? 0,
            ),
            totalQuantity: Number(
              (block.productSnapshot as Record<string, unknown>).totalQuantity ??
                0,
            ),
          },
        }
      : {}),
  }
}

/** Kalıcı ek sayfaları SIRASIYLA okur; bozuk kayıtları sessizce yutmaz. */
function readSupplementalLabels(raw: unknown[]): PersistedSupplementalLabel[] {
  const pages: PersistedSupplementalLabel[] = []
  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>
    const zpl = readString(item.zpl)
    if (item.kind !== 'product_detail' || !zpl.trim()) continue
    pages.push({
      kind: 'product_detail',
      page: Number(item.page ?? 0),
      totalPages: Number(item.totalPages ?? 0),
      zpl,
      sha256: readString(item.sha256),
    })
  }
  return pages
}

/**
 * Ek sayfa dizisinin KENDİ İÇİNDE tutarlı olduğunu doğrular.
 * Sıra dizideki konumdan okunur; DB'den gelen sıralamaya güvenilmez, dizi
 * sırası ile `page` alanı BİRBİRİNİ doğrular.
 */
export function verifySupplementalLabels(
  labels: readonly PersistedSupplementalLabel[],
): { ok: true } | { ok: false; reason: string } {
  for (const [index, label] of labels.entries()) {
    if (label.page !== index + 1) {
      return { ok: false, reason: `sayfa sırası bozuk (${label.page})` }
    }
    if (label.totalPages !== labels.length) {
      return { ok: false, reason: `toplam sayfa uyuşmuyor (${label.totalPages})` }
    }
    if (sha256Hex(label.zpl) !== label.sha256) {
      return { ok: false, reason: `sayfa ${label.page} hash uyuşmuyor` }
    }
  }
  return { ok: true }
}

/**
 * Kalıcı kaydın kendi içinde tutarlı ve KAYNAKLA bağlı olduğunu doğrular.
 * Uyuşmazlıkta sessiz kullanım veya otomatik üzerine yazma YOKTUR.
 */
export function verifyPersistedPrintZpl(
  persisted: PersistedPrintZpl,
  sourceZplSha256: string,
): { ok: true } | { ok: false; reason: string } {
  if (persisted.printZplSourceSha256 !== sourceZplSha256) {
    return { ok: false, reason: PRINT_ZPL_SOURCE_MISMATCH_MESSAGE }
  }
  if (sha256Hex(persisted.printZpl) !== persisted.printZplSha256) {
    return { ok: false, reason: PRINT_ZPL_SOURCE_MISMATCH_MESSAGE }
  }
  if (persisted.printZpl.length !== persisted.printZplLength) {
    return { ok: false, reason: PRINT_ZPL_SOURCE_MISMATCH_MESSAGE }
  }
  return { ok: true }
}

export interface ShipmentKey {
  organizationId: string
  marketplace: string
  packageId: string
  provider: string
}

async function loadRow(db: Db, key: ShipmentKey) {
  const rows = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, key.organizationId),
        eq(shipments.marketplace, key.marketplace),
        eq(shipments.packageId, key.packageId),
        eq(shipments.provider, key.provider),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

/**
 * COMPARE-AND-SET: yalnız payload'da HÂLÂ printZplArtifact YOKKEN yazar.
 * Koşul SQL tarafında değerlendirilir; eşzamanlı iki hydration'dan yalnız
 * biri yazabilir, diğeri kazananın kaydını okur.
 */
async function compareAndSetArtifact(
  db: Db,
  key: ShipmentKey,
  currentEncrypted: string | null,
  nextPayload: Record<string, unknown>,
): Promise<boolean> {
  const encrypted = encryptShipmentPayload(nextPayload)
  const result = await db
    .update(shipments)
    .set({ carrierPayloadEncrypted: encrypted, updatedAt: new Date() })
    .where(
      and(
        eq(shipments.organizationId, key.organizationId),
        eq(shipments.marketplace, key.marketplace),
        eq(shipments.packageId, key.packageId),
        eq(shipments.provider, key.provider),
        // Yalnız payload DEĞİŞMEMİŞSE yaz (optimistic compare-and-set).
        currentEncrypted == null
          ? isNull(shipments.carrierPayloadEncrypted)
          : eq(shipments.carrierPayloadEncrypted, currentEncrypted),
      ),
    )
    .returning({ id: shipments.id })
  return Array.isArray(result) ? result.length > 0 : false
}

// QR adayları payload'ın canonical konumlarından okunur. Yanlış konumdan
// okunan bir değer TEHLİKESİZDİR: resolveSuratQrPayload `727…` biçimini
// doğrulamayan her adayı reddeder ve QR üretilmez.
const QR_CANDIDATE_SCOPES = ['', 'shipment', 'order'] as const

function readCandidate(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  for (const scope of QR_CANDIDATE_SCOPES) {
    const container =
      scope === ''
        ? payload
        : ((payload[scope] ?? {}) as Record<string, unknown>)
    const value = readString(container?.[key])
    if (value.trim()) return value
  }
  return undefined
}

/** Kalıcı payload'dan DuruSoft composer girdisini çözer. */
export function resolveComposeInput(
  payload: Record<string, unknown>,
): { cargoTrackingNumber?: string; ozelKargoTakipNo?: string } {
  return {
    cargoTrackingNumber: readCandidate(payload, 'cargoTrackingNumber'),
    ozelKargoTakipNo: readCandidate(payload, 'ozelKargoTakipNo'),
  }
}

/** Ek sayfa başlığı için bağlamı KALICI payload'dan çözer. */
export function resolveProductDetailContext(
  payload: Record<string, unknown>,
): ProductDetailContext {
  return {
    orderNumber: readCandidate(payload, 'orderNumber') ?? '',
    packageId: readCandidate(payload, 'packageId') ?? '',
    recipient:
      readCandidate(payload, 'aliciAdi') ??
      readCandidate(payload, 'recipientName') ??
      readCandidate(payload, 'alici') ??
      '',
  }
}

export function buildPrintZplArtifact(
  sourceZpl: string,
  items: SuratProductLineItem[],
  createdAt: string,
  compose?: { cargoTrackingNumber?: string; ozelKargoTakipNo?: string },
  productContext?: ProductDetailContext,
): { artifact: PersistedPrintZpl; augmentationStatus: AugmentationStatus } {
  const derived = deriveAugmentedSuratZplWithHashes(
    sourceZpl,
    items,
    compose ? { compose } : {},
  )
  // ── EK ÜRÜN DETAY SAYFALARI ───────────────────────────────────────────
  // ATOMİKLİK: her şey ÖNCE bellekte üretilir ve doğrulanır; artefakt tek bir
  // JSON bloğu olarak TEK yazımda kalıcı olur. Yarım bundle YAZILAMAZ.
  // PNG YOKTUR: bu yol yalnız ZPL + hash üretir.
  const plan = planProductDetailPages(items)
  const supplementalLabels: PersistedSupplementalLabel[] =
    plan.required && plan.reason === null && productContext
      ? buildProductDetailLabels(plan, productContext).map((label) => ({
          kind: 'product_detail' as const,
          page: label.page,
          totalPages: label.totalPages,
          zpl: label.zpl,
          sha256: sha256Hex(label.zpl),
        }))
      : []
  const supplementalStatus: SupplementalStatus = !plan.required
    ? 'none'
    : supplementalLabels.length === 0
      ? 'geometry_failure'
      : 'ready'

  // ── TAŞIYICI-ONLY BAŞARI YOK ──────────────────────────────────────────
  // Eşiğin ÜSTÜNDE ek sayfa üretilemediyse bu bir BUNDLE OLUŞTURMA HATASIDIR.
  // Taşıyıcı-only artefaktı başarılı sayıp kalıcı hale getirmek, depoda ürün
  // bilgisini SESSİZCE kaybettirirdi. Açık, tipli hata verilir; hiçbir şey
  // yazılmaz. Mevcut geçerli artefakt varsa ona DOKUNULMAZ (çağıran onu
  // zaten kalıcı yoldan okur).
  if (plan.required && supplementalStatus !== 'ready') {
    throw new Error(
      `${SUPPLEMENTAL_GEOMETRY_FAILURE}: ${plan.reason ?? 'ek sayfa üretilemedi'}`,
    )
  }
  // Her toplanmış satır sayfalarda TAM OLARAK BİR KEZ temsil edilmeli.
  const blockTotal = plan.pages.reduce(
    (total, page) => total + page.blocks.length,
    0,
  )
  if (plan.required && blockTotal !== plan.aggregated.length) {
    throw new Error(
      `${SUPPLEMENTAL_VALIDATION_FAILURE}: ${blockTotal}/${plan.aggregated.length} ürün bloğu`,
    )
  }
  const verdict = verifySupplementalLabels(supplementalLabels)
  if (!verdict.ok) {
    // Kendi ürettiğimiz sayfalar tutarsızsa YARIM BUNDLE YAZILMAZ.
    throw new Error(`${SUPPLEMENTAL_VALIDATION_FAILURE}: ${verdict.reason}`)
  }
  const result: {
    artifact: PersistedPrintZpl
    augmentationStatus: AugmentationStatus
  } = {
    artifact: {
      printZpl: derived.printZpl,
      printZplLength: derived.printZplLength,
      printZplSha256: derived.printZplSha256,
      printZplSourceSha256: derived.printZplSourceSha256,
      printZplVersion: derived.printZplVersion,
      printZplFooterProfile: derived.printZplFooterProfile,
      templateFingerprint: derived.templateFingerprint,
      printZplCreatedAt: createdAt,
      augmentationReason: derived.augmentationStatus,
      bundleVersion: PRINT_BUNDLE_VERSION,
      supplementalLabels,
      supplementalStatus,
      productSnapshot: {
        aggregatedLineCount: plan.aggregated.length,
        totalQuantity: plan.quantityTotal,
      },
      renderContract: derived.renderContract,
      ...(derived.composeMode ? { composeMode: derived.composeMode } : {}),
    },
    // NOT: merkezi bundle invariant'ı aşağıda, döndürmeden ÖNCE uygulanır.
    // Kalıcılık düzeyindeki MEVCUT bayrak (augmented | source_only) korunur;
    // domain sözlüğü AYRICA `augmentationReason` ile taşınır. Paralel bir
    // durum sözlüğü OLUŞTURULMAZ: DTO domain değerlerini kullanır.
    augmentationStatus: derived.augmented ? 'augmented' : 'source_only',
  }
  const bundleVerdict = verifyBundleInvariants(result.artifact)
  if (!bundleVerdict.ok) {
    throw new Error(`${SUPPLEMENTAL_VALIDATION_FAILURE}: ${bundleVerdict.reason}`)
  }
  return result
}

export interface ResolveOptions {
  /** Ürün satırları — YALNIZ ilk üretimde (hydration) kullanılır. */
  items?: SuratProductLineItem[]
  /**
   * TEMBEL yükleyici: YALNIZ hydration gerektiğinde çağrılır. Kalıcı kayıt
   * varsa katalog ve sipariş satırları HİÇ OKUNMAZ (reprint immutability).
   */
  loadItems?: () => Promise<SuratProductLineItem[]>
  /** Zaman damgası çağıran katmandan gelir (test edilebilirlik). */
  now?: string
}

/**
 * TEK KAYNAK: önizleme, ZPL indir, native/raw baskı ve reprint bu modeli
 * kullanır. Kalıcı kayıt varsa metadata resolver ÇALIŞTIRILMAZ.
 */
export async function resolvePersistedPrintableLabel(
  db: Db,
  key: ShipmentKey,
  options: ResolveOptions,
): Promise<PrintableLabelModel> {
  const row = await loadRow(db, key)
  if (!row) throw new Error(PRINT_ZPL_SOURCE_MISSING_MESSAGE)
  const encrypted = (row.carrierPayloadEncrypted ?? null) as string | null
  const payload = (decryptShipmentPayload(encrypted) ?? {}) as Record<
    string,
    unknown
  >
  const sourceZpl = pickSourceZpl(payload)
  if (!sourceZpl.trim()) throw new Error(PRINT_ZPL_SOURCE_MISSING_MESSAGE)
  const sourceZplSha256 = sha256Hex(sourceZpl)

  // 1) Kalıcı kayıt — metadata resolver ÇALIŞMAZ.
  const persisted = readPersisted(payload)
  if (persisted) {
    const verdict = verifyPersistedPrintZpl(persisted, sourceZplSha256)
    if (!verdict.ok) throw new Error(verdict.reason)
    return {
      ...persisted,
      sourceZpl,
      sourceZplSha256,
      augmentationStatus:
        persisted.printZpl === sourceZpl ? 'source_only' : 'augmented',
      hydrated: false,
      renderMode: 'raw-zpl',
    }
  }

  // 2) Legacy hydration — YALNIZ BİR KEZ, compare-and-set ile. Ürün satırları
  //    ve katalog ANCAK BURADA yüklenir.
  const items = options.loadItems
    ? await options.loadItems()
    : (options.items ?? [])
  const { artifact, augmentationStatus } = buildPrintZplArtifact(
    sourceZpl,
    items,
    options.now ?? new Date().toISOString(),
    resolveComposeInput(payload),
    resolveProductDetailContext(payload),
  )
  const won = await compareAndSetArtifact(db, key, encrypted, {
    ...payload,
    // Kaynak alanlar AYNEN korunur; yalnız yeni blok eklenir.
    printZplArtifact: artifact,
  })
  if (won) {
    return {
      ...artifact,
      sourceZpl,
      sourceZplSha256,
      augmentationStatus,
      hydrated: true,
      renderMode: 'raw-zpl',
    }
  }

  // 3) Yarışı başkası kazandı → KAZANANIN kalıcı kaydı okunur.
  const winnerRow = await loadRow(db, key)
  const winnerPayload = (decryptShipmentPayload(
    (winnerRow?.carrierPayloadEncrypted ?? null) as string | null,
  ) ?? {}) as Record<string, unknown>
  const winner = readPersisted(winnerPayload)
  if (!winner) throw new Error(PRINT_ZPL_SOURCE_MISSING_MESSAGE)
  const verdict = verifyPersistedPrintZpl(winner, sourceZplSha256)
  if (!verdict.ok) throw new Error(verdict.reason)
  return {
    ...winner,
    sourceZpl,
    sourceZplSha256,
    augmentationStatus:
      winner.printZpl === sourceZpl ? 'source_only' : 'augmented',
    hydrated: false,
    renderMode: 'raw-zpl',
  }
}

// Yeni create akışı için: kalıcı kaydı technicalZpl ile AYNI payload yazımında
// hazırlar. Kaynak alanlara DOKUNULMAZ.
export function attachPrintZplArtifact(
  carrierPayload: Record<string, unknown>,
  items: SuratProductLineItem[],
  now: string,
): Record<string, unknown> {
  const sourceZpl = pickSourceZpl(carrierPayload)
  if (!sourceZpl.trim()) return carrierPayload
  // DuruSoft composer İLK ARTEFAKT ÜRETİMİNDE devreye girer. Compose girdisi
  // AYNI carrier payload'dan çözülür; composer uygun değilse (şablon, semantic,
  // geometri, invariant, whitelist) sessizce official_augmented'a düşer.
  const { artifact } = buildPrintZplArtifact(
    sourceZpl,
    items,
    now,
    resolveComposeInput(carrierPayload),
    resolveProductDetailContext(carrierPayload),
  )
  return { ...carrierPayload, printZplArtifact: artifact }
}

export const __testing = { pickSourceZpl, readPersisted }
