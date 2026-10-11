import { expect, test } from 'vitest'
import {
  presentIntegrationHealth,
  webhookSeverity,
  type IntegrationHealthViewModel,
} from '../integrations/integrationHealthView'

// ═══ INTEGRATION-HEALTH-001 — DÜRÜST KOPYA ══════════════════════════════
//
// Bu dosya iki YANLIŞ MESAJI yapısal olarak imkânsız kılar:
//
//   1) Kimlik bilgisi girilmiş diye "sağlıklı" demek
//   2) Sağlayıcının SUNMADIĞI özelliği kırmızı hata gibi göstermek
//
// İkincisi önemli: ikas webhook imzası resmî dokümanda yok, Ticimax webhook
// hiç sunmuyor. Bunlar kullanıcının düzeltebileceği şeyler DEĞİLDİR;
// aksiyon listesine girerlerse kullanıcı boş yere uğraşır.

function model(over: Partial<IntegrationHealthViewModel> = {}): IntegrationHealthViewModel {
  return {
    providerKey: 'trendyol',
    displayName: 'Trendyol',
    connection: 'CONNECTED',
    sync: 'HEALTHY',
    webhook: 'NOT_SUPPORTED',
    reconciliation: 'HEALTHY',
    rolloutStage: 'ga',
    overall: 'OPERATIONAL',
    lastSuccessfulSyncAt: '2026-09-19T09:00:00.000Z',
    attentionReasonCodes: [],
    ...over,
  }
}

test('IHC-1: calisan baglanti "Calisiyor" der ve AKSIYON istemez', () => {
  const view = presentIntegrationHealth(model())
  expect(view.headline).toBe('Çalışıyor')
  expect(view.severity).toBe('ok')
  expect(view.actionText).toBeNull()
  // Son senkron Istanbul saatiyle gosterilir (09:00Z → 12:00).
  const fact = view.facts.find((f) => f.label === 'Son başarılı senkron')
  expect(fact?.value).toContain('12:00')
})

test('IHC-2: HIC senkron edilmemis baglanti ASLA "saglikli" demez', () => {
  const view = presentIntegrationHealth(
    model({
      sync: 'NEVER_RUN',
      overall: 'DEGRADED',
      lastSuccessfulSyncAt: null,
      attentionReasonCodes: ['CREDENTIALS_NOT_PROVEN', 'AWAITING_FIRST_SYNC'],
    }),
  )
  expect(view.headline).not.toBe('Çalışıyor')
  expect(view.actionText).toBe('Bağlandı — ilk senkron bekleniyor.')
  expect(view.facts.find((f) => f.label === 'Senkron')?.value).toBe('Henüz senkron edilmedi')
  expect(view.facts.find((f) => f.label === 'Son başarılı senkron')?.value).toBe('Henüz yok')
})

test('IHC-3: DESTEKLENMEYEN webhook KIRMIZI degil, aksiyon da DEGIL', () => {
  for (const code of ['WEBHOOK_NOT_OFFERED_BY_PROVIDER', 'WEBHOOK_CONTRACT_NOT_VERIFIED']) {
    const view = presentIntegrationHealth(
      model({ webhook: 'NOT_SUPPORTED', attentionReasonCodes: [code] }),
    )
    expect(view.actionText).toBeNull()
    expect(view.severity).not.toBe('critical')
    expect(view.facts.find((f) => f.label === 'Güncelleme yöntemi')?.value).toBe('Periyodik kontrol')
  }
  expect(webhookSeverity('NOT_SUPPORTED')).toBe('info')
  expect(webhookSeverity('UNKNOWN')).toBe('info')
  expect(webhookSeverity('NOT_CONFIGURED')).toBe('info')
  // Gercekten bozuk olan durumlar UYARI verir.
  expect(webhookSeverity('DEGRADED')).toBe('warning')
  expect(webhookSeverity('DISABLED')).toBe('warning')
  expect(webhookSeverity('HEALTHY')).toBe('ok')
})

