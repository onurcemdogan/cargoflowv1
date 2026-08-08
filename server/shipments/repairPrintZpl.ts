// KAYITLI printZpl ONARIMI — ÜRÜN SATIRI EKLENEMEMİŞ ARTEFAKTLAR.
//
// SORUN: `resolvePersistedPrintableLabel` kayıtlı artefaktı AYNEN döndürür ve
// bir daha türetmez (immutable reprint). Artefakt, oluşturulduğu anda
// augmentation düştüğü için ürün satırsız (printZpl === technicalZpl)
// kaydedilmişse, o gönderi için ürün satırı BİR DAHA ASLA gelmez — katalog
// sonradan dolsa bile.
//
// BU MODÜL yalnız O DURUMU onarır:
//  - SADECE `printZpl === technicalZpl` olan (source_only) artefaktlar aday;
//    ürün satırı ZATEN eklenmiş artefakta ASLA dokunulmaz.
//  - technicalZpl KUTSAL KALIR: okunur, hash'i doğrulanır, ASLA yazılmaz.
//  - Yeniden türetme başarısızsa (hâlâ no_items / unsupported_template /
//    footer_overflow) satır GÜNCELLENMEZ; sebep raporlanır.
//  - Yazım compare-and-set: okuduğumuz şifreli payload hâlâ aynıysa yazılır;
//    araya giren değişiklik varsa atlanır (kayıp güncelleme YOK).
//  - Provider/marketplace çağrısı YOK, yeni shipment YOK, labelStatus ve
//    printCount DEĞİŞMEZ, migration YOK.
//
// GİZLİLİK: rapor ham ZPL, müşteri adı/adres/telefon, takip numarası veya
// barkod TAŞIMAZ; yalnız packageId, sayım ve teknik sebep.
//
// UYARI (bilinçli sözleşme kırılımı): onarılan gönderide tekrar baskı artık
// eski byte'larla AYNI DEĞİLDİR. Bu yüzden komut opt-in'dir ve varsayılanı
// dry-run'dır.
import { and, eq } from 'drizzle-orm'
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
import { loadPrintLineItems } from './printZplItems.ts'
import { SURAT_PERSISTENCE_PROVIDER } from './suratProvider.ts'
import { PRINT_ZPL_VERSION } from '../../src/utils/augmentedSuratZpl.ts'
import { parseSuratZplGeometry } from '../../src/utils/suratZplGeometry.ts'
import {
  buildProductLineMeta,
  buildProductLineText,
  buildProductLineTitle,
  resolveFooterArea,
  SURAT_FOOTER_PROFILES,
  FOOTER_BOTTOM_MARGIN,
  FOOTER_TOP_GAP,
  type SuratProductLineItem,
} from '../../src/utils/suratZplProductLine.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type RepairOutcome =
  | 'repaired'
  | 'already_augmented'
  | 'no_persisted_artifact'
  | 'no_source_zpl'
  | 'source_hash_mismatch'
  | 'still_no_items'
  | 'still_unsupported_template'
  | 'still_overflow'
  | 'write_conflict'

/**
 * TEŞHİS ÖLÇÜLERİ — yalnız sayı; ham ZPL, koordinat metni veya PII İÇERMEZ.
 * `still_overflow` sebebini rakamla görünür kılar.
 */
export interface RepairGeometry {
  printWidth: number
  labelLength: number
  /** Resmî içeriğin bittiği en alt Y (dot). */
  contentBottom: number
  footerTop: number
  footerBottom: number
  footerWidth: number
  /** Ürün satırı için KALAN yükseklik (dot). */
  footerHeight: number
  /** Profil merdiveninin en az ihtiyacı (dot); null = hiçbiri uygulanamıyor. */
  minRequiredHeight: number | null
  /** Sığmak için contentBottom en fazla kaç olabilirdi. */
  maxContentBottomToFit: number | null
}

export interface RepairEntry {
  /** Güvenli kimlik: paket numarası (PII değil). */
  packageId: string
  marketplace: string
  outcome: RepairOutcome
  /** Teknik açıklama — müşteri verisi veya ZPL İÇERMEZ. */
  detail?: string
  /** Onarıldıysa yeni artefaktın kimliği (denetim izi). */
  printZplSha256?: string
  itemCount?: number
  /** Seçilen footer profili (onarıldıysa). */
  footerProfile?: string | null
  geometry?: RepairGeometry
}

export interface RepairReport {
  organizationId: string
  marketplace: string
  mode: 'dry-run' | 'apply'
  scanned: number
  candidates: number
  repaired: number
  entries: RepairEntry[]
  /** apply için gereken jeton (dry-run çıktısında verilir). */
  confirmationToken?: string
  batchId?: string
  appliedAt?: string
}

