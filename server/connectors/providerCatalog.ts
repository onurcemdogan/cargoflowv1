// SAĞLAYICI KATALOĞU — yetenek gerçeğinin TEK kaynağı.
//
// Yetenekler İKİ yerden gelir ve İKİSİ DE koddur, tahmin değil:
//
//   · Yeni sağlayıcılar → `providers/<ad>/contracts/*.json` (resmî sözleşme
//     paketleri, 99789c7). Dosya neyi doğruladıysa o.
//   · Trendyol → ÜRETİMDE KANITLANMIŞ davranış. Sözleşme paketi yoktur çünkü
//     yetenek iddiası dokümandan değil, çalışan üretim yolundan gelir.
//
// YAYIN AŞAMASI (rolloutStage) SAĞLIKTAN AYRIDIR: burada politika olarak
// tanımlanır, sağlık çözümleyicisi onu YALNIZ OKUR ve ASLA İLERLETMEZ.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { N11_EPOCH_VERIFICATION } from '../marketplaces/n11/n11EpochSemantics.ts'
import {
  declareCapability,
  ConnectorRegistry,
  type CapabilityStage,
  type ConnectorDescriptor,
  type ConnectorCapability,
} from './connectorKernel.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const CONTRACT_PACK_PATHS: Record<string, string> = {
  woocommerce: 'providers/woocommerce/contracts/wc-v3.json',
  ikas: 'providers/ikas/contracts/admin-v1.json',
  ticimax: 'providers/ticimax/contracts/siparisservis-v1.json',
}

/**
 * YAYIN AŞAMASI POLİTİKASI.
 *
 * Trendyol `ga`dır çünkü ÜRETİMDE ÇALIŞIYOR.
 *
 * WooCommerce `internal_test`tir (WOOCOMMERCE-001): bağlayıcı GERÇEKTEN
 * uygulandı — SSRF kapısı, hesap kapsamlı şifreli kimlikler, wc/v3 okuma,
 * sayfalama, sözleşmeye sadık normalleştirme, ham gövde imza doğrulaması ve
 * dayanıklı gelen kutusu. AMA canlı doğrulama YAPILMADI (gerçek kiracı
 * kimliği yok) ve `internal_test` `stageAffectsLiveBehavior` tarafından
 * CANLI SAYILMAZ: kanonik sipariş yazımı ve karşılama yan etkileri
 * `liveWriteGate` ile KAPALIDIR. `pilot`/`ga` AYRI bir bilettir.
 *
 * ikas `internal_test`tir (IKAS-001): OAuth2 client_credentials, merchant.id
 * kimliği, çok mağaza, hesap kapsamlı şifreli kimlik, yalnız-okuma sipariş
 * mutabakatı (`updatedAt`). Canlı doğrulama YAPILMADI; webhook imzası
 * belgelenmediği için webhook YOK. `internal_test` canlı davranışı
 * ETKİLEMEZ: kanonik yazım ve karşılama yan etkileri `liveWriteGate` ile
 * KAPALIDIR.
 *
 * Ticimax `off`: sözleşme paketi ve iskelet bağlayıcı (`server/connectors/ticimax/`)
 * var olabilir, ama SelectSiparis tel sözleşmesi doğrulanana ve canlı probe
 * geçene kadar yayın aşaması `off` kalır. İskelet tek başına `pilot`/`ga`
 * (veya sessizce `internal_test`) YAPMAZ.
 *
 * Hepsiburada `internal_test`tir (HEPSIBURADA-LIVE-001): resmî sözleşme
 * (Basic auth, `-sit` host kuralı, offset/limit + begindate/enddate, 429 +
 * X-RateLimit-*, paket modeli) uygulandı; hesap kapsamlı şifreli kimlik,
 * yalnız-okuma elle senkron. Uç nokta YOLLARI ve liste zarfı resmî olarak
 * kanıtlanmadı (yapılandırmadan gelir) ve canlı doğrulama YAPILMADI —
 * karşılama yan etkileri `liveWriteGate` ile KAPALIDIR. Hesap doğrulaması
 * yalnız accountOrdersRead beyanı üzerinden kanonik okumayı açabilir.
 *
 * n11 `internal_test`tir (N11-LIVE-001): resmî sözleşme (shipmentPackages,
 * appkey/appsecret başlıkları, 0-tabanlı page + size ≤ 100 + totalPages,
 * 15 günlük pencere, `content` zarfı) uygulandı; hesap kapsamlı şifreli kimlik,
 * yalnız-okuma elle senkron. Canlı doğrulama YAPILMADI (gerçek hesap yok) —
 * karşılama `liveWriteGate` ile KAPALIDIR; pazaryeri yazması YOK. Hesap
 * doğrulaması yalnız kanonik okumayı açar; üretim zaman sınırı ayrı engeldir.
 *
 * Bu harita KONFİGÜRASYONDUR; sağlık sonucundan ETKİLENMEZ.
 */
export const ROLLOUT_STAGE_POLICY: Record<string, CapabilityStage> = {
  trendyol: 'ga',
  woocommerce: 'internal_test',
  ikas: 'internal_test',
  ticimax: 'off',
  hepsiburada: 'internal_test',
  n11: 'internal_test',
}

export function resolveRolloutStage(providerKey: string): CapabilityStage {
  return ROLLOUT_STAGE_POLICY[String(providerKey).toLowerCase()] ?? 'off'
}

