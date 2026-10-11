// WOOCOMMERCE BAĞLANTI SERVİSİ — ÇOK MAĞAZA, HESAP KAPSAMLI.
//
// ═══ ÇOK MAĞAZA NEDEN ÖZEL ═══════════════════════════════════════════════
//
// Trendyol modeli "bir pazaryeri = bir aktif hesap"tı ve `marketplace_
// accounts_single_active_unique` bunu DB'de zorluyordu. Bir organizasyon
// AYNI ANDA Woo Mağaza A + B + C bağlar; üçü de aktif kalmalıdır.
//
// Kısıt 0013 ile kaldırıldı. Trendyol'un tek-aktif garantisi DB'den DEĞİL,
// `resolveOrCreateActiveAccount` içindeki "kardeşleri pasifleştir" adımından
// gelir ve O ADIM DEĞİŞMEDİ. Woo bu fonksiyonu ÇAĞIRMAZ; kardeşlere
// DOKUNMAYAN kendi yolunu kullanır.
//
// ═══ KİMLİK: MAĞAZA URL'İ — SIR DEĞİL ════════════════════════════════════
//
// `providerAccountId` = normalize edilmiş mağaza kökü. `consumer_key`
// kimlik OLAMAZ: döndürülebilir (rotate) ve SIRDIR. Kimlik olsaydı anahtar
// yenilendiğinde mağaza "yeni hesap" görünür, geçmiş veri kopardı.
import {
  ensureAccount,
  getAccountByProviderAccountId,
  listAccounts,
  type MarketplaceAccount,
} from '../../integrations/marketplaceAccountRepository.ts'
import { storeFingerprint } from '../canonicalIdentity.ts'
import { assertStoreUrlAllowed } from '../storeUrlPolicy.ts'
import {
  deleteConnectorCredential,
  getConnectorCredential,
  saveConnectorCredential,
} from '../connectorCredentialStore.ts'
import {
  testWooConnection,
  type WooClientOptions,
  type WooErrorClass,
} from './wooClient.ts'
import { marketplaceAccounts } from '../../db/schema.ts'
import { and, eq } from 'drizzle-orm'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const WOO_PROVIDER_KEY = 'woocommerce'

/**
 * Kanonik mağaza kimliği.
 *
 * `storeFingerprint` KULLANILIR — ikinci normalleştirme algoritması
 * YAZILMAZ. Şu yazımların HEPSİ aynı mağazadır:
 *   https://shop.example.com · .../ · https://www.shop.example.com
 *   HTTPS://Shop.Example.COM/ · https://shop.example.com:443
 * Anlamlı alt yol AYRI mağazadır: https://example.com ≠ .../store
 */
export function wooProviderAccountId(storeUrl: string): string {
  const fingerprint = storeFingerprint({
    providerKey: WOO_PROVIDER_KEY,
    externalStoreId: storeUrl,
  })
  // `provider::store` → yalnız mağaza parçası hesap kimliğidir.
  return fingerprint.slice(`${WOO_PROVIDER_KEY}::`.length)
}

export const WOO_CONNECT_OUTCOMES = [
  'CONNECTED',
  'STORE_URL_REJECTED',
  'CONNECTION_FAILED',
  'ALREADY_CONNECTED',
] as const
export type WooConnectOutcome = (typeof WOO_CONNECT_OUTCOMES)[number]

export interface WooConnectResult {
  outcome: WooConnectOutcome
  errorClass: WooErrorClass | null
  message: string
  account: MarketplaceAccount | null
  providerAccountId: string | null
}

export interface WooConnectInput {
  organizationId: string
  storeUrl: string
  consumerKey: string
  consumerSecret: string
  webhookSecret?: string
  displayName?: string
}

/**
 * BAĞLANTIYI TEST ET VE KAYDET.
 *
 * Sıra KASITLIDIR:
 *   1) URL politikası (SSRF kapısı)
 *   2) GERÇEK kimlik doğrulamalı OKUMA (mutasyon yok)
 *   3) YALNIZ başarılı doğrulama sonrası hesap + sır kalıcılaşır
 *
 * Doğrulanmamış kimlik ASLA "yapılandırılmış" sayılmaz: sağlık tablosunda
 * yeşil görünen ama çalışmayan bağlantı, en kötü yalandır.
 */
