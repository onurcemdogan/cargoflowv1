// ENTEGRASYON SAĞLIĞI — ÇALIŞMA ZAMANI BAĞLANTISI.
//
// ═══ ÖLÇÜLEN EKSİK (YAMADAN ÖNCE YENİDEN ÜRETİLDİ) ═══════════════════════
//
// `loadIntegrationHealth` hesap kapsamlı kimlik varlığını KABUL EDİYORDU ama
// GERÇEK uç (`GET /api/integrations/health`) yalnız SAĞLAYICI GENELİ Trendyol
// varlığını besliyordu. Woo hesapları için varlık HİÇ türetilmiyordu.
//
// Sonuç ÖLÇÜLDÜ ve TERS ÇIKTI:
//   A mağazası (kimlik VAR, henüz senkron etmedi) → NOT_CONFIGURED
//   B mağazası (kimlik SİLİNDİ, geçmişte senkron etti) → CONNECTED + VALID
//
// Yani kimliği DURAN mağaza "kurulmadı", kimliği SİLİNEN mağaza "bağlı"
// görünüyordu. Depo testleri yeşilken ÜRÜN yalan söylüyordu.
//
// ═══ DÜZELTME ════════════════════════════════════════════════════════════
//
// Varlık, `connector_credentials` satırının VARLIĞINDAN türetilir:
//   satır var  → PRESENT
//   GERÇEK hesap var ama satır YOK → ABSENT
//   hesap yok  → anahtar HİÇ ÜRETİLMEZ (uydurma ABSENT YOK)
//
// Anahtar KANONİK `connectionKey` çıktısıdır: `woocommerce::<hesapId>`.
//
// SIR ÇÖZÜLMEZ: yalnız hesap kimliği kolonu okunur (`listAccountsWithCredential`).
// Varlık sorusunu yanıtlamak için AES zarfını açmak GEREKSİZ risktir.
//
// KARDEŞ SIZINTISI YOK: sağlayıcı geneli bir "Woo PRESENT" ÜRETİLMEZ; bir
// mağazanın kimliği silindiyse kardeşi duruyor diye "bağlı" görünemez.
//
// Trendyol semantiği DEĞİŞMEDİ: sağlayıcı geneli `configured` aynen geçer.
import { listAccounts } from '../integrations/marketplaceAccountRepository.ts'
import { getMaskedIntegrationStatus } from '../integrations/credentialService.ts'
import { listAccountsWithCredential } from './connectorCredentialStore.ts'
import { connectionKey, type CredentialPresence, type IntegrationHealth } from './integrationHealth.ts'
import { loadIntegrationHealth, toHealthView } from './integrationHealthRepository.ts'
import { buildProviderCatalog } from './providerCatalog.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/**
 * Kimliği HESAP BAZINDA tutan sağlayıcılar.
 *
 * Bu bir YETENEK BİLDİRİMİDİR, çağrı yerinde `if (provider === 'woo')`
 * dallanması DEĞİL. Trendyol/Sürat BURADA YOKTUR: onların kimliği
 * `integration_credentials` içinde SAĞLAYICI GENELİDİR ve semantikleri
 * değiştirilmez.
 */
export const ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS = ['woocommerce', 'ikas'] as const

/**
 * BAĞLANTI kapsamlı kimlik varlığı haritası.
 *
 * Yalnız GERÇEKTEN var olan hesaplar için anahtar üretir. Hesabı olmayan bir
 * sağlayıcı için anahtar yoktur → sağlık katmanı `UNKNOWN` der (uydurmaz).
 */
export async function loadAccountCredentialPresence(
  db: Db,
  params: { organizationId: string },
): Promise<Record<string, CredentialPresence>> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (organizationId === '') {
    // FAIL-CLOSED: kiracı kapsamı olmadan varlık OKUNMAZ.
    throw new Error('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  }
  const presence: Record<string, CredentialPresence> = {}
  for (const providerKey of ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS) {
    const [accounts, withCredential] = await Promise.all([
      listAccounts(db, organizationId, providerKey),
      listAccountsWithCredential(db, { organizationId, providerKey }),
    ])
    const credentialed = new Set(withCredential.map((id) => String(id)))
    for (const account of accounts) {
      const accountId = String((account as { id: unknown }).id)
      presence[connectionKey(providerKey, accountId)] = credentialed.has(accountId)
        ? 'PRESENT'
        : 'ABSENT'
    }
  }
  return presence
}

/**
 * ÜRÜN UCUNUN ÇAĞIRDIĞI TEK GİRİŞ.
 *
 * `server/index.mjs` KENDİ varlık haritasını KURMAZ; ikinci bir gerçek
 * üretmemek için bu fonksiyonu çağırır (kaynak taramasıyla kilitli).
 */
export async function loadIntegrationHealthForOrganization(
  db: Db,
  params: { organizationId: string; nowMs: number; resource?: string },
): Promise<IntegrationHealth[]> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (organizationId === '') {
    throw new Error('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  }
  const [masked, credentialsPresenceByConnection] = await Promise.all([
    getMaskedIntegrationStatus(db, organizationId),
    loadAccountCredentialPresence(db, { organizationId }),
  ])
  // KİMLİK VARLIĞI ÜÇ DURUMLUDUR. `configured` GÖZLENEBİLİR olduğunda
  // PRESENT/ABSENT'e çevrilir; gözlenemiyorsa UNKNOWN KALIR.
  const trendyolConfigured = masked?.trendyol?.configured
  return loadIntegrationHealth(db, {
    organizationId,
    ...(params.resource ? { resource: params.resource } : {}),
    credentialsPresenceByProvider: {
      trendyol:
        typeof trendyolConfigured === 'boolean'
          ? trendyolConfigured
            ? 'PRESENT'
            : 'ABSENT'
          : 'UNKNOWN',
    },
    // HESAP GERÇEĞİ SAĞLAYICI GENELİNİ EZER (öncelik sırası depoda).
    credentialsPresenceByConnection,
    nowMs: params.nowMs,
  })
}

/**
 * ÜRÜN UCUNUN TAM DAVRANIŞI — `GET /api/integrations/health`.
 *
 * Durum kodu eşlemesi ve güvenli projeksiyon BURADADIR; `server/index.mjs`
 * yalnız kiracı kapsamını çözer ve devreder. Uç davranışı satır içi kalsaydı
 * yine yalnız depo yardımcıları test edilebilirdi — bu kapanışın düzelttiği
 * kusur sınıfı TAM OLARAK BUYDU.
 *
 * Yanıt yalnız KARARLI sebep kodları taşır: ham sağlayıcı hatası, uç nokta
 * ve kimlik bilgisi ASLA dışarı çıkmaz.
 */
export async function handleIntegrationHealthRequest(params: {
  db: Db
  organizationId: string
  nowMs?: number
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const entries = await loadIntegrationHealthForOrganization(params.db, {
    organizationId: params.organizationId,
    nowMs: params.nowMs ?? Date.now(),
  })
  const catalog = buildProviderCatalog()
  return {
    httpStatus: 200,
    body: {
      ok: true,
      integrations: entries.map((entry) =>
        toHealthView(entry, catalog.get(entry.providerKey)?.displayName ?? entry.providerKey),
      ),
    },
  }
}
