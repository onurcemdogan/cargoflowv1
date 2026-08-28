// OTOMATİK ETİKET ÜRETİCİSİ — KUYRUĞA KİM EKLİYOR?
//
// ═══ NEDEN VAR (kanıtlanmış boşluk) ══════════════════════════════════════
// Kuyruk, worker ve politika vardı; ama üretim kodunda `enqueueLabelJob`
// çağıran TEK BİR YER YOKTU. Yani `LABEL_WORKER_ENABLED=true` yapılsaydı
// worker boş kuyruğu dönüp duracak, hiçbir etiket üretilmeyecekti.
// "Otomatik etiket" özelliği üretici olmadan TAMAMLANMIŞ SAYILMAZ.
//
// ═══ AKTİVASYON SINIRI — EN KRİTİK GÜVENLİK ══════════════════════════════
// Bayrak açıldığı anda kiracının veritabanında binlerce uygun GEÇMİŞ paket
// bekliyor olabilir. Sınır olmasaydı tek bir ayar değişikliği binlerce
// GERİ ALINAMAZ ve FATURALANABİLİR Sürat etiketi üretirdi.
//
// Bu yüzden aday sorgusu `first_seen_at >= activatedAt` ile SINIRLIDIR ve
// sınır yoksa üretici HİÇBİR paket seçmez (fail-safe). Geçmiş yığın elle
// etiketlenir; karar insanındır.
//
// ═══ İKİNCİ UYGULAMA YOK ═════════════════════════════════════════════════
// Uygunluk kararı gerçek create kapısından (`resolveSuratCreateEligibility`)
// gelir; burada kopyalanmaz. Kuyruğa ekleme tekilliği VERİTABANINDADIR.

import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { labelJobs, orders, organizationSettings, shipments } from '../db/schema.ts'
import {
  resolveActivationBoundary,
  resolveAutoLabelEnqueue,
  type AutoLabelScope,
  type AutoLabelSettings,
} from './suratAutoLabelPolicy.ts'
import { resolveSuratCreateEligibility } from './suratCreateEligibility.ts'
import {
  DEPENDENCY_BLOCKED_CODES,
  enqueueLabelJob,
  reactivateDependencyBlockedJob,
} from './labelJobQueue.ts'
import { classifyMarketplaceLifecycle } from './trendyolShipmentEligibility.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** settings_json altındaki kiracı ayarı. */
export const AUTO_LABEL_SETTINGS_KEY = 'autoLabel'

/** Tek turda seçilebilecek EN FAZLA aday — sınırsız yığın işleme YOK. */
export const AUTO_LABEL_PRODUCER_BATCH = 200

export interface ProducerReport {
  /** Sınır sonrası görülen ve incelenen paket sayısı. */
  readonly examined: number
  readonly enqueued: number
  /** Politika tarafından reddedilenler: sebep → adet. */
  readonly blocked: Record<string, number>
  /** Aktivasyon sınırı (ms) — yoksa null ve hiçbir şey yapılmaz. */
  readonly boundaryMs: number | null
}

export async function loadAutoLabelSettings(
  db: Db,
  organizationId: string,
): Promise<AutoLabelSettings | null> {
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
  const settings = (rows[0]?.settingsJson ?? {}) as Record<string, unknown>
  const stored = settings[AUTO_LABEL_SETTINGS_KEY]
  if (!stored || typeof stored !== 'object') return null
  return stored as AutoLabelSettings
}

/**
 * Kiracı için otomatik etiketi AÇAR ve aktivasyon sınırını `now` olarak
 * damgalar.
 *
 * Sınır YAZILMADAN otomatik etiket açılamaz: `resolveAutoLabelEnqueue`
 * sınırsız ayarı reddeder. Böylece "açtım ama sınır koymayı unuttum"
 * durumu sessiz bir geçmiş-yığın taramasına dönüşemez.
 */
export async function activateAutoLabel(
  db: Db,
  organizationId: string,
  params: { marketplaces: string[]; carriers: string[]; now: string },
): Promise<AutoLabelSettings> {
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
  const settings = ((rows[0]?.settingsJson ?? {}) as Record<string, unknown>) || {}
  const autoLabel: AutoLabelSettings = {
    enabled: true,
    marketplaces: params.marketplaces,
    carriers: params.carriers,
    activatedAt: params.now,
  }
  // MERGE: etiket şablonu ve stream imleci KORUNUR.
  const next = { ...settings, [AUTO_LABEL_SETTINGS_KEY]: autoLabel }
  if (!rows[0]) {
    await db
      .insert(organizationSettings)
      .values({ organizationId, settingsJson: next })
  } else {
    await db
      .update(organizationSettings)
      .set({ settingsJson: next, updatedAt: new Date(params.now) })
      .where(eq(organizationSettings.organizationId, organizationId))
  }
  return autoLabel
}

