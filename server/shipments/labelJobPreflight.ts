// ETİKET İŞİ ÖN KONTROLÜ — TEK PAYLAŞILAN, SALT-OKUNUR HAZIRLIK.
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
// `auto-label:job:inspect` siparişi ve desiyi KENDİ yolundan yüklüyordu;
// worker ise create orkestrasyonundan. İki hazırlık = iki gerçek. Üretimde
// bunun bedeli görüldü: kiracı ayarı 2 iken inspector `RESOLVER_DESI=null`
// dedi ve gerçek worker'ın ne yapacağı BİLİNMEZ kaldı.
//
// Bu modül hazırlığı TEK yere indirir. Hem inspector hem preflight hem de
// gelecekteki her salt-okunur denetim BURAYI çağırır.
//
// ═══ HATA YUTULMAZ ═══════════════════════════════════════════════════════
// Önceki inspector, herhangi bir istisnayı `DESI_COZUMU_OKUNAMADI` gibi
// GENEL bir engele çeviriyordu; üretimde gerçek sebep KAYBOLDU. Burada
// yakalanan istisnanın mesajı `failureDetail` olarak AYNEN taşınır.
// "Bilinmiyor" ile "çözülemedi" ASLA aynı şey değildir.
//
// ═══ AĞ VE YAZIM YOK ═════════════════════════════════════════════════════
// Taşıyıcıya ÇIKILMAZ, SOAP zarfı KURULMAZ, hiçbir satır YAZILMAZ.
// Hazırlık taşıyıcı ağının HEMEN ÖNCESİNDE durur.

import { and, eq } from 'drizzle-orm'
import { labelJobs } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/**
 * ESKI BLOKLAYICI ETIKETLERI — mevcut cagiranlarin/testlerin sozlugu.
 *
 * Hazirlik KESIN kodlari uretir; rapor onlari mevcut etiketlere cevirir.
 * Ikinci bir esleme tablosu DEGILDIR: tek yonlu, sunum amaclidir.
 */
const LEGACY_BLOCKER_LABELS: Record<string, string> = {
  SURAT_PREFLIGHT_DESI_MISSING: 'DESI_COZULEMIYOR',
  SURAT_CREDENTIAL_CONFIG_INVALID: 'KIMLIK_COZULEMIYOR',
  SURAT_PREFLIGHT_ORDER_NOT_FOUND: 'SIPARIS_BULUNAMADI',
  SURAT_PREFLIGHT_WHOPAYS_UNRESOLVED: 'WHOPAYS_COZULEMIYOR',
  SURAT_PREFLIGHT_CARRIER_ARTIFACT_EXISTS: 'TASIYICI_ARTEFAKTI_VAR',
  SURAT_PREFLIGHT_FAILED: 'HAZIRLIK_ISTISNASI',
  SURAT_PREFLIGHT_SCHEMA_DRIFT: 'SEMA_SURUMU_ESKI',
  SURAT_PREFLIGHT_ENCRYPTION_KEY_MISSING: 'ORTAM_SIFRELEME_ANAHTARI_YOK',
}

export interface LabelJobPreflight {
  readonly packageId: string
  readonly orderNumber: string | null
  readonly marketplace: string
  readonly jobId: string | null
  readonly jobStatus: string | null
  readonly attemptCount: number

  readonly tenantDesi: number | null
  readonly multiplyByItemQuantity: boolean | null
  readonly orderLinesCount: number
  readonly resolvedDesi: number | null
  readonly desiSource: string | null
  /** Sürat alan adı — `BirimDesi` çözülen desiyle AYNIDIR. */
  readonly suratBirimDesi: number | null

  /** Trendyol paket statusu create'e izin veriyor mu? */
  readonly marketplaceStatus: string | null
  readonly eligibleForCreate: boolean | null
  readonly eligibilityReason: string | null

  readonly billingParty: string | null
  readonly expectedSuratWhoPays: number | null
  readonly credentialRole: string | null
  readonly credentialResolved: boolean

  readonly preflightValid: boolean
  readonly wouldCallCarrier: boolean
  readonly blockers: readonly string[]
  /** Yakalanan istisnanın GERÇEK mesajı — yutulmaz. */
  readonly failureDetail: string | null

  readonly networkCalls: 0
  readonly dbWrites: 0
  readonly carrierCalls: 0
}

/**
 * Worker'ın taşıyıcıdan HEMEN ÖNCEKİ durumunu SALT-OKUNUR üretir.
 */
export async function preflightLabelJob(
  db: Db,
  params: { organizationId: string; packageId: string; marketplace?: string },
): Promise<LabelJobPreflight> {
  // ═══ TEK HAZIRLIK BORU HATTI ═══════════════════════════════════════
  //
  // Bu fonksiyon artik KENDI hazirligini YAPMAZ. Ayni `prepareLabelJob`
  // ciktisini worker, run-once ve aday secici de tuketir; boylece ayni
  // paket icin dort farkli gercek olusamaz.
  const { prepareLabelJob } = await import('./labelJobPreparation.ts')
  const prepared = await prepareLabelJob(db, params)

  const jobRows = await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.packageId, params.packageId),
      ),
    )
  const job = (jobRows as Record<string, unknown>[])[0] ?? null

  // Mevcut rapor sozlesmesi KORUNUR; alanlar hazirliktan turer.
  const blockers = prepared.blockers.map((code) => LEGACY_BLOCKER_LABELS[code] ?? code)
  // TESHIS AYRINTISI: desi cozulemedi mi, yoksa kiracida ayar hic yok mu?
  if (prepared.tenantDesi == null) blockers.push('TENANT_DESI_AYARLI_DEGIL')
  return {
    packageId: prepared.packageId,
    orderNumber: prepared.orderNumber,
    marketplace: prepared.marketplace,
    jobId: job ? String(job.id) : null,
    jobStatus: job ? String(job.status) : null,
    attemptCount: Number(job?.attemptCount ?? 0),
    tenantDesi: prepared.tenantDesi,
    multiplyByItemQuantity: prepared.multiplyByItemQuantity,
    orderLinesCount: prepared.orderLinesCount,
    resolvedDesi: prepared.resolvedDesi,
    desiSource: prepared.desiSource,
    suratBirimDesi: prepared.suratBirimDesi,
    marketplaceStatus: prepared.marketplaceStatus,
    eligibleForCreate: prepared.eligibleForCreate,
    eligibilityReason: prepared.eligibility?.reason ?? null,
    billingParty: prepared.billingParty,
    expectedSuratWhoPays: prepared.expectedWhoPays,
    credentialRole: prepared.credentialRole,
    credentialResolved: prepared.credentialSnapshot.resolved,
    preflightValid: prepared.ok,
    wouldCallCarrier: prepared.ok,
    blockers,
    failureDetail: prepared.failureDetail ?? prepared.errorSummary,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}