function descriptorFromContractPack(providerKey: string): ConnectorDescriptor {
  const raw = readFileSync(join(repoRoot, CONTRACT_PACK_PATHS[providerKey]), 'utf8')
  const pack = JSON.parse(raw) as {
    PROVIDER_KIND: ConnectorDescriptor['kind']
    DISPLAY_NAME: string
    CAPABILITIES: Record<string, {
      supported?: boolean
      contractVerified?: boolean
      stage?: CapabilityStage
      reason?: string
    }>
  }
  return {
    providerKey,
    kind: pack.PROVIDER_KIND,
    displayName: pack.DISPLAY_NAME,
    capabilities: Object.entries(pack.CAPABILITIES).map(([name, decl]) =>
      declareCapability(name as ConnectorCapability, {
        supported: decl.supported ?? false,
        contractVerified: decl.contractVerified ?? false,
        stage: decl.stage ?? 'off',
        ...(decl.reason ? { reason: decl.reason } : {}),
      }),
    ),
  }
}

/**
 * TRENDYOL — üretimde kanıtlanmış yetenekler.
 *
 * `orders.webhook` DESTEKLENMİYOR: bu depodaki Trendyol senkronu kontrol
 * noktalı YOKLAMADIR (`syncWindowPolicy` + `lastSuccessfulSyncAt` imleci).
 * Bu bir kusur değil, mevcut mimarinin gerçeğidir; sağlıkta KIRMIZI
 * gösterilmemesi için `supported:false` + `contractVerified:true` beyan
 * edilir — yani "sunulmuyor" olduğu KESİN.
 */
function trendyolDescriptor(): ConnectorDescriptor {
  return {
    providerKey: 'trendyol',
    kind: 'marketplace',
    displayName: 'Trendyol',
    capabilities: [
      declareCapability('orders.read', { stage: 'ga' }),
      declareCapability('orders.webhook', {
        supported: false,
        contractVerified: true,
        reason: 'Bu entegrasyonda sipariş akışı kontrol noktalı yoklamadır.',
      }),
      declareCapability('orders.status.write', {
        supported: false,
        contractVerified: true,
        reason: 'Pazaryeri yazmaları global olarak kapalıdır.',
      }),
      declareCapability('products.read', { stage: 'ga' }),
    ],
  }
}

/**
 * HEPSIBURADA — yalnız-okuma sipariş/paket bağlayıcısı (iç test).
 *
 * `orders.read` sözleşmesi resmî kaynakla doğrulandı (yol hariç; yol
 * yapılandırmadan gelir). Webhook ve pazaryeri yazması SUNULMUYOR.
 */
function hepsiburadaDescriptor(): ConnectorDescriptor {
  return {
    providerKey: 'hepsiburada',
    kind: 'marketplace',
    displayName: 'Hepsiburada',
    accountOrdersRead: {
      fingerprintFields: ['merchantId', 'username', 'password', 'host', 'ordersPath', 'packagesPath', 'listField'],
      requiredCredentialFields: ['merchantId', 'username', 'password', 'host'],
      requiredEndpointFields: ['ordersPath', 'packagesPath'],
    },
    capabilities: [
      declareCapability('orders.read', { stage: 'internal_test' }),
      declareCapability('orders.webhook', {
        supported: false,
        contractVerified: true,
        reason: 'Hepsiburada okuması kullanıcı tetiklemeli yoklamadır.',
      }),
      declareCapability('orders.status.write', {
        supported: false,
        contractVerified: true,
        reason: 'Pazaryeri yazmaları global olarak kapalıdır.',
      }),
    ],
  }
}

/**
 * N11 — yalnız-okuma sipariş/paket bağlayıcısı (iç test).
 *
 * `orders.read` resmî sözleşmeyle doğrulandı. Pazaryeri statü yazması
 * CargoFlow politikasıyla KAPALIDIR. Webhook desteği kanıtlanmadığı için
 * BEYAN EDİLMEZ (ne var ne yok denir).
 */
function n11Descriptor(): ConnectorDescriptor {
  return {
    providerKey: 'n11',
    kind: 'marketplace',
    displayName: 'n11',
    accountOrdersRead: {
      // Learned seller metadata is not a credential change.
      fingerprintFields: ['appKey', 'appSecret'],
      requiredCredentialFields: ['appKey', 'appSecret'],
      checkpointBlocker: N11_EPOCH_VERIFICATION.reasonCode,
    },
    capabilities: [
      declareCapability('orders.read', { stage: 'internal_test' }),
      declareCapability('orders.status.write', {
        supported: false,
        contractVerified: true,
        reason: 'Pazaryeri yazmaları global olarak kapalıdır.',
      }),
    ],
  }
}

/** Kayıt defterini kurar. Saf: DB/ağ YOK, yalnız dosya okuma. */
export function buildProviderCatalog(): ConnectorRegistry {
  const registry = new ConnectorRegistry()
  registry.register(trendyolDescriptor())
  registry.register(hepsiburadaDescriptor())
  registry.register(n11Descriptor())
  for (const providerKey of Object.keys(CONTRACT_PACK_PATHS)) {
    registry.register(descriptorFromContractPack(providerKey))
  }
  return registry
}

export const HEALTH_SUPPORTED_PROVIDERS = [
  'trendyol', 'woocommerce', 'ikas', 'ticimax', 'hepsiburada', 'n11',
] as const