/**
 * Sınırdan SONRA görülmüş, etiketi olmayan paketleri kuyruğa alır.
 *
 * Taşıyıcıya ÇIKMAZ: yalnız yerel kayıt okunur ve iş satırı yazılır. Gerçek
 * create'i worker yapar.
 */
export async function enqueueEligibleAutoLabelJobs(
  db: Db,
  organizationId: string,
  options: { limit?: number } = {},
): Promise<ProducerReport> {
  const settings = await loadAutoLabelSettings(db, organizationId)
  const boundaryMs = resolveActivationBoundary(settings)
  const blocked: Record<string, number> = {}
  const bump = (reason: string) => {
    blocked[reason] = (blocked[reason] ?? 0) + 1
  }
  // FAIL-SAFE: sınır yoksa TEK BİR paket bile taranmaz.
  if (settings?.enabled !== true || boundaryMs === null) {
    return { examined: 0, enqueued: 0, blocked, boundaryMs }
  }

  const limit = Math.max(
    1,
    Math.min(Number(options.limit ?? AUTO_LABEL_PRODUCER_BATCH), AUTO_LABEL_PRODUCER_BATCH),
  )
  // ADAY SORGUSU: sınır SQL'de uygulanır — geçmiş yığın Node'a bile gelmez.
  const candidates = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        gte(orders.firstSeenAt, new Date(boundaryMs)),
        isNull(orders.archivedAt),
      ),
    )
    .orderBy(orders.firstSeenAt)
    .limit(limit)

  let enqueued = 0
  for (const row of candidates as Record<string, unknown>[]) {
    const scope: AutoLabelScope = {
      organizationId,
      marketplace: String(row.marketplace ?? ''),
      carrier: 'Surat',
    }
    const packageId = String(row.packageId ?? '')
    // Etiket/taşıyıcı artefaktı var mı — gönderi kaydından okunur.
    const existing = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, organizationId),
          eq(shipments.marketplace, String(row.marketplace ?? '')),
          eq(shipments.packageId, packageId),
        ),
      )
      .limit(1)
    const hasCarrierArtifact = existing.length > 0

    // ═══ PAZARYERİ YAŞAM DÖNGÜSÜ KAPISI ══════════════════════════════
    //
    // ÜRETİMDE ÖLÇÜLDÜ: üretici `resolveSuratCreateEligibility` kullanıyordu
    // ve o fonksiyon `marketplaceStatus`'u HİÇ OKUMAZ. Sonuç: `Shipped`
    // paketler (4110043440 · attempt 37) BLOKE'den QUEUED'e canlandırıldı,
    // `Created` paketler sıraya alındı ve worker onları hemen yeniden
    // BLOKE etti — sonsuz durum çalkantısı.
    //
    // Kapı artık PAYLAŞILAN yaşam döngüsü sınıfına sorar. `TERMINAL`
    // (Shipped/Delivered/Cancelled/Returned/mevcut gönderi izi) için yeni
    // create ASLA açılmaz; `NOT_YET` (Created) beklemede kalır.
    const lifecycle = classifyMarketplaceLifecycle(row)
    if (lifecycle.lifecycle !== 'ELIGIBLE') {
      bump(`MARKETPLACE_LIFECYCLE_${lifecycle.lifecycle}`)
      continue
    }

    // UYGUNLUK GERÇEK KAPIDAN. Deneme geçmişi bilinmiyorsa kapı zaten
    // "uygun değil" der; burada 0 VARSAYILMAZ.
    const eligibility = resolveSuratCreateEligibility({
      order: {
        orderNumber: String(row.orderNumber ?? ''),
        packageId,
        cargoTrackingNumber: String(row.cargoTrackingNumber ?? ''),
      },
      attemptEvidence: { known: true, count: hasCarrierArtifact ? 1 : 0 },
    })

    const decision = resolveAutoLabelEnqueue({
      scope,
      packageId,
      settings,
      eligibility,
      billingResolved: true,
      credentialResolved: true,
      hasLabelArtifact: hasCarrierArtifact,
      hasCarrierArtifact,
      previousNetworkCrossed: false,
      firstSeenAtMs: row.firstSeenAt instanceof Date
        ? row.firstSeenAt.getTime()
        : Date.parse(String(row.firstSeenAt ?? '')),
    })
    if (!decision.enqueue) {
      bump(decision.blockReason ?? 'UNKNOWN')
      continue
    }
    const result = await enqueueLabelJob(db, {
      organizationId,
      marketplace: scope.marketplace,
      carrier: 'surat',
      packageId,
    })
    if (result.enqueued) {
      enqueued += 1
      continue
    }
    // ═══ BAĞIMLILIK ÇIKMAZI AÇILIR — AMA YALNIZ GERÇEKTEN AÇILDIYSA ═══
    //
    // Benzersizlik çakışması "iş zaten var" demektir; "iş çalışabilir"
    // DEMEZ. `Created` iken bloke edilmiş bir paket `Picking`e geçtiğinde
    // burada uyandırılmazsa KALICI OLARAK sıkışırdı.
    //
    // ÜRETİMDE ÖLÇÜLDÜ: ilk hâli YALNIZ "satır var + paket yeniden
    // görüldü" koşuluna bakıyordu ve `Shipped`/`Created` paketleri
    // uyandırıyordu. Canlandırmanın koşulu ARTIK "BLOKE'ye yol açan
    // bağımlılık GERÇEKTEN çözüldü mü?"dur ve bunun OTORİTESİ paylaşılan
    // hazırlığın GÜNCEL çıktısıdır.
    //
    // Hazırlık hâlâ geçersizse satır BLOKE KALIR: hiçbir yazım yapılmaz,
    // `updated_at` bile değişmez, `attempt_count` sabit kalır.
    //
    // ÖNCE DURUM: canlandırma YALNIZ `BLOCKED` satırlar içindir. Satır
    // zaten `QUEUED`/`PREPARING`/`READY`/`UNKNOWN_AFTER_NETWORK` ise
    // yapılacak bir şey YOKTUR — hazırlık bile ÇALIŞTIRILMAZ (her üretici
    // turunda her aday için gereksiz sorgu demek olurdu).
    const existingJob = (await db
      .select({
        status: labelJobs.status,
        lastErrorCode: labelJobs.lastErrorCode,
      })
      .from(labelJobs)
      .where(
        and(
          eq(labelJobs.organizationId, organizationId),
          eq(labelJobs.marketplace, scope.marketplace),
          eq(labelJobs.carrier, 'surat'),
          eq(labelJobs.packageId, packageId),
        ),
      )
      .limit(1)) as Record<string, unknown>[]
    const currentStatus = String(existingJob[0]?.status ?? '')
    const currentCode = String(existingJob[0]?.lastErrorCode ?? '')
    if (
      currentStatus !== 'BLOCKED'
      || !DEPENDENCY_BLOCKED_CODES.includes(currentCode)
    ) {
      bump('ALREADY_QUEUED')
      continue
    }

    const { prepareLabelJob } = await import('./labelJobPreparation.ts')
    const prepared = await prepareLabelJob(db, {
      organizationId,
      packageId,
      marketplace: scope.marketplace,
    })
    if (!prepared.ok) {
      bump(`DEPENDENCY_STILL_BLOCKED_${prepared.blockerCode}`)
      continue
    }
    // Yalnız BAĞIMLILIK sınıfı bloke satır uyandırılır; READY,
    // UNKNOWN_AFTER_NETWORK ve PREPARING DOKUNULMAZ.
    const revived = await reactivateDependencyBlockedJob(db, {
      organizationId,
      marketplace: scope.marketplace,
      carrier: 'surat',
      packageId,
    })
    if (revived) {
      enqueued += 1
      bump('DEPENDENCY_BLOCK_CLEARED')
    } else {
      bump('ALREADY_QUEUED')
    }
  }

  return {
    examined: candidates.length,
    enqueued,
    blocked,
    boundaryMs,
  }
}

/** Aday sayımı — açmadan ÖNCE "kaç paket etkilenir?" sorusuna yanıt. */
export async function countAutoLabelCandidates(
  db: Db,
  organizationId: string,
  boundaryMs: number,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        gte(orders.firstSeenAt, new Date(boundaryMs)),
        isNull(orders.archivedAt),
      ),
    )
  return Number(rows[0]?.total ?? 0)
}
