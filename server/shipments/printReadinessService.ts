// TOPLU BASKI HAZIRLIK DURUMU — HAFİF metadata, ZPL YOK.
//
// ═══ NEDEN AYRI BİR YOL ══════════════════════════════════════════════════
//
// Liste ekranı "bu 25 gönderi basılabilir mi?" sorusunu sorar. Bu soruyu
// baskı yolundan (tam ZPL çözümü) cevaplamak, her liste yenilemesinde
// gönderi başına şifre çözme + katalog okuma + sayfa üretimi demektir.
// 4.000 sipariş/gün ölçeğinde bu kabul edilemez.
//
// ═══ SÖZLEŞME ════════════════════════════════════════════════════════════
//
//  1) ZPL DÖNMEZ. Ne taşıyıcı, ne ek sayfa, ne kaynak, ne ham payload.
//     Yalnız sayılar ve KAPALI SÖZLÜK durum değerleri döner.
//  2) SORGU SAYISI GÖNDERİ SAYISINDAN BAĞIMSIZ. N+1 yok: gönderiler tek
//     sorguda, ürün satırları tek toplu yükleyicide.
//  3) YALNIZ İSTENEN kimlikler çözülür. Organizasyonun tamamı OKUNMAZ,
//     4.000 şifreli payload'ın hepsi ÇÖZÜLMEZ.
//  4) YAZMA YOK. Hazırlık sorgusu hydration TETİKLEMEZ; kalıcı artefakt
//     üretmez, mevcut artefakta dokunmaz. Baskı anındaki davranışı TAHMİN
//     eder, DEĞİŞTİRMEZ.
//  5) Sonuç, baskı yolunun kararıyla AYNI mantıktan türetilir: aynı
//     doğrulayıcılar, aynı eşik, aynı fail-open politikası. Hazırlık
//     "hazır" derken baskının patlaması KABUL EDİLEMEZ.
import { and, eq, inArray } from 'drizzle-orm'
import { shipments } from '../db/schema.ts'
import { decryptShipmentPayload } from './shipmentEncryption.ts'
import { sha256Hex } from '../../src/utils/augmentedSuratZpl.ts'
import { buildPrintableJob } from '../../src/utils/printableLabelJob.ts'
import { planProductDetailPages } from '../../src/utils/suratProductDetailLabel.ts'
import {
  loadPrintLineItemsBatch,
  printLineItemKeyOf,
} from './printZplItems.ts'
import { validateCarrierSourceZpl } from './carrierSourceFallback.ts'
import {
  SUPPLEMENTAL_GEOMETRY_FAILURE,
  verifyPersistedPrintZpl,
  __testing,
} from './printZplRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

const { pickSourceZpl, readPersisted } = __testing

/**
 * İSTEK BAŞINA KİMLİK ÜST SINIRI.
 *
 * Mevcut UI toplu sözleşmesinden TÜRETİLİR: sipariş listesinin en büyük
 * sayfa boyutu 100'dür (OrdersPage sayfa boyutu seçenekleri 10/25/50/100).
 * Görünür sayfa TEK istekte karşılanabilmeli; daha büyük istekler SESSİZCE
 * kırpılmaz, açıkça REDDEDİLİR.
 */
export const MAX_READINESS_IDS = 100

/** Kapalı sözlük — güvenli, tipli sebepler. Ham veri veya ayrıntı TAŞIMAZ. */
export type ReadinessFailureReason =
  | 'shipment_not_found'
  | 'carrier_source_missing'
  | 'carrier_structure_invalid'
  | 'carrier_identity_unverifiable'
  | 'carrier_identity_mismatch'
  | 'artifact_corrupt'
  | 'bundle_invalid'

export interface PrintReadinessEntry {
  shipmentId: string
  carrierPrintReady: boolean
  printArtifactStatus: 'ready' | 'failed' | 'fallback_carrier'
  productDetailStatus: 'none' | 'ready' | 'failed'
  labelPageCount: number
  productDetailPageCount: number
  failureReason?: ReadinessFailureReason
  productDetailFailureReason?: string
}

const notReady = (
  shipmentId: string,
  failureReason: ReadinessFailureReason,
): PrintReadinessEntry => ({
  shipmentId,
  carrierPrintReady: false,
  printArtifactStatus: 'failed',
  productDetailStatus: 'failed',
  labelPageCount: 0,
  productDetailPageCount: 0,
  failureReason,
})

/** Taşıyıcı doğrulama sonucunu kapalı sözlük sebebine çevirir. */
function carrierReason(reason: string): ReadinessFailureReason {
  return reason === 'carrier_source_missing' ||
    reason === 'carrier_structure_invalid' ||
    reason === 'carrier_identity_mismatch'
    ? reason
    : 'carrier_identity_unverifiable'
}

/**
 * Verilen gönderi kimlikleri için hazırlık durumunu TOPLU çözer.
 *
 * Sorgu bütçesi (kimlik sayısından BAĞIMSIZ):
 *   1 × gönderi satırları
 *   0..3 × ürün satırı toplu yüklemesi (yalnız artefaktı OLMAYAN kayıtlar
 *          için; hepsi kalıcıysa katalog HİÇ okunmaz)
 *
 * Dönen dizi GİRDİ SIRASINI korur ve her kimlik için TAM BİR kayıt içerir;
 * bilinmeyen/başka org'a ait kimlikler `shipment_not_found` ile döner —
 * varlık bilgisi SIZMAZ (org dışı ile hiç yok AYNI cevabı verir).
 */
