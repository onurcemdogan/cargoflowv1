// TRENDYOL CANLI YANIT SINIRI — SÖZLEŞME KANITININ TEK DOĞUM YERİ.
//
// ═══ ÖLÇÜLEN AÇIK (ÜÇÜNCÜ TUR) ═══════════════════════════════════════════
//
// Markalı kanıt şunu kanıtlıyordu: "bu nesne fabrikamızdan geçti".
// Şunu KANITLAMIYORDU:  "bu yük gerçekten canlı Trendyol yanıtından geldi".
//
// Çünkü fabrika şu imzayı taşıyordu:
//
//     createTrendyolOrderContractEvidence(rawPayload, { origin: 'LIVE_...' })
//                                          ↑ rastgele    ↑ ÇAĞIRANIN YAZDIĞI
//                                            nesne         GÜVEN BAYRAĞI
//
// Yani herhangi bir iç çağıran, sağlayıcı-şekilli bir nesne uydurup yanına
// bir DİZGİ yazarak "doğrulanmış sözleşme" üretebiliyordu. `LIVE_PROVIDER_
// RESPONSE` bir OLGU değil, bir İDDİA idi.
//
// ═══ KÖK NEDEN ÇÖZÜMÜ ════════════════════════════════════════════════════
//
// `(yük, bayrak)` alan genel fabrika KALDIRILDI. Kanıtın TEK doğum yolu,
// gerçek HTTP yanıt ZARFINI alan ve gövdeyi KENDİSİ çözen bu sınırdır:
//
//   callTrendyolOrders → fetchTrendyolJson → HTTP yanıt
//                      → ingestTrendyolLiveOrderResponse(zarf)   ← BURASI
//                      → paket başına markalı kanıt
//
// Sınır şunları KENDİ ÖLÇER (çağıranın beyanına GÜVENMEZ):
//   · yanıt BAŞARILI mı (ok + 2xx)
//   · istek GERÇEKTEN v2 sipariş ucuna mı gitti (yol tek otoriteden sorulur)
//   · gövde JSON mu — ÇÖZÜMLENMİŞ NESNE KABUL EDİLMEZ, METİN ayrıştırılır
//   · paket dizisi var mı
//   · yük sağlayıcı ham paketi mi (forensic modül ölçer)
//
// ═══ DÜRÜST SINIR ════════════════════════════════════════════════════════
//
// Süreç içinde "gerçek ağ" ile "taklit taşıma katmanı" AYIRT EDİLEMEZ:
// `globalThis.fetch` değiştirilirse bu sınır da taklit yanıt görür. Zaten
// PROV-3 regresyonu tam olarak bunu kullanır. Kazanım şudur: güven artık
// ÇAĞRI YERİNDE yazılan bir dizge DEĞİLDİR; sahtecilik için süreç genelinde
// HTTP taşıma katmanını ele geçirmek gerekir. Bu fark gerçek ve ölçülebilir,
// ama "taklit edilemez" DEĞİLDİR ve öyle iddia EDİLMEZ.
//
// ═══ SINIFLANDIRMA BURADA YENİDEN YAZILMAZ ═══════════════════════════════
//
// Kimin ödediği kararı `inspectTrendyolBillingSource` içinde KALIR. Burada
// yapılan tek şey, o kararın KANIT SEVİYESİNİ yükseltmektir — ve bu yalnız
// forensic modül yükü zaten `PROVIDER_RAW` olarak ölçtüyse mümkündür.
// Normalize edilmiş bir kopya bu sınırdan geçse bile YÜKSELTİLMEZ.
import {
  inspectTrendyolBillingSource,
  type BillingEvidenceLevel,
  type BillingParty,
  type RawDataProvenance,
} from './suratBillingParty.ts'
import { isTrendyolOrdersV2Url } from '../marketplaces/trendyolOrdersEndpoint.ts'
import { extractPackageIdentityFields } from '../orders/trendyolPackageIdentityTrace.ts'

