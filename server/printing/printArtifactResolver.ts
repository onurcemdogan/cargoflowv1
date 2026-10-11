// SUNUCU YETKİLİ ARTEFAKT ÇÖZÜMLEME.
//
// ═══ İKİNCİ BİR ÇÖZÜMLEYİCİ YAZILMADI ════════════════════════════════════
//
// Kabul edilmiş TEK baskı servis girişi `resolvePrintableLabelForServing`tir
// ve sıra/hash/fail-open kuralları ORADA yaşar. Bu modül onu SARAR: kanonik
// sayfa modeline çevirir, geometriyi ekler ve kiracı kapsamını zorunlu kılar.
// İkinci bir taşıyıcı ayrıştırıcı/birleştirici YOKTUR.
//
// ═══ YENİDEN ÜRETİM YOK ══════════════════════════════════════════════════
//
// Baskı isteği sırasında:
//   · kalıcı `printZpl` YENİDEN ÜRETİLMEZ
//   · pazaryeri ÇAĞRILMAZ
//   · taşıyıcı ÇAĞRILMAZ
//   · kalıcı artefakt ONARILMAZ (onarım ayrı araçtır)
//
// Hash zinciri doğrulanamıyorsa FAIL-CLOSED: baskı YAPILMAZ.
import { and, eq } from 'drizzle-orm'
import { shipments } from '../db/schema.ts'
import { sha256Hex } from '../../src/utils/augmentedSuratZpl.ts'
import { buildPrintableJob } from '../../src/utils/printableLabelJob.ts'
import { loadPrintLineItems } from '../shipments/printZplItems.ts'
import { resolvePrintableLabelForServing } from '../shipments/printZplRepository.ts'
import {
  isCanonicalPageOrder,
  type CanonicalPrintArtifact,
  type CanonicalPrintPage,
} from './printArtifactModel.ts'
import { geometryForSource } from './printSourceGeometry.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Kanonik persistence sağlayıcı anahtarı (görünen ad DEĞİL). */
export const SURAT_PERSISTENCE_PROVIDER = 'surat'
export const SURAT_ARTIFACT_SOURCE = 'surat_persisted_print_bundle'

/** Kapalı sözlük — ham hata metni ya da PII TAŞIMAZ. */
export const PRINT_RESOLUTION_FAILURES = [
  'ORDER_NOT_FOUND',
  'SHIPMENT_NOT_FOUND',
  'ARTIFACT_NOT_READY',
  'ARTIFACT_HASH_MISMATCH',
  'PAGE_ORDER_INVALID',
  'GEOMETRY_UNKNOWN',
] as const
export type PrintResolutionFailure = (typeof PRINT_RESOLUTION_FAILURES)[number]

export type PrintArtifactResolution =
  | { ok: true; artifact: CanonicalPrintArtifact }
  | { ok: false; failure: PrintResolutionFailure }

export interface PrintArtifactRequest {
  organizationId: string
  marketplace: string
  packageId: string
}

/**
 * Sipariş kimliğinden gönderi anahtarını KİRACI KAPSAMINDA çözer.
 *
 * Kiracı kimliği YALNIZ auth bağlamından gelir; istek gövdesi onu
 * DEĞİŞTİREMEZ. Başka kiracının siparişi `ORDER_NOT_FOUND` döner —
 * "var ama senin değil" ile "hiç yok" AYNI cevabı verir.
 */
export async function resolveShipmentKeyForOrder(
  db: Db,
  params: {
    organizationId: string
    orderId: string
    marketplaceAccountId?: string | null
    getOrder: (
      db: Db,
      organizationId: string,
      orderId: string,
      marketplaceAccountId?: string | null,
    ) => Promise<Record<string, unknown> | null>
  },
): Promise<PrintArtifactRequest | null> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (organizationId === '') return null
  const order = await params.getOrder(
    db,
    organizationId,
    String(params.orderId ?? ''),
    params.marketplaceAccountId ?? null,
  )
  if (!order) return null
  const marketplace = String(order.marketplace ?? '')
  const packageId = String(order.packageId ?? '')
  if (!marketplace || !packageId) return null
  return { organizationId, marketplace, packageId }
}

/**
 * KANONİK ARTEFAKT.
 *
 * `carrier_fallback` (ek sayfa katmanı çöktü, taşıyıcı kimliği KANITLANDI)
 * kabul edilmiş SERVING davranışıdır ve KORUNUR: taşıyıcı sayfa tek başına
 * döner. Bu kalıcı bir artefakt DEĞİLDİR ve hiçbir şey yazılmaz.
 */
