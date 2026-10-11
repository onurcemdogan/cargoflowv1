// TANITIM SAYFASI İÇERİĞİ — YALNIZ BUGÜNKÜ DOĞRU.
//
// Kurallar (testle kilitli):
//   · Entegrasyonlar GERÇEK durumlarıyla anılır. Yalnız üretimde kullanılanlar
//     "Canlı" etiketi taşır: Trendyol (pazaryeri) ve Sürat Kargo. WooCommerce,
//     ikas ve Aras `internal_test`; Hepsiburada, n11 ve Ticimax geliştirme
//     aşamasındadır — bunlar "mevcut/canlı" gibi GÖSTERİLMEZ.
//   · Resmî iş ortaklığı / partnerlik iddiası YOK.
//   · Herkese açık kayıt YOK (üretimde kapalı) → kayıt/deneme çağrısı YOK.
//   · Kamuya açık fiyat YOK → fiyat bölümü YOK.
//   · Uydurma müşteri sayısı, referans, oran veya sertifika YOK.
//   · "Tam otomatik / hatasız / her yazıcıda" gibi iddialar YOK.

export const LANDING_HERO = {
  eyebrow: 'Türkiye e-ticaret operasyonları için',
  headline: 'Siparişten kargo etiketine tek operasyon akışı.',
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
  internal_test: 'Bağlantı altyapısı hazır; canlı gönderi ve sipariş akışına henüz açılmadı.',
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

export const LANDING_VALUES = [
  {
    icon: 'orders',
    title: 'Siparişleri tek ekranda yönetin',
    body:
      'Pazaryeri siparişleri statü, kargo ve etiket durumlarıyla tek listede. Filtreleyin, toplu seçin, işlemi listeden başlatın.',
  },
  {
    icon: 'route',
    title: 'Doğru kargo akışı, siparişin atamasına göre',
    body:
      'Gönderi, siparişin atandığı kargo firmasının akışıyla oluşturulur. Atama belirsizse sistem tahmin yürütmez; işlemi durdurur ve sebebini gösterir.',
  },
  {
    icon: 'label',
    title: 'Etiket oluşturma ve tekrar yazdırma',
    body:
      'Etiketi önizleyin, tarayıcıdan yazdırın ya da ZPL olarak indirin. Oluşan etiket saklanır; tekrar yazdırmak için gönderi yeniden oluşturulmaz.',
  },
  {
    icon: 'health',
    title: 'Entegrasyon sağlığını takip edin',
    body:
      'Her bağlı hesabın son senkron zamanı ve hata durumu görünür. Bağlantı bilgisi eksik ya da hatalı olan hesap panelde ayrıca işaretlenir.',
  },
] as const

export const LANDING_WORKFLOW = [
  {
    title: 'Siparişleri senkronize et',
    body:
      'Bağlı pazaryeri hesaplarındaki siparişler panele alınır; her sipariş geldiği hesapla birlikte saklanır.',
  },
  {
    title: 'Kargo ve gönderi bilgilerini doğrula',
    body:
      'Kargo ataması, desi ve alıcı bilgileri kontrol edilir; eksik ya da çelişkili bilgi işlemden önce görünür.',
  },
  {
    title: 'Gönderi + etiketi oluştur',
    body:
      'Gönderi kargo firmasında oluşturulur, etiket önizlenir ve yazdırılır. Otomatik etiket isteğe bağlıdır, varsayılan olarak kapalıdır.',
  },
  {
    title: 'Operasyonu ve bağlantıları takip et',
    body:
      "Bekleyen işlemleri, kargo durumlarını ve bağlantı sağlığını Dashboard'dan izleyin.",
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
    body: 'Etiket şablonu düzenleme, önizleme, tarayıcı ya da ZPL ile baskı ve tekrar yazdırma.',
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
    title: 'Organizasyonunuzun verisi ayrı',
    body: 'Siparişler, ürünler ve ayarlar organizasyon bazında ayrılır; bir organizasyon diğerinin verisini göremez.',
  },
  {
    icon: 'key',
    title: 'Her hesabın bağlantı bilgisi ayrı',
    body: 'Birden çok mağaza ya da pazaryeri hesabı bağladığınızda bağlantı bilgileri hesap bazında şifreli saklanır.',
  },
  {
    icon: 'health',
    title: 'Görünür bağlantı durumu',
    body: 'Senkron ve bağlantı durumları panelde görünür; sorun olduğunda nerede olduğunu görürsünüz.',
  },
  {
    icon: 'hand',
    title: 'Kontrollü gönderi',
    body: 'Gönderi oluşturma ve baskı sizin aksiyonunuzla çalışır. Test aşamasındaki entegrasyonlar canlı gönderi oluşturmaz.',
  },
  {
    icon: 'stop',
    title: 'Belirsizlikte durur',
    body: 'Kargo ataması net değilse CargoFlow tahmin yürütmez; gönderiyi oluşturmaz ve sebebini gösterir.',
  },
] as const