/**
 * SİPARİŞ SÖZLEŞMESİ KANITI — MARKALI, DIŞARIDAN ÜRETİLEMEZ.
 *
 * Marka `WeakSet` ile NESNEYE bağlanır: alanları kopyalamak (`{...kanit}`)
 * markayı TAŞIMAZ, çünkü kopya BAŞKA bir nesnedir. Serileştirme de markayı
 * taşımaz — kanıt DB'ye yazılıp geri okunamaz. Bu bir eksiklik değil, tam
 * olarak istenen şeydir: saklanan yük `UNVERIFIED_HISTORICAL_RAW` kalır.
 */
const TRUSTED_EVIDENCE = new WeakSet<object>()

export interface OrderContractEvidence {
  /** Hangi pakete ait — canlı yanıttan çözülen kimlik. */
  readonly packageId: string
  readonly billingParty: BillingParty
  /** Bu sınırdan çıkan kanıt DAİMA `CONFIRMED_PROVIDER_CONTRACT`tır. */
  readonly evidence: BillingEvidenceLevel
  /** Yükün gerçekte ne olduğu; bu sınırda DAİMA `PROVIDER_RAW`. */
  readonly provenance: RawDataProvenance
  /** Yorumlama metni — operatör yüzeyi için; karara GİRMEZ. */
  readonly interpretation: string
}

/** Kanıt GERÇEKTEN canlı yanıt sınırında mı doğdu. */
export function isTrustedOrderContractEvidence(value: unknown): boolean {
  return typeof value === 'object' && value !== null && TRUSTED_EVIDENCE.has(value)
}

/** Zarf neden kanıt üretmedi — sessiz başarısızlık YOK. */
export const LIVE_INGESTION_REJECTIONS = [
  'NOT_SUCCESSFUL_RESPONSE',
  'NOT_ORDERS_V2_ENDPOINT',
  'NOT_JSON_BODY',
  'NO_PACKAGE_ARRAY',
] as const
export type LiveIngestionRejection = (typeof LIVE_INGESTION_REJECTIONS)[number]

/**
 * GERÇEK HTTP YANIT ZARFI.
 *
 * `rawResponseText` ÇÖZÜMLENMİŞ NESNE DEĞİL, sağlayıcının döndüğü GÖVDE
 * METNİDİR. Sınır gövdeyi kendisi ayrıştırır; böylece çağıran "şu nesne
 * yanıttan çıktı" diye beyanda BULUNAMAZ.
 */
export interface TrendyolLiveOrderResponseEnvelope {
  ok: unknown
  statusCode: unknown
  requestUrl: unknown
  contentType: unknown
  rawResponseText: unknown
}

export interface TrendyolLiveOrderIngestion {
  accepted: boolean
  rejectionCode: LiveIngestionRejection | null
  /** Yanıtta görülen paket adedi. */
  packageCount: number
  /** Kanıt üretilen paket adedi (ham paket olmayanlar DIŞARIDA kalır). */
  evidenceCount: number
  evidenceByPackageId: Map<string, OrderContractEvidence>
}

function reject(code: LiveIngestionRejection): TrendyolLiveOrderIngestion {
  return {
    accepted: false,
    rejectionCode: code,
    packageCount: 0,
    evidenceCount: 0,
    evidenceByPackageId: new Map(),
  }
}

/** Trendyol sayfalı yanıt zarfı: `content[]` (v1 ile AYNI şekil). */
function packagesFromParsedBody(body: unknown): Record<string, unknown>[] | null {
  if (body === null || typeof body !== 'object') return null
  const content = (body as Record<string, unknown>).content
  if (!Array.isArray(content)) return null
  return content.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  )
}

/**
 * CANLI SİPARİŞ YANITI → PAKET BAŞINA MARKALI KANIT.
 *
 * Bu modülde kanıt üreten BAŞKA dışa açık yol YOKTUR.
 */