test('IHC-4: kimlik reddi EN ONCELIKLI aksiyondur', () => {
  const view = presentIntegrationHealth(
    model({
      connection: 'DISCONNECTED',
      sync: 'FAILED',
      overall: 'ACTION_REQUIRED',
      lastSuccessfulSyncAt: null,
      attentionReasonCodes: ['SYNC_STALE', 'SYNC_FAILED', 'CREDENTIALS_REJECTED'],
    }),
  )
  expect(view.severity).toBe('critical')
  expect(view.actionText).toBe('Kimlik doğrulama gerekli — bilgileri güncelleyin.')
})

test('IHC-5: "acilmadi" ile "bozuk" AYRI gorunur', () => {
  const off = presentIntegrationHealth(
    model({ providerKey: 'woocommerce', rolloutStage: 'off', overall: 'DISABLED', attentionReasonCodes: ['ROLLOUT_OFF'] }),
  )
  expect(off.headline).toBe('Henüz açılmadı')
  expect(off.severity).toBe('muted')
  expect(off.actionText).toBeNull()
  expect(off.stageText).toBe('Kapalı')

  const broken = presentIntegrationHealth(
    model({ overall: 'ACTION_REQUIRED', attentionReasonCodes: ['SYNC_FAILED'] }),
  )
  expect(broken.severity).toBe('critical')
  expect(broken.headline).not.toBe(off.headline)
})

test('IHC-6: sunum katmani HAM saglayici metni TASIMAZ', () => {
  const view = presentIntegrationHealth(
    model({
      attentionReasonCodes: ['SYNC_FAILED', 'Bearer sk_live_SECRET https://shop.example.com'],
      overall: 'ACTION_REQUIRED',
    }),
  )
  const serialized = JSON.stringify(view)
  for (const secret of ['sk_live_SECRET', 'shop.example.com', 'Bearer']) {
    expect(serialized).not.toContain(secret)
  }
  // Bilinmeyen kod aksiyon URETMEZ (sozluge bagli).
  const unknownOnly = presentIntegrationHealth(
    model({ attentionReasonCodes: ['Bearer sk_live_SECRET'] }),
  )
  expect(unknownOnly.actionText).toBeNull()
})

test('IHC-7: yayin asamasi HER ZAMAN gorunur', () => {
  const stages: [string, string][] = [
    ['off', 'Kapalı'],
    ['internal_test', 'İç test'],
    ['shadow', 'Gölge mod'],
    ['pilot', 'Pilot'],
    ['ga', 'Aktif'],
  ]
  for (const [stage, text] of stages) {
    expect(presentIntegrationHealth(model({ rolloutStage: stage })).stageText).toBe(text)
  }
})

// ═══ INTEGRATION-HEALTH-001A — ÇOK HESAPLI GÖSTERİM ═════════════════════
//
// Aynı sağlayıcının iki mağazası AYRI satır olarak görünmeli. Kusur
// düzeltilmeden önce ikisi tek karta çöküyor ve sağlıklı mağaza, kimlik
// hatası olanın arkasında görünmez oluyordu.