export async function connectWooStore(
  db: Db,
  input: WooConnectInput,
  options: WooClientOptions,
): Promise<WooConnectResult> {
  const organizationId = String(input.organizationId ?? '').trim()
  if (organizationId === '') {
    throw new Error('organizationId zorunludur.')
  }

  // 1) SSRF KAPISI — ağ isteğinden ÖNCE.
  const decision = await assertStoreUrlAllowed(input.storeUrl, {
    ...(options.resolver ? { resolver: options.resolver } : {}),
  })
  if (!decision.ok) {
    return {
      outcome: 'STORE_URL_REJECTED',
      errorClass: 'STORE_URL_REJECTED',
      message: `Mağaza adresi kabul edilmedi (${decision.rejection}).`,
      account: null,
      providerAccountId: null,
    }
  }

  const providerAccountId = wooProviderAccountId(decision.normalizedUrl)

  // 2) GERÇEK doğrulama — başarısızsa HİÇBİR ŞEY kalıcılaşmaz.
  const test = await testWooConnection(
    {
      storeUrl: decision.normalizedUrl,
      consumerKey: String(input.consumerKey ?? ''),
      consumerSecret: String(input.consumerSecret ?? ''),
    },
    options,
  )
  if (!test.ok) {
    return {
      outcome: 'CONNECTION_FAILED',
      errorClass: test.errorClass,
      message: test.message,
      account: null,
      providerAccountId,
    }
  }

  // 3) Hesabı çöz/oluştur — KARDEŞ MAĞAZALARA DOKUNMADAN.
  //    `ensureAccount` aktiflik durumunu değiştirmez; Woo'da her mağaza
  //    kendi başına aktiftir.
  const account = await ensureAccount(
    db,
    organizationId,
    WOO_PROVIDER_KEY,
    providerAccountId,
  )
  const now = new Date()
  // Woo'da her mağaza KENDİ BAŞINA aktiftir: kardeşler PASİFLEŞTİRİLMEZ.
  // (Trendyol'un tek-aktif adımı `resolveOrCreateActiveAccount`ta kalır.)
  await db
    .update(marketplaceAccounts)
    .set({
      isActive: true,
      displayName: input.displayName ?? decision.host,
      updatedAt: now,
    })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, account.id),
      ),
    )

  await saveConnectorCredential(db, {
    organizationId,
    marketplaceAccountId: account.id,
    providerKey: WOO_PROVIDER_KEY,
    payload: {
      storeUrl: decision.normalizedUrl,
      consumerKey: String(input.consumerKey ?? ''),
      consumerSecret: String(input.consumerSecret ?? ''),
      ...(input.webhookSecret ? { webhookSecret: String(input.webhookSecret) } : {}),
    },
  })

  const refreshed = await getAccountByProviderAccountId(
    db,
    organizationId,
    WOO_PROVIDER_KEY,
    providerAccountId,
  )
  return {
    outcome: 'CONNECTED',
    errorClass: null,
    message: test.message,
    account: refreshed,
    providerAccountId,
  }
}

export const WOO_DISCONNECT_OUTCOMES = [
  /** Woo mağazası ayrıldı: kimlik silindi, hesap pasifleşti. */
  'DISCONNECTED',
  /**
   * Hesap YOK ya da bu kiracının Woo hesabı DEĞİL.
   *
   * Sağlayıcı uyuşmazlığı ile yokluk BİLEREK aynı yanıta çöker: "bu id
   * Trendyol'a ait" demek, saldırgana başka kiracının/sağlayıcının hesap
   * id'sini DOĞRULATIRDI.
   */
  'NOT_FOUND',
] as const
export type WooDisconnectOutcome = (typeof WOO_DISCONNECT_OUTCOMES)[number]

/**
 * Tek mağazayı ayırır.
 *
 * ═══ ÖLÇÜLEN KUSUR (YAMADAN ÖNCE YENİDEN ÜRETİLDİ) ════════════════════
 *
 * Bu fonksiyon YALNIZ `organization_id + marketplace_account_id` ile
 * pasifleştiriyordu; `marketplace = 'woocommerce'` ŞARTI YOKTU. Aynı
 * organizasyondaki bir çağıran, Woo disconnect ucuna TRENDYOL hesap
 * id'sini verip o hesabı KAPATABİLİYORDU (ölçüldü: `isActive true → false`).
 *
 * Kiracı kapsamı bu deliği KAPATMAZ: id aynı kiracınındır, sağlayıcısı
 * farklıdır. Kapsam denetiminin doğru ekseni SAĞLAYICIDIR.
 *
 * ═══ FAIL-CLOSED ══════════════════════════════════════════════════════
 *
 * Sahiplik MUTASYONDAN ÖNCE kanıtlanır. Kanıtlanamazsa HİÇBİR ŞEY
 * değişmez: ne kimlik silinir, ne hesap pasifleşir. Trendyol kimliği ve
 * durumu ASLA bu yoldan değiştirilemez.
 *
 * KARDEŞ mağazalar ETKİLENMEZ ve GEÇMİŞ İŞ VERİSİ SİLİNMEZ: kimlik
 * kaldırıldı diye sipariş geçmişi silinmez (geri bağlanınca veri lazımdır).
 */