export interface RepairScope {
  organizationId: string
  marketplace?: string
  /** Tek gönderiyi hedeflemek için (isteğe bağlı). */
  packageId?: string
  /** En fazla kaç gönderi işlensin. */
  limit?: number
}

/** Dry-run planından türeyen deterministik onay jetonu. */
export function buildConfirmationToken(
  organizationId: string,
  candidatePackageIds: string[],
): string {
  return sha256Hex(
    `${organizationId}|${[...candidatePackageIds].sort().join(',')}`,
  ).slice(0, 16)
}

/** Metnin verilen profilde kaç satır kaplayacağı (planSuratFooter ile AYNI kural). */
function estimateLines(text: string, fontWidth: number, widthDots: number): number {
  const charsPerLine = Math.max(
    1,
    Math.floor(widthDots / Math.max(1, fontWidth * 0.6)),
  )
  if (text.length <= charsPerLine) return 1
  let lines = 1
  let used = 0
  for (const word of text.split(' ')) {
    const needed = used === 0 ? word.length : used + 1 + word.length
    if (needed <= charsPerLine) used = needed
    else {
      lines += 1
      used = word.length
    }
  }
  return lines
}

/** Bu ürün kümesi için merdivenin EN AZ ihtiyacı olan yükseklik (dot). */
function minRequiredFooterHeight(
  items: SuratProductLineItem[],
  widthDots: number,
): number | null {
  let best: number | null = null
  for (const profile of SURAT_FOOTER_PROFILES) {
    const lineHeight = Math.round(profile.fontHeight * 1.05) + profile.lineGap
    let total = 0
    let usable = true
    for (const item of items) {
      const full = buildProductLineText(item)
      if (estimateLines(full, profile.fontWidth, widthDots) === 1) {
        total += lineHeight
        continue
      }
      if (profile.maxLinesPerItem < 2) {
        usable = false
        break
      }
      const lines =
        estimateLines(buildProductLineTitle(item), profile.fontWidth, widthDots) +
        estimateLines(buildProductLineMeta(item), profile.fontWidth, widthDots)
      if (lines > 3) {
        usable = false
        break
      }
      total += lines * lineHeight
    }
    if (!usable) continue
    if (best === null || total < best) best = total
  }
  return best
}

function describeGeometry(
  sourceZpl: string,
  items: SuratProductLineItem[],
): RepairGeometry {
  const geometry = parseSuratZplGeometry(sourceZpl)
  const area = resolveFooterArea(geometry)
  const minRequiredHeight = minRequiredFooterHeight(items, area.width)
  return {
    printWidth: geometry.printWidth,
    labelLength: geometry.labelLength,
    contentBottom: geometry.contentBottom,
    footerTop: area.top,
    footerBottom: area.bottom,
    footerWidth: area.width,
    footerHeight: area.height,
    minRequiredHeight,
    maxContentBottomToFit:
      minRequiredHeight === null
        ? null
        : geometry.labelLength -
          FOOTER_BOTTOM_MARGIN -
          FOOTER_TOP_GAP -
          minRequiredHeight,
  }
}

function readArtifact(payload: Record<string, unknown>) {
  const artifact = payload.printZplArtifact
  if (!artifact || typeof artifact !== 'object') return null
  return artifact as Record<string, unknown>
}