test('IHA-14: ayni saglayicinin iki baglantisi AYRI satir olarak sunulur', () => {
  const store1 = presentIntegrationHealth(
    model({
      providerKey: 'woocommerce',
      displayName: 'WooCommerce',
      marketplaceAccountId: 'aaaaaaaa-1111-4111-8111-111111111111',
      connectionScope: 'account',
      connectionKey: 'woocommerce::aaaaaaaa-1111-4111-8111-111111111111',
      connectionLabel: 'WooCommerce · aaaaaaaa',
      sync: 'HEALTHY',
      overall: 'OPERATIONAL',
    }),
  )
  const store2 = presentIntegrationHealth(
    model({
      providerKey: 'woocommerce',
      displayName: 'WooCommerce',
      marketplaceAccountId: 'bbbbbbbb-2222-4222-8222-222222222222',
      connectionScope: 'account',
      connectionKey: 'woocommerce::bbbbbbbb-2222-4222-8222-222222222222',
      connectionLabel: 'WooCommerce · bbbbbbbb',
      connection: 'DISCONNECTED',
      sync: 'FAILED',
      overall: 'ACTION_REQUIRED',
      lastSuccessfulSyncAt: null,
      attentionReasonCodes: ['CREDENTIALS_REJECTED'],
    }),
  )

  // AYRI kimlik, AYRI baslik, AYRI durum.
  expect(store1.connectionKey).not.toBe(store2.connectionKey)
  expect(store1.title).not.toBe(store2.title)
  expect(store1.headline).toBe('Çalışıyor')
  expect(store2.headline).toBe('İşlem gerekli')
  expect(store1.actionText).toBeNull()
  expect(store2.actionText).toBe('Kimlik doğrulama gerekli — bilgileri güncelleyin.')

  // Saglikli magaza GORUNUR kalir — bozuk olanin arkasinda kaybolmaz.
  expect(store1.facts.find((f) => f.label === 'Senkron')?.value).toBe('Güncel')
  expect(store2.facts.find((f) => f.label === 'Senkron')?.value).toBe('Başarısız')

  // React listesi icin anahtar SAGLAYICI DEGIL BAGLANTI olmali.
  const keys = new Set([store1, store2].map((s) => s.connectionKey))
  expect(keys.size).toBe(2)
})

test('IHA-14c: baglanti etiketi kimlik DEGILDIR, kanonik kimlik hesap idsidir', () => {
  const withoutLabel = presentIntegrationHealth(
    model({
      providerKey: 'woocommerce',
      displayName: 'WooCommerce',
      marketplaceAccountId: 'cccccccc-3333-4333-8333-333333333333',
    }),
  )
  // Etiket verilmediyse saglayici adina duser AMA kimlik korunur.
  expect(withoutLabel.title).toBe('WooCommerce')
  expect(withoutLabel.marketplaceAccountId).toBe('cccccccc-3333-4333-8333-333333333333')
  expect(withoutLabel.connectionKey).toBe(
    'woocommerce::cccccccc-3333-4333-8333-333333333333',
  )
  // Hesapsiz (legacy) baglanti sahte id ALMAZ.
  const legacy = presentIntegrationHealth(model({ providerKey: 'ikas', displayName: 'ikas' }))
  expect(legacy.marketplaceAccountId).toBeNull()
  expect(legacy.connectionKey).toBe('ikas::legacy')
})

// ═══ INTEGRATION-HEALTH-001B — KALDIRILMIŞ KİMLİK KOPYASI ════════════════

test('IHB-UI: kimlik KALDIRILMIS baglanti "saglikli" demez, dogru aksiyonu verir', () => {
  const removed = presentIntegrationHealth(
    model({
      providerKey: 'woocommerce',
      displayName: 'WooCommerce',
      connection: 'NOT_CONFIGURED',
      overall: 'NOT_CONFIGURED',
      // Gecmiste basarili senkron VARDI ama kimlik SIMDI YOK.
      lastSuccessfulSyncAt: '2026-09-18T09:00:00.000Z',
      attentionReasonCodes: ['CREDENTIALS_ABSENT', 'NOT_CONFIGURED'],
    }),
  )
  expect(removed.headline).not.toBe('Çalışıyor')
  expect(removed.headline).toBe('Bağlantı kurulmadı')
  // Kaldirilmis kimlik, "hic kurulmamis"tan DAHA KESIN bir mesaj alir.
  expect(removed.actionText).toBe('Kimlik bilgisi kaldırılmış — bağlantıyı yeniden kurun.')

  // Hic kurulmamis baglanti FARKLI mesaj alir.
  const neverConfigured = presentIntegrationHealth(
    model({
      connection: 'NOT_CONFIGURED',
      overall: 'NOT_CONFIGURED',
      lastSuccessfulSyncAt: null,
      attentionReasonCodes: ['NOT_CONFIGURED'],
    }),
  )
  expect(neverConfigured.actionText).toBe('Bağlantıyı kurmak için bilgileri girin.')
  expect(neverConfigured.actionText).not.toBe(removed.actionText)
})
