// TANITIM SAYFASI İÇERİĞİ — YALNIZ BUGÜNKÜ DOĞRU.
//
// Kurallar (testle kilitli):
//   · Entegrasyonlar GERÇEK durumlarıyla anılır. Yalnız üretimde kullanılanlar
//     "Canlı" etiketi taşır: Trendyol (pazaryeri) ve Sürat Kargo. WooCommerce,
//     ikas ve Aras `internal_test`; Hepsiburada, n11 ve Ticimax geliştirme
//     aşamasındadır — bunlar "mevcut/canlı" gibi GÖSTERİLMEZ ve entegrasyon
//     bölümü DIŞINDA anılmaz.
//   · Resmî iş ortaklığı / partnerlik iddiası YOK.
//   · Herkese açık kayıt YOK (üretimde kapalı) → kayıt/deneme çağrısı YOK.
//   · Kamuya açık fiyat YOK → fiyat bölümü YOK.
//   · Uydurma müşteri sayısı, referans, oran veya sertifika YOK.
//   · "Tam otomatik / hatasız / her yazıcıda" gibi iddialar YOK.
//   · Ürün sahnesindeki her değer TEMSİLİDİR ("örnek" olarak etiketlenir).

export const LANDING_HERO = {
  eyebrow: 'Türkiye e-ticaret operasyonları için',
  headline: 'Siparişten kargo etiketine tek operasyon akışı.',
  /** Masaüstü satır kırılımı (görsel); erişilebilir ad `headline` ile AYNIDIR. */
  headlineLines: ['Siparişten kargo', 'etiketine tek', 'operasyon akışı.'],
  body:
    'Pazaryeri siparişlerinizi, kargo gönderilerinizi ve etiket baskınızı tek panelde yönetin. CargoFlow her gönderiyi siparişin atandığı kargo akışıyla oluşturur ve bağlantılarınızın durumunu görünür tutar.',
  assurances: [
    'Organizasyon bazında ayrılmış veri',
    'Hesap bazında saklanan bağlantı bilgileri',
    'Etiketi panelden tekrar yazdırma',
  ],
} as const

export type IntegrationStatus = 'live' | 'internal_test' | 'in_development'

export const INTEGRATION_STATUS_LABEL: Record<IntegrationStatus, string> = {
  live: 'Canlı',
  internal_test: 'İç test',
  in_development: 'Geliştiriliyor',
}

export const INTEGRATION_STATUS_HELP: Record<IntegrationStatus, string> = {
  live: 'Üretimde kullanılıyor.',
  internal_test: 'Bağlantı altyapısı hazır; canlı sipariş ve gönderi akışına henüz açılmadı.',
  in_development: 'Bağlantı altyapısı üzerinde çalışılıyor.',
}

export interface LandingIntegration {
  readonly name: string
  readonly group: 'commerce' | 'carrier'
  readonly kind: string
  readonly status: IntegrationStatus
}

/** Ürünün GERÇEK entegrasyon kapsamı — durumlar `providerCatalog` ile hizalı. */
export const LANDING_INTEGRATIONS: readonly LandingIntegration[] = [
  { name: 'Trendyol', group: 'commerce', kind: 'Pazaryeri', status: 'live' },
  { name: 'WooCommerce', group: 'commerce', kind: 'E-ticaret sitesi', status: 'internal_test' },
  { name: 'ikas', group: 'commerce', kind: 'E-ticaret sitesi', status: 'internal_test' },
  { name: 'Hepsiburada', group: 'commerce', kind: 'Pazaryeri', status: 'in_development' },
  { name: 'n11', group: 'commerce', kind: 'Pazaryeri', status: 'in_development' },
  { name: 'Ticimax', group: 'commerce', kind: 'E-ticaret sitesi', status: 'in_development' },
  { name: 'Sürat Kargo', group: 'carrier', kind: 'Kargo', status: 'live' },
  { name: 'Aras Kargo', group: 'carrier', kind: 'Kargo', status: 'internal_test' },
]

/** Sipariş → Kargo → Etiket → Takip. */
export const LANDING_WORKFLOW = [
  {
    stage: 'Sipariş',
    title: 'Siparişler panele gelir',
    body: 'Bağlı pazaryeri hesaplarındaki siparişler senkronize edilir; her sipariş geldiği hesapla birlikte saklanır.',
  },
  {
    stage: 'Kargo',
    title: 'Gönderi bilgisi doğrulanır',
    body: 'Kargo ataması, desi ve alıcı bilgisi kontrol edilir. Eksik ya da çelişkili bilgi işlemden önce görünür.',
  },
  {
    stage: 'Etiket',
    title: 'Gönderi ve etiket oluşur',
    body: 'Gönderi atanan kargo firmasında oluşturulur; etiket önizlenir, yazdırılır ve tekrar yazdırmak için saklanır.',
  },
  {
    stage: 'Takip',
    title: 'Operasyon görünür kalır',
    body: "Bekleyen işler, kargo durumları ve bağlantı sağlığı Dashboard'da tek yerde izlenir.",
  },
] as const

/** Ürün modülleri — her biri uygulamada BUGÜN var olan bir ekrana karşılık gelir. */
export const LANDING_CAPABILITIES = [
  {
    icon: 'orders',
    title: 'Siparişler',
    body: 'Statü, kargo, tarih ve arama filtreleri; toplu seçim ve sipariş detayı.',
  },
  {
    icon: 'label',
    title: 'Etiketler',
    body: 'Şablon düzenleme, önizleme; tarayıcıdan ya da ZPL ile baskı ve tekrar yazdırma.',
  },
  {
    icon: 'route',
    title: 'Kargo yönlendirme',
    body: 'Gönderi, siparişin atandığı kargo firmasının akışına gider; belirsiz atamada işlem durur.',
  },
  {
    icon: 'health',
    title: 'Entegrasyon sağlığı',
    body: 'Hesap bazında senkron durumu, son başarılı senkron ve bağlantı bilgisi kontrolü.',
  },
  {
    icon: 'catalog',
    title: 'Katalog',
    body: 'Ürün ve varyantları arayın, filtreleyin; kataloğu satış kanalıyla senkronize edin.',
  },
  {
    icon: 'organization',
    title: 'Organizasyon ve abonelik',
    body: 'Organizasyon bazlı kullanıcılar, plan durumu ve bağlı hesapların yönetimi.',
  },
] as const

export const LANDING_CONTROL_POINTS = [
  {
    icon: 'organization',
    title: 'Organizasyon verisi ayrı',
    body: 'Siparişler, ürünler ve ayarlar organizasyon bazında ayrılır; bir organizasyon diğerinin verisini göremez.',
  },
  {
    icon: 'key',
    title: 'Her hesabın bağlantısı ayrı',
    body: 'Birden çok mağaza ya da pazaryeri hesabında bağlantı bilgileri hesap bazında şifreli saklanır.',
  },
  {
    icon: 'health',
    title: 'Bağlantı durumu görünür',
    body: 'Senkron ve bağlantı durumları panelde görünür; sorun olduğunda nerede olduğunu görürsünüz.',
  },
  {
    icon: 'hand',
    title: 'İşlem sizin onayınızla',
    body: 'Gönderi oluşturma ve baskı sizin aksiyonunuzla çalışır. Test aşamasındaki entegrasyonlar canlı gönderi oluşturmaz.',
  },
  {
    icon: 'stop',
    title: 'Belirsizlikte durur',
    body: 'Kargo ataması net değilse CargoFlow tahmin yürütmez; gönderiyi oluşturmaz ve sebebini gösterir.',
  },
] as const
