// FATURALAMA BAŞARI SÖZLEŞMESİ — SAF MODEL, ÜRETİM DAVRANIŞI DEĞİŞTİRMEZ.
//
// BUGÜNKÜ TANIM: create "başarılı" sayılıyor çünkü T.No + barkod + artifact
// üretildi. ÖDEYEN TARAF hiç doğrulanmıyor. Yani yanlış cariye faturalanan bir
// gönderi bugün SESSİZ BAŞARI olarak kapanır.
//
// BU MODÜL bu boşluğu isimlendirir; hiçbir kod yolunu bağlamaz. Bağlama kararı
// (§12 enforcement) ayrı bir fazdır ve üretim davranışını değiştirir.
import type { BillingParty } from './suratBillingParty.ts'

/** Taşıyıcı create'in kendi sonucu — faturalamadan BAĞIMSIZ. */
export type CarrierCreateStatus = 'SUCCESS' | 'FAILED' | 'UNKNOWN'

/**
 * Operasyonun BİLEŞİK durumu. "Başarılı" tek bir kelime değildir: taşıyıcı
 * kaydı ile faturalama doğruluğu AYRI eksenlerdir.
 */
export const BILLING_OPERATION_OUTCOMES = [
  'OPERATION_FAILED',
  'OPERATION_SUCCESS_BILLING_UNKNOWN',
  'OPERATION_SUCCESS_BILLING_UNVERIFIED',
  'OPERATION_SUCCESS_BILLING_VERIFIED',
  'BILLING_MISMATCH',
] as const
export type BillingOperationOutcome = (typeof BILLING_OPERATION_OUTCOMES)[number]

export interface BillingOperationClassification {
  outcome: BillingOperationOutcome
  carrierCreateSuccess: boolean
  billingExpectationKnown: boolean
  billingActualVerified: boolean
  billingMatch: boolean | null
  /** Operatöre gösterilecek gerekçe. */
  reason: string
}

/**
 * BİLEŞİK SINIFLANDIRMA.
 *
 *   create FAILED                      → OPERATION_FAILED
 *   expected UNKNOWN                   → OPERATION_SUCCESS_BILLING_UNKNOWN
 *   expected bilinir, actual UNKNOWN   → OPERATION_SUCCESS_BILLING_UNVERIFIED
 *   expected == actual                 → OPERATION_SUCCESS_BILLING_VERIFIED
 *   expected != actual                 → BILLING_MISMATCH
 *
 * MISMATCH taşıyıcı create'i BAŞARISIZ SAYMAZ: gönderi gerçekten oluşmuştur.
 * Yanlış olan faturalama tarafıdır ve bu ayrı bir aksiyon gerektirir
 * (operasyonu geri almak değil, cariyi düzeltmek).
 */
export function classifyBillingOperationOutcome(params: {
  carrierCreateStatus: CarrierCreateStatus
  expectedBillingParty: BillingParty
  actualBillingParty: BillingParty
}): BillingOperationClassification {
  const carrierCreateSuccess = params.carrierCreateStatus === 'SUCCESS'
  const billingExpectationKnown = params.expectedBillingParty !== 'UNKNOWN'
  const billingActualVerified = params.actualBillingParty !== 'UNKNOWN'

  if (!carrierCreateSuccess) {
    return {
      outcome: 'OPERATION_FAILED',
      carrierCreateSuccess: false,
      billingExpectationKnown,
      billingActualVerified,
      billingMatch: null,
      reason: 'Taşıyıcı kaydı oluşmadı; faturalama sorusu henüz doğmadı.',
    }
  }
  if (!billingExpectationKnown) {
    return {
      outcome: 'OPERATION_SUCCESS_BILLING_UNKNOWN',
      carrierCreateSuccess: true,
      billingExpectationKnown: false,
      billingActualVerified,
      billingMatch: null,
      reason: 'Gönderi oluştu fakat BEKLENEN ödeyen taraf modellenemedi.',
    }
  }
  if (!billingActualVerified) {
    return {
      outcome: 'OPERATION_SUCCESS_BILLING_UNVERIFIED',
      carrierCreateSuccess: true,
      billingExpectationKnown: true,
      billingActualVerified: false,
      billingMatch: null,
      // BUGÜNKÜ ÜRETİM DURUMU TAM OLARAK BURASIDIR.
      reason:
        'Gönderi oluştu, beklenen taraf biliniyor, GERÇEK taraf doğrulanmadı.',
    }
  }
  const match = params.expectedBillingParty === params.actualBillingParty
  return {
    outcome: match ? 'OPERATION_SUCCESS_BILLING_VERIFIED' : 'BILLING_MISMATCH',
    carrierCreateSuccess: true,
    billingExpectationKnown: true,
    billingActualVerified: true,
    billingMatch: match,
    reason: match
      ? 'Beklenen ve gerçek ödeyen taraf UYUŞUYOR.'
      : 'Gönderi oluştu fakat YANLIŞ tarafa faturalandı.',
  }
}

/* ═══ ENFORCEMENT TASARIMI (§12) — HENÜZ BAĞLANMADI ══════════════════════ */