export async function loadPrintReadiness(
  db: Db,
  organizationId: string,
  shipmentIds: readonly string[],
): Promise<PrintReadinessEntry[]> {
  // Girdi sırası korunur; tekrar eden kimlikler TEK KEZ çözülür.
  const ordered = shipmentIds.map((value) => String(value ?? '').trim())
  const unique = Array.from(new Set(ordered.filter(Boolean)))
  if (unique.length === 0) return ordered.map((id) => notReady(id, 'shipment_not_found'))

  const rows = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        inArray(shipments.id, unique),
      ),
    )

  // Şifre çözme YALNIZ istenen satırlar için.
  const decoded = new Map<
    string,
    { payload: Record<string, unknown>; row: Record<string, unknown> }
  >()
  const missingArtifact: Array<{ marketplace: string; packageId: string }> = []
  for (const row of rows as Array<Record<string, unknown>>) {
    const payload = (decryptShipmentPayload(
      (row.carrierPayloadEncrypted ?? null) as string | null,
    ) ?? {}) as Record<string, unknown>
    decoded.set(String(row.id), { payload, row })
    if (!readPersisted(payload)) {
      missingArtifact.push({
        marketplace: String(row.marketplace ?? ''),
        packageId: String(row.packageId ?? ''),
      })
    }
  }

  // Ürün satırları YALNIZ artefaktı olmayan kayıtlar için ve TEK toplu
  // yüklemede. Tüm kayıtlar kalıcıysa katalog HİÇ okunmaz.
  const itemsByKey =
    missingArtifact.length > 0
      ? await loadPrintLineItemsBatch(db, organizationId, missingArtifact)
      : new Map()

  const byId = new Map<string, PrintReadinessEntry>()
  for (const [shipmentId, { payload, row }] of decoded) {
    byId.set(shipmentId, evaluate(shipmentId, payload, row, itemsByKey))
  }
  return ordered.map(
    (id) => byId.get(id) ?? notReady(id, 'shipment_not_found'),
  )
}

function evaluate(
  shipmentId: string,
  payload: Record<string, unknown>,
  row: Record<string, unknown>,
  itemsByKey: Map<string, unknown[]>,
): PrintReadinessEntry {
  const sourceZpl = pickSourceZpl(payload)
  if (!sourceZpl.trim()) return notReady(shipmentId, 'carrier_source_missing')

  // ── 1) KALICI ARTEFAKT ────────────────────────────────────────────────
  const persisted = readPersisted(payload)
  if (persisted) {
    const verdict = verifyPersistedPrintZpl(persisted, sha256Hex(sourceZpl))
    // BOZUK KALICI ARTEFAKT fail-open kapsamında DEĞİLDİR: kaynağa düşülmez.
    if (!verdict.ok) return notReady(shipmentId, 'artifact_corrupt')
    const job = buildPrintableJob({
      carrierZpl: persisted.printZpl,
      supplementalLabels: persisted.supplementalLabels ?? [],
      hash: sha256Hex,
    })
    if (!job.printReady) return notReady(shipmentId, 'bundle_invalid')
    return {
      shipmentId,
      carrierPrintReady: true,
      printArtifactStatus: 'ready',
      productDetailStatus:
        job.productDetailPageCount > 0 ? 'ready' : 'none',
      labelPageCount: job.labelPageCount,
      productDetailPageCount: job.productDetailPageCount,
    }
  }

  // ── 2) ARTEFAKT YOK: baskı anında ne olacağını AYNI mantıkla türet ────
  const items = (itemsByKey.get(
    printLineItemKeyOf(row.marketplace, row.packageId),
  ) ?? []) as never[]
  const plan = planProductDetailPages(items)
  const supplementalFails = plan.required && plan.reason !== null

  if (!supplementalFails) {
    // Hydration TAM artefakt üretecek. (Burada ÜRETİLMEZ ve YAZILMAZ.)
    return {
      shipmentId,
      carrierPrintReady: true,
      printArtifactStatus: 'ready',
      productDetailStatus: plan.required ? 'ready' : 'none',
      labelPageCount: 1 + (plan.required ? plan.pages.length : 0),
      productDetailPageCount: plan.required ? plan.pages.length : 0,
    }
  }

  // ── 3) FAIL-OPEN: ek sayfa çöktü → taşıyıcı kimliği KANITLANMALI ──────
  const carrier = validateCarrierSourceZpl(sourceZpl, {
    trackingNumber: (row.trackingNumber ?? null) as string | null,
    barcode: (row.barcode ?? null) as string | null,
  })
  if (!carrier.ok) return notReady(shipmentId, carrierReason(carrier.reason))
  return {
    shipmentId,
    carrierPrintReady: true,
    printArtifactStatus: 'fallback_carrier',
    productDetailStatus: 'failed',
    productDetailFailureReason: SUPPLEMENTAL_GEOMETRY_FAILURE,
    labelPageCount: 1,
    productDetailPageCount: 0,
  }
}