function pickSourceZpl(payload: Record<string, unknown>): string {
  for (const key of ['technicalZpl', 'barcodeRaw', 'BarcodeRaw']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

async function loadCandidateRows(db: Db, scope: RepairScope) {
  const filters = [
    eq(shipments.organizationId, scope.organizationId),
    eq(shipments.provider, SURAT_PERSISTENCE_PROVIDER),
    eq(shipments.marketplace, scope.marketplace ?? 'Trendyol'),
  ]
  if (scope.packageId) filters.push(eq(shipments.packageId, scope.packageId))
  const rows = await db
    .select()
    .from(shipments)
    .where(and(...filters))
  return scope.limit && scope.limit > 0 ? rows.slice(0, scope.limit) : rows
}

/**
 * Adayları tarar. `apply` false ise HİÇBİR YAZMA yapılmaz — çıktı doğrudan
 * teşhistir: her gönderi için augmentation'ın hangi sebeple düştüğü görünür.
 */
export async function repairSourceOnlyPrintZpl(
  db: Db,
  scope: RepairScope,
  options: {
    apply?: boolean
    confirmationToken?: string
    now?: string
    batchId?: string
  } = {},
): Promise<RepairReport> {
  const marketplace = scope.marketplace ?? 'Trendyol'
  const rows = await loadCandidateRows(db, scope)
  const entries: RepairEntry[] = []
  const candidatePackageIds: string[] = []
  let repaired = 0

  for (const row of rows) {
    const packageId = String(row.packageId ?? '')
    const encrypted = (row.carrierPayloadEncrypted ?? null) as string | null
    const payload = (decryptShipmentPayload(encrypted) ?? {}) as Record<
      string,
      unknown
    >
    const sourceZpl = pickSourceZpl(payload)
    if (!sourceZpl.trim()) {
      entries.push({ packageId, marketplace, outcome: 'no_source_zpl' })
      continue
    }
    const artifact = readArtifact(payload)
    if (!artifact) {
      // Artefakt hiç yok: normal hydration yolu zaten ürün satırını üretecek.
      entries.push({ packageId, marketplace, outcome: 'no_persisted_artifact' })
      continue
    }
    const persistedPrintZpl = String(artifact.printZpl ?? '')
    if (persistedPrintZpl !== sourceZpl) {
      // Ürün satırı ZATEN var — DOKUNULMAZ.
      entries.push({ packageId, marketplace, outcome: 'already_augmented' })
      continue
    }
    const sourceSha = sha256Hex(sourceZpl)
    if (
      typeof artifact.printZplSourceSha256 === 'string' &&
      artifact.printZplSourceSha256 &&
      artifact.printZplSourceSha256 !== sourceSha
    ) {
      // Kaynak ile artefakt uyuşmuyor: ONARMA, yalnız raporla.
      entries.push({ packageId, marketplace, outcome: 'source_hash_mismatch' })
      continue
    }

    candidatePackageIds.push(packageId)
    const items = await loadPrintLineItems(
      db,
      scope.organizationId,
      marketplace,
      packageId,
    )
    const derived = deriveAugmentedSuratZplWithHashes(sourceZpl, items)
    const geometry = describeGeometry(sourceZpl, items)
    if (!derived.augmented) {
      const outcome: RepairOutcome =
        derived.fallbackReason === 'unsupported_template'
          ? 'still_unsupported_template'
          : derived.fallbackReason === 'footer_overflow'
            ? 'still_overflow'
            : 'still_no_items'
      entries.push({
        packageId,
        marketplace,
        outcome,
        itemCount: items.length,
        // Yalnız teknik açıklama (şablon imzası/ölçü); PII veya ZPL YOK.
        detail: derived.fallbackMessage,
        geometry,
      })
      continue
    }

    if (!options.apply) {
      entries.push({
        packageId,
        marketplace,
        outcome: 'repaired',
        itemCount: items.length,
        printZplSha256: derived.printZplSha256,
        footerProfile: derived.printZplFooterProfile ?? null,
        detail: 'DRY-RUN: yazılmadı.',
        geometry,
      })
      repaired += 1
      continue
    }

    const nextArtifact = {
      printZpl: derived.printZpl,
      printZplLength: derived.printZpl.length,
      printZplSha256: derived.printZplSha256,
      printZplSourceSha256: sourceSha,
      printZplVersion: PRINT_ZPL_VERSION,
      printZplFooterProfile: derived.printZplFooterProfile ?? null,
      templateFingerprint: derived.templateFingerprint,
      printZplCreatedAt: options.now ?? new Date().toISOString(),
      augmentationReason: 'success' as DomainAugmentationStatus,
    }
    // COMPARE-AND-SET: payload okuduğumuzdan beri değişmediyse yaz.
    const updated = await db
      .update(shipments)
      .set({
        carrierPayloadEncrypted: encryptShipmentPayload({
          ...payload,
          // technicalZpl AYNEN korunur; yalnız türetilmiş blok değişir.
          printZplArtifact: nextArtifact,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(shipments.organizationId, scope.organizationId),
          eq(shipments.marketplace, marketplace),
          eq(shipments.packageId, packageId),
          eq(shipments.provider, SURAT_PERSISTENCE_PROVIDER),
          eq(shipments.carrierPayloadEncrypted, encrypted as string),
        ),
      )
      .returning()
    if (!updated || updated.length === 0) {
      entries.push({ packageId, marketplace, outcome: 'write_conflict' })
      continue
    }
    entries.push({
      packageId,
      marketplace,
      outcome: 'repaired',
      itemCount: items.length,
      printZplSha256: derived.printZplSha256,
      footerProfile: derived.printZplFooterProfile ?? null,
      geometry,
    })
    repaired += 1
  }

  return {
    organizationId: scope.organizationId,
    marketplace,
    mode: options.apply ? 'apply' : 'dry-run',
    scanned: rows.length,
    candidates: candidatePackageIds.length,
    repaired,
    entries,
    ...(options.apply
      ? { batchId: options.batchId, appliedAt: options.now }
      : {
          confirmationToken: buildConfirmationToken(
            scope.organizationId,
            candidatePackageIds,
          ),
        }),
  }
}