export function ingestTrendyolLiveOrderResponse(
  envelope: TrendyolLiveOrderResponseEnvelope,
): TrendyolLiveOrderIngestion {
  // (1) Yanıt GERÇEKTEN başarılı mı. `ok` tek başına yetmez; kod da ölçülür.
  const statusCode = Number(envelope?.statusCode)
  if (
    envelope?.ok !== true ||
    !Number.isFinite(statusCode) ||
    statusCode < 200 ||
    statusCode > 299
  ) {
    return reject('NOT_SUCCESSFUL_RESPONSE')
  }

  // (2) İstek GERÇEKTEN sipariş ucuna mı gitti. Yol tek otoriteden sorulur;
  //     burada elle regex yazmak yolu ikinci bir yere kopyalamak olurdu.
  if (!isTrendyolOrdersV2Url(envelope.requestUrl)) {
    return reject('NOT_ORDERS_V2_ENDPOINT')
  }

  // (3) Gövde JSON mu — METİN burada ayrıştırılır.
  const contentType = String(envelope.contentType ?? '').toLowerCase()
  const bodyText = typeof envelope.rawResponseText === 'string'
    ? envelope.rawResponseText
    : null
  if (bodyText === null || !bodyText.trim() || !contentType.includes('json')) {
    return reject('NOT_JSON_BODY')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return reject('NOT_JSON_BODY')
  }

  const packages = packagesFromParsedBody(parsed)
  if (packages === null) return reject('NO_PACKAGE_ARRAY')

  const evidenceByPackageId = new Map<string, OrderContractEvidence>()
  for (const rawPackage of packages) {
    // KİMLİK TÜRETİMİ KOPYALANMAZ: kalıcı `packageId` ile birebir
    // karşılaştırılabilir olsun diye üretimdeki tek türetici kullanılır.
    const identity = extractPackageIdentityFields(rawPackage)
    if (!identity.packageId) continue

    // KİMİN ÖDEDİĞİ KARARI BURADA VERİLMEZ — forensic modül verir.
    const inspection = inspectTrendyolBillingSource({ rawOrder: rawPackage })

    // SEVİYE YÜKSELTMESİ KOŞULLU: forensic modül yükü SAĞLAYICI HAM PAKETİ
    // olarak ölçmediyse, canlı sınırdan geçmiş olması bunu DEĞİŞTİRMEZ.
    // (Normalize edilmiş bir kopya bu uçtan dönmez; dönerse YÜKSELTİLMEZ.)
    if (
      inspection.rawPayloadAvailability !== 'AVAILABLE' ||
      inspection.provenance !== 'PROVIDER_RAW'
    ) {
      continue
    }

    const evidence: OrderContractEvidence = Object.freeze({
      packageId: identity.packageId,
      billingParty: inspection.billingParty,
      evidence: 'CONFIRMED_PROVIDER_CONTRACT' as BillingEvidenceLevel,
      provenance: inspection.provenance,
      interpretation: inspection.interpretation,
    })
    TRUSTED_EVIDENCE.add(evidence)
    evidenceByPackageId.set(identity.packageId, evidence)
  }

  return {
    accepted: true,
    rejectionCode: null,
    packageCount: packages.length,
    evidenceCount: evidenceByPackageId.size,
    evidenceByPackageId,
  }
}

/**
 * Sayfa/dilim birleştirmede kanıt haritalarının BİRLEŞİMİ.
 *
 * Birleştirme markayı ETKİLEMEZ: aynı nesneler taşınır, yenisi üretilmez.
 */
export function mergeOrderContractEvidence(
  ...maps: (Map<string, OrderContractEvidence> | null | undefined)[]
): Map<string, OrderContractEvidence> {
  const merged = new Map<string, OrderContractEvidence>()
  for (const map of maps) {
    if (!map) continue
    for (const [key, value] of map) merged.set(key, value)
  }
  return merged
}
