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
 * ikas/Ticimax `off`: sözleşmeleri doğrulandı, kod yolu YOK.
 *
 * Bu harita KONFİGÜRASYONDUR; sağlık sonucundan ETKİLENMEZ.
 */
export const ROLLOUT_STAGE_POLICY: Record<string, CapabilityStage> = {
  trendyol: 'ga',
  woocommerce: 'internal_test',
  ikas: 'off',
  ticimax: 'off',
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

/** Kayıt defterini kurar. Saf: DB/ağ YOK, yalnız dosya okuma. */
export function buildProviderCatalog(): ConnectorRegistry {
  const registry = new ConnectorRegistry()
  registry.register(trendyolDescriptor())
  for (const providerKey of Object.keys(CONTRACT_PACK_PATHS)) {
    registry.register(descriptorFromContractPack(providerKey))
  }
  return registry
}

export const HEALTH_SUPPORTED_PROVIDERS = [
  'trendyol', 'woocommerce', 'ikas', 'ticimax',
] as const