/**
 * ÖN-CREATE KAPISI MODLARI.
 *
 *   OFF                → bugünkü davranış; hiçbir şey engellenmez.
 *   CONTEXT_INTEGRITY  → yalnız faturalama bağlamı BOZUKSA engeller
 *                        (OzelKargoTakipNo/Pazaryerimi/EntegrasyonFirmasi).
 *                        Bu kural zaten `validateSuratBillingContext` ile
 *                        var; mod onu AÇIK bir politika hâline getirir.
 *   STRICT_EXPECTATION → create bağlamı beklenen tarafı GARANTİ edemiyorsa
 *                        engeller.
 *
 * STRICT_EXPECTATION'ın maliyeti ölçülmüştür ve küçük değildir: kanonik
 * gövdede ödeyen tarafı ifade eden HİÇBİR alan yoktur, dolayısıyla bu mod
 * bugün TÜM gönderileri bloklar. Operasyonu durdurmak, yanlış faturalamadan
 * daha büyük bir zarardır; bu yüzden önerilen varsayılan bu DEĞİLDİR.
 */
export const PRE_CREATE_GUARD_MODES = [
  'OFF',
  'CONTEXT_INTEGRITY',
  'STRICT_EXPECTATION',
] as const
export type PreCreateGuardMode = (typeof PRE_CREATE_GUARD_MODES)[number]

export interface PreCreateGuardDecision {
  decision: 'ALLOW' | 'BLOCK'
  mode: PreCreateGuardMode
  errorCode: string | null
  reason: string
}

export function evaluatePreCreateBillingGuard(params: {
  mode?: PreCreateGuardMode
  billingContextValid: boolean
  billingContextError?: string | null
  expectedBillingParty: BillingParty
  /** Create gövdesi ödeyen tarafı ifade edebiliyor mu (bugün: hayır). */
  createContextCanExpressBillingParty: boolean
}): PreCreateGuardDecision {
  const mode = params.mode ?? 'OFF'
  if (mode === 'OFF') {
    return {
      decision: 'ALLOW',
      mode,
      errorCode: null,
      reason: 'Kapı kapalı — bugünkü üretim davranışı korunur.',
    }
  }
  if (!params.billingContextValid) {
    return {
      decision: 'BLOCK',
      mode,
      errorCode:
        params.billingContextError ?? 'SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID',
      reason: 'Faturalama bağlamı geçersiz; gönderi oluşturulmamalı.',
    }
  }
  if (mode === 'CONTEXT_INTEGRITY') {
    return {
      decision: 'ALLOW',
      mode,
      errorCode: null,
      reason: 'Faturalama bağlamı bütün.',
    }
  }
  // STRICT_EXPECTATION
  if (params.expectedBillingParty === 'UNKNOWN') {
    return {
      decision: 'BLOCK',
      mode,
      errorCode: 'BILLING_EXPECTATION_UNKNOWN',
      reason: 'Beklenen ödeyen taraf bilinmiyor; sessiz yanlış fatura riski.',
    }
  }
  if (!params.createContextCanExpressBillingParty) {
    return {
      decision: 'BLOCK',
      mode,
      errorCode: 'BILLING_PARTY_NOT_EXPRESSIBLE',
      reason:
        'Create gövdesi ödeyen tarafı ifade edemiyor; garanti verilemez.',
    }
  }
  return {
    decision: 'ALLOW',
    mode,
    errorCode: null,
    reason: 'Beklenen taraf create bağlamında garanti edilebiliyor.',
  }
}

/**
 * ÖNERİLEN YAKLAŞIM — HİBRİT.
 *
 * Gerekçe: yanlış faturalamayı sessiz başarı saymamak ile operasyonu
 * durdurmamak aynı anda isteniyor. Tek başına ön-create bloğu bugün her
 * gönderiyi durdurur (kanonik gövdede payer alanı yok). Tek başına
 * create-sonrası doğrulama ise yanlış faturayı önlemez, yalnız görünür kılar
 * — ama görünür kılmak, sessiz kalmasından kesinlikle iyidir.
 *
 * Hibrit: bağlam bütünlüğü ön-create'te zorlanır (zaten var olan kural),
 * ödeyen taraf ise create sonrası salt-okunur doğrulanır ve uyuşmazlık
 * operasyonel bir durum olarak kaydedilir.
 *
 * ÖN KOŞUL: create-sonrası doğrulama getCargo sözleşmesini gerektirir; o
 * sözleşme henüz elde DEĞİLDİR. Bu yüzden hibrit bugün yarım çalışır ve
 * eksik yarısı gizlenmez.
 */
export const RECOMMENDED_ENFORCEMENT = 'HYBRID' as const

export const ENFORCEMENT_DESIGN = {
  preCreate: {
    mode: 'CONTEXT_INTEGRITY' as PreCreateGuardMode,
    blocks: ['SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID',
      'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING'],
    doesNotBlock: 'beklenen ödeyen taraf (gövde bunu ifade edemiyor)',
  },
  postCreate: {
    mode: 'READ_ONLY_VERIFY',
    requires: 'SURAT_GETCARGO_CONTRACT',
    onMismatch: 'BILLING_MISMATCH durumu + operatör uyarısı',
    doesNotDo: 'gönderiyi iptal etmez, baskıyı engellemez',
  },
} as const
