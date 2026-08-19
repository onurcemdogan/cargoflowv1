// SÜRAT ENTEGRASYONU — TEK OTORİTER YÜKLEYİCİ.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// ÜRETİMDE ÖLÇÜLEN ÇELİŞKİ: kanarya otoriter birincil hesabı `****2622`
// gösterirken, aynı kiracı için canlı POST telde `****0944` kullandı. İki yol
// da "kiracı deposundan okuduğunu" söylüyordu, ama HANGİ kaydı okuduklarını
// KİMSE göremiyordu: ne organizasyon kimliği ne de kayıt kimliği hiçbir
// çıktıda yoktu. Bu yüzden ayrışmanın yeri KANITLANAMIYORDU.
//
// Bu modül tek yükleme yoludur ve okuduğu kaydın KİMLİĞİNİ döner. Kanarya ile
// canlı POST aynı alanları bastığı için `CANARY_INTEGRATION_ID` ile
// `LIVE_INTEGRATION_ID` artık DOĞRUDAN karşılaştırılabilir.
//
// ═══ SIR ═════════════════════════════════════════════════════════════════
// Ham kullanıcı adı/parola BASILMAZ; kimlikler yalnız maskeli döner. `store`
// sunucu içi kullanım içindir ve İSTEMCİYE GÖNDERİLMEZ.

import {
  getIntegrationCredentialRecord,
  type CredentialDb,
} from './credentialService.ts'
import { normalizeAuthoritativeSuratStore } from '../shipments/suratCredentialSnapshot.ts'

/** Kayıt yokken de karşılaştırılabilir olmalı — boş dize DEĞİL. */
export const INTEGRATION_ID_ABSENT = 'NONE'

/** Repo maske deyimi: son dört karakter. Ham kimlik ASLA basılmaz. */
export function maskRecordIdentifier(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return INTEGRATION_ID_ABSENT
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`
}

export interface ActiveSuratIntegration {
  /** Okumanın YAPILDIĞI organizasyon — maskeli. */
  organizationIdMasked: string
  /** Okunan `integration_credentials` satırı — maskeli. */
  integrationIdMasked: string
  /** Kayıt gerçekten var mıydı? */
  configured: boolean
  /** `normalizeAuthoritativeSuratStore` geçmiş depo — canlı yolla AYNI türev. */
  store: Record<string, unknown>
}

/**
 * Kiracının ETKİN Sürat entegrasyonu — tek yol, tek normalizasyon.
 *
 * Birden çok kayıt varsa `getIntegrationCredentialRecord` FAIL CLOSED atar;
 * burada yakalanmaz. Yanlış cariye gönderi açmaktansa deneme durmalıdır.
 */
export async function loadActiveSuratIntegrationForOrganization(
  db: CredentialDb,
  organizationId: string,
): Promise<ActiveSuratIntegration> {
  const record = await getIntegrationCredentialRecord(
    db, String(organizationId ?? ''), 'surat',
  )
  return {
    organizationIdMasked: maskRecordIdentifier(organizationId),
    integrationIdMasked: record
      ? maskRecordIdentifier(record.id)
      : INTEGRATION_ID_ABSENT,
    configured: Boolean(record),
    // Kayıt yoksa BOŞ depo döner; `null` yerine boş nesne, çağıranın
    // türetmeyi atlamasını engeller.
    store: normalizeAuthoritativeSuratStore(
      (record?.payload ?? {}) as Record<string, unknown>,
    ),
  }
}