export async function disconnectWooStore(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ outcome: WooDisconnectOutcome }> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') {
    throw new Error('organizationId ve marketplaceAccountId zorunludur.')
  }

  // 1) SAĞLAYICI + KİRACI SAHİPLİĞİ — MUTASYONDAN ÖNCE.
  const owned = await db
    .select({ id: marketplaceAccounts.id })
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, marketplaceAccountId),
        // BU SATIR DELİĞİ KAPATIR: yalnız WooCommerce hesapları.
        eq(marketplaceAccounts.marketplace, WOO_PROVIDER_KEY),
      ),
    )
    .limit(1)
  if (!owned[0]) {
    // HİÇBİR MUTASYON YAPILMADI.
    return { outcome: 'NOT_FOUND' }
  }

  // 2) Yalnız kanıtlandıktan sonra.
  await deleteConnectorCredential(db, {
    organizationId,
    marketplaceAccountId,
    providerKey: WOO_PROVIDER_KEY,
  })
  await db
    .update(marketplaceAccounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, marketplaceAccountId),
        // Yazma yüklemi de SAĞLAYICI KAPSAMLIDIR: okuma ile yazma arasında
        // kayma olsa bile yabancı sağlayıcı hesabı GÜNCELLENEMEZ.
        eq(marketplaceAccounts.marketplace, WOO_PROVIDER_KEY),
      ),
    )
  return { outcome: 'DISCONNECTED' }
}

export interface WooStoreView {
  marketplaceAccountId: string
  providerAccountId: string
  displayName: string | null
  isActive: boolean
  storeUrl: string | null
  consumerKeyMasked: string | null
  hasConsumerSecret: boolean
  hasWebhookSecret: boolean
}

/**
 * Kiracının Woo mağazaları — SIR TAŞIMAZ.
 *
 * `consumer_secret` ve webhook secret HİÇBİR ZAMAN dönmez; yalnız VARLIK
 * bildirilir (WOO-ACC-5).
 */
export async function listWooStores(
  db: Db,
  organizationId: string,
): Promise<WooStoreView[]> {
  const org = String(organizationId ?? '').trim()
  if (org === '') throw new Error('organizationId zorunludur.')
  const accounts = await listAccounts(db, org, WOO_PROVIDER_KEY)
  const views: WooStoreView[] = []
  for (const account of accounts) {
    const credential = await getConnectorCredential(db, {
      organizationId: org,
      marketplaceAccountId: account.id,
      providerKey: WOO_PROVIDER_KEY,
    })
    const consumerKey = String(credential?.payload.consumerKey ?? '')
    views.push({
      marketplaceAccountId: account.id,
      providerAccountId: account.providerAccountId,
      displayName: account.displayName ?? null,
      isActive: account.isActive,
      storeUrl: credential ? String(credential.payload.storeUrl ?? '') : null,
      consumerKeyMasked: consumerKey === '' ? null : `••••${consumerKey.slice(-4)}`,
      hasConsumerSecret: String(credential?.payload.consumerSecret ?? '') !== '',
      hasWebhookSecret: String(credential?.payload.webhookSecret ?? '') !== '',
    })
  }
  return views
}

/**
 * Webhook için hesap çözümleme — TAM OLARAK BİR hesap.
 *
 * Yönlendirme hesap kimliği ÜZERİNDEN yapılır; sağlayıcı geneli webhook
 * secret'i YOKTUR. A mağazasının teslimi B'yi asla okuyamaz/değiştiremez.
 */
export async function resolveWooWebhookAccount(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ account: MarketplaceAccount; webhookSecret: string | null } | null> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') return null
  const rows = await db
    .select()
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, marketplaceAccountId),
        eq(marketplaceAccounts.marketplace, WOO_PROVIDER_KEY),
      ),
    )
    .limit(1)
  const account = rows[0] as MarketplaceAccount | undefined
  if (!account) return null
  const credential = await getConnectorCredential(db, {
    organizationId,
    marketplaceAccountId,
    providerKey: WOO_PROVIDER_KEY,
  })
  const webhookSecret = String(credential?.payload.webhookSecret ?? '')
  return { account, webhookSecret: webhookSecret === '' ? null : webhookSecret }
}