export async function resolveCanonicalPrintArtifact(
  db: Db,
  request: PrintArtifactRequest,
): Promise<PrintArtifactResolution> {
  const organizationId = String(request.organizationId ?? '').trim()
  if (organizationId === '') return { ok: false, failure: 'ORDER_NOT_FOUND' }

  const key = {
    organizationId,
    marketplace: String(request.marketplace ?? ''),
    packageId: String(request.packageId ?? ''),
    provider: SURAT_PERSISTENCE_PROVIDER,
  }

  // KİRACI SINIRI — istisnasız. Satır yoksa varlık bilgisi SIZMAZ.
  const rows = await db
    .select({
      id: shipments.id,
      marketplace: shipments.marketplace,
      packageId: shipments.packageId,
      provider: shipments.provider,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.marketplace, key.marketplace),
        eq(shipments.packageId, key.packageId),
        eq(shipments.provider, key.provider),
      ),
    )
    .limit(1)
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return { ok: false, failure: 'SHIPMENT_NOT_FOUND' }

  const geometry = geometryForSource(SURAT_ARTIFACT_SOURCE)
  // Ölçü UYDURULMAZ: bilinmeyen kaynak fail-closed.
  if (!geometry) return { ok: false, failure: 'GEOMETRY_UNKNOWN' }

  let resolution
  try {
    resolution = await resolvePrintableLabelForServing(db, key, {
      // TEMBEL: kalıcı artefakt varsa katalog HİÇ okunmaz (reprint
      // değişmezliği). Bu yükleyici yalnız hydration gerekirse çalışır.
      loadItems: () =>
        loadPrintLineItems(db, organizationId, key.marketplace, key.packageId),
    })
  } catch {
    // Kaynak eksik / hash uyuşmazlığı / bozuk artefakt → FAIL-CLOSED.
    return { ok: false, failure: 'ARTIFACT_NOT_READY' }
  }

  const pages: CanonicalPrintPage[] = []
  // Her iki dal da ATAR; ilk değer yazmak ölü atamadır.
  let printZplSha256: string
  let printZplSourceSha256: string

  if (resolution.kind === 'carrier_fallback') {
    // Kabul edilmiş SERVING davranışı: yalnız taşıyıcı sayfa.
    printZplSha256 = resolution.carrierZplSha256
    printZplSourceSha256 = resolution.carrierZplSha256
    pages.push({
      index: 0,
      kind: 'carrier',
      contentKind: 'ZPL',
      content: resolution.carrierZpl,
      sha256: resolution.carrierZplSha256,
      geometry,
    })
  } else {
    const model = resolution.model
    printZplSha256 = model.printZplSha256
    printZplSourceSha256 = model.printZplSourceSha256
    // ═══ HASH ZİNCİRİ — TAŞIMADAN ÖNCE ══════════════════════════════
    //
    // Kalıcı baytların özeti tutmuyorsa baskı YAPILMAZ ve ONARILMAZ.
    if (sha256Hex(model.printZpl) !== model.printZplSha256) {
      return { ok: false, failure: 'ARTIFACT_HASH_MISMATCH' }
    }
    const job = buildPrintableJob({
      carrierZpl: model.printZpl,
      supplementalLabels: model.supplementalLabels ?? [],
      hash: sha256Hex,
    })
    // TAM İŞ YA DA HİÇ: bozuk ek sayfa taşıyıcıyı TEK BAŞINA bastırmaz.
    if (!job.printReady) return { ok: false, failure: 'ARTIFACT_HASH_MISMATCH' }
    for (const [index, page] of job.pages.entries()) {
      pages.push({
        index,
        kind: page.kind,
        contentKind: 'ZPL',
        content: page.zpl,
        sha256: page.sha256 ?? null,
        geometry,
      })
    }
  }

  // Sıra DEĞİŞMEZDİR: sapma sessizce düzeltilmez.
  if (!isCanonicalPageOrder(pages)) {
    return { ok: false, failure: 'PAGE_ORDER_INVALID' }
  }

  return {
    ok: true,
    artifact: {
      organizationId,
      shipmentId: String(row.id),
      packageId: key.packageId,
      marketplace: key.marketplace,
      carrier: key.provider,
      // Taşıyıcı baytları SUNUCUDA kalıcıdır; istemci YERİNE KOYAMAZ.
      ownership: 'SERVER_AUTHORITATIVE',
      source: SURAT_ARTIFACT_SOURCE,
      printZplSha256,
      printZplSourceSha256,
      pages,
    },
  }
}
