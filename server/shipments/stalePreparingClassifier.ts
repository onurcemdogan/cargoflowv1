// BAYAT `PREPARING` SINIFLANDIRICISI — TEK KURAL.
//
// ═══ ÜRETİM OLAYI (paket 4111289850) ═════════════════════════════════════
// Kontrollü kanarya betiği `sleep 90` sonrası PM2'yi KOŞULSUZ yeniden
// başlattı. Worker işi 22:40:09'da talep etmişti; 90 saniyelik pencere
// talepten ÖNCE başladığı için işe yalnız ~37 saniye kaldı ve süreç
// öldürüldü. Geriye şu kaldı:
//     label_jobs: status=PREPARING locked_by=918459@bd98248
//     shipment_operations: status=pending create_call_count=1
//                          carrier_create_called=false completed_at=NULL
//     shipments: 0 satır
//
// ═══ SAYAÇ ≠ TAŞIYICI ÇAĞRISI ════════════════════════════════════════════
// `create_call_count` AĞDAN ÖNCE, `IN_PROGRESS` rezervasyonunda artar
// (`executeIdempotentSuratCreate`). Yani "1" taşıyıcıya gidildiği anlamına
// GELMEZ; yalnız bir deneme REZERVE edildiğini söyler.
//
// `carrier_create_called` ise create DÖNDÜKTEN sonra
// `didSuratCreateReachCarrier(result)` ile yazılır. Ağ sınırının OTORİTER
// kanıtı BUDUR ve bu olayda `false`'tur.
//
// ═══ ZAMAN TEK BAŞINA İZİN DEĞİLDİR ══════════════════════════════════════
// Geçen süre yalnız KİLİDİN bayat olduğunu gösterir. Taşıyıcıya yeniden
// çıkma izni SADECE taşıyıcı kanıtından doğar. Eski `releaseStaleLocks`
// süreye bakıp `PREPARING → QUEUED` yapıyordu; ağı geçmiş bir iş için bu
// İKİNCİ FİZİKSEL GÖNDERİ demekti.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const STALE_VERDICTS = [
  'SAFE_STALE_PRE_NETWORK',
  'NETWORK_UNCERTAIN',
  'ALREADY_READY',
  'NOT_STALE',
  'DEPENDENCY_BLOCKED',
] as const
export type StaleVerdict = (typeof STALE_VERDICTS)[number]

export interface StaleEvidence {
  /** `label_jobs.status` */
  readonly status: string
  readonly lockedAt: Date | string | null
  readonly lockAgeMs: number | null
  readonly staleAfterMs: number
  /** OTORİTER: taşıyıcı ağına ÇIKILDI mı? */
  readonly carrierCreateCalled: boolean
  /** AĞDAN ÖNCE artan rezervasyon sayacı — çağrı kanıtı DEĞİL. */
  readonly createCallCount: number
  readonly carrierArtifactExists: boolean
  readonly readyLabelExists: boolean
  readonly unknownAfterNetworkEvidence: boolean
  /** Güncel paylaşılan hazırlık geçerli mi? */
  readonly preparationValid: boolean
}

export interface StaleClassification {
  readonly verdict: StaleVerdict
  readonly safeToRecover: boolean
  /** Kurtarma uygulanırsa işin geçeceği durum. */
  readonly targetStatus: 'QUEUED' | 'READY' | 'UNKNOWN_AFTER_NETWORK' | null
  readonly reason: string
}

/**
 * TEK SINIFLANDIRMA KURALI.
 *
 * `releaseStaleLocks` (worker turu) ve bayat kurtarma CLI'ı AYNI bu
 * fonksiyonu çağırır; ikinci bir yorum YOKTUR.
 */
export function classifyStalePreparing(
  evidence: StaleEvidence,
): StaleClassification {
  if (evidence.status !== 'PREPARING') {
    return {
      verdict: 'NOT_STALE',
      safeToRecover: false,
      targetStatus: null,
      reason: `İş PREPARING değil (${evidence.status}); bayat kurtarma konusu değil.`,
    }
  }

  // ── C) TAŞIYICI ARTEFAKTI VAR → UZLAŞTIR, CREATE YOK ────────────────
  //
  // Etiket zaten doğmuş; ikinci create MÜKERRER gönderi olurdu.
  if (evidence.readyLabelExists || evidence.carrierArtifactExists) {
    return {
      verdict: 'ALREADY_READY',
      safeToRecover: true,
      targetStatus: 'READY',
      reason: 'Taşıyıcı artefaktı/etiket mevcut; iş READY olarak uzlaştırılır, create YAPILMAZ.',
    }
  }

  // ── B) AĞ SINIRI GEÇİLMİŞ OLABİLİR → ASLA OTOMATİK TEKRAR ───────────
  //
  // `carrier_create_called` true ise taşıyıcı durumu DEĞİŞMİŞ olabilir.
  // Süre ne olursa olsun bu satır kuyruğa GERİ ALINMAZ.
  if (evidence.carrierCreateCalled || evidence.unknownAfterNetworkEvidence) {
    return {
      verdict: 'NETWORK_UNCERTAIN',
      safeToRecover: false,
      targetStatus: 'UNKNOWN_AFTER_NETWORK',
      reason: 'Taşıyıcı çağrısı kaydı var; sonuç belirsiz. Otomatik tekrar YAPILMAZ.',
    }
  }

  // ── KİLİT HÂLÂ CANLI ────────────────────────────────────────────────
  //
  // Süre YALNIZ kilidin bayatlığını belirler; izin vermez.
  const age = evidence.lockAgeMs
  if (age == null || age < evidence.staleAfterMs) {
    return {
      verdict: 'NOT_STALE',
      safeToRecover: false,
      targetStatus: null,
      reason: 'Kilit hâlâ canlı; iş başka bir worker tarafından işleniyor olabilir.',
    }
  }

  // ── A) AĞDAN ÖNCE ÖLDÜ ──────────────────────────────────────────────
  if (!evidence.preparationValid) {
    return {
      verdict: 'DEPENDENCY_BLOCKED',
      safeToRecover: false,
      targetStatus: null,
      reason: 'Taşıyıcıya çıkılmamış ama güncel hazırlık GEÇERSİZ; kuyruğa alınmaz.',
    }
  }
  return {
    verdict: 'SAFE_STALE_PRE_NETWORK',
    safeToRecover: true,
    targetStatus: 'QUEUED',
    reason:
      'Taşıyıcı çağrısı kanıtı YOK, artefakt YOK, kilit bayat ve hazırlık GEÇERLİ: '
      + 'aynı iş güvenle kuyruğa alınabilir.',
  }
}
