// TANITIM SAYFASI İÇERİĞİ — YALNIZ BUGÜNKÜ DOĞRU.
//
// Kurallar (testle kilitli):
//   · Entegrasyonlar GERÇEK durumlarıyla anılır. Yalnız üretimde kullanılanlar
//     "Canlı" etiketi taşır: Trendyol (pazaryeri) ve Sürat Kargo. WooCommerce,
//     ikas ve Aras `internal_test`; Hepsiburada, n11 ve Ticimax geliştirme
//     aşamasındadır. Canlı OLMAYAN bir entegrasyon sayfada yalnız durum
//     etiketiyle (`data-integration` + `data-status`) anılır.
//   · Resmî iş ortaklığı / partnerlik iddiası YOK.
//   · Herkese açık kayıt YOK (üretimde kapalı) → kayıt/deneme çağrısı, "kredi
//     kartı gerekmez", kurulum süresi iddiası YOK. Birincil çağrı "Panele Gir".
//   · Kamuya açık fiyat YOK → fiyat bölümü YOK.
//   · Uydurma müşteri sayısı, referans, oran veya sertifika YOK.
//   · Ürün sahnelerindeki tüm sipariş, kişi ve adresler TEMSİLİDİR.

export const LANDING_HERO = {
  eyebrow: 'E-ticaret kargo operasyonu',
  headline: 'Siparişten etikete. Tek ve sakin bir akış.',
  headlineStrong: 'Siparişten etikete.',
  headlineSoft: 'Tek ve sakin bir akış.',
  body:
    'Trendyol siparişlerini senkronize edin, Sürat Kargo gönderilerini oluşturun, barkod ve etiketleri tek panelden yönetin.',
  note: 'Hesaplar organizasyon yöneticisi tarafından oluşturulur.',
} as const

/** Kaydırdıkça kelime kelime aydınlanan açıklama (Nasıl çalışır?). */
export const LANDING_STATEMENT =
  'Sipariş Trendyol’dan gelir. CargoFlow gönderiyi atandığı kargo firmasında oluşturur, barkodu ve etiketi hazırlar, paketi teslim edilene kadar izler — ve emin olmadığı yerde durup sebebini gösterir.'

/** Sipariş → Kargo → Etiket → Takip. */
export const LANDING_WORKFLOW = [
  { stage: 'Sipariş', title: 'Siparişler panele gelir' },
  { stage: 'Kargo', title: 'Gönderi oluşturulur' },
  { stage: 'Etiket', title: 'Barkod ve etiket hazırlanır' },
  { stage: 'Takip', title: 'Paket teslime kadar izlenir' },
] as const

export type FeatureScene = 'sync' | 'cargo' | 'label' | 'templates' | 'tracking' | 'health'

export interface LandingFeature {
  readonly id: string
  readonly scene: FeatureScene
  readonly eyebrow: string
  readonly strong: string
  readonly soft: string
  readonly body: string
  readonly chips: readonly string[]
}

/** Ürün hikâyesi — her bölüm uygulamada BUGÜN var olan bir ekrana karşılık gelir. */
export const LANDING_FEATURES: readonly LandingFeature[] = [
  {
    id: 'siparisler',
    scene: 'sync',
    eyebrow: 'Siparişler',
    strong: 'Sipariş gelir.',
    soft: 'Akış hemen başlar.',
    body: 'Trendyol siparişleri CargoFlow’a alınır ve kargo işlemleri için hazırlanır. Her sipariş geldiği mağaza hesabıyla birlikte saklanır.',
    chips: ['Mağaza bazında senkron', 'Statü ve kargo filtreleri', 'Toplu seçim'],
  },
  {
    id: 'kargo',
    scene: 'cargo',
    eyebrow: 'Kargo İşlemleri',
    strong: 'Gönderiyi birkaç saniyede hazırla.',
    soft: 'Doğru kargo akışıyla.',
    body: 'Alıcı, adres ve desi kontrol edilir; gönderi siparişin atandığı kargo firmasında oluşturulur. Takip numarası siparişe bağlanır.',
    chips: ['Sürat Kargo', 'Desi kontrolü', 'Takip numarası'],
  },
  {
    id: 'etiket',
    scene: 'label',
    eyebrow: 'Barkod ve Etiket',
    strong: 'Barkod hazır.',
    soft: 'Etiket hazır.',
    body: 'Kargo barkodu ve etiket gönderiyle birlikte üretilir. Etiket saklanır; tekrar yazdırmak için gönderi yeniden oluşturulmaz.',
    chips: ['Tarayıcıdan yazdırma', 'ZPL çıktısı', 'Tekrar yazdırma'],
  },
  {
    id: 'sablonlar',
    scene: 'templates',
    eyebrow: 'Etiket Şablonları',
    strong: 'Etiketiniz,',
    soft: 'sizin yerleşiminizle.',
    body: 'Metin, barkod, QR kod, çizgi, logo ve alıcı bilgisini sürükleyip yerleştirin; önizlemeyi gerçek sipariş verisiyle görün.',
    chips: ['Sürükle ve bırak', 'Gerçek veriyle önizleme', '100×100 etiket'],
  },
  {
    id: 'takip',
    scene: 'tracking',
    eyebrow: 'Takip',
    strong: 'Paket nerede?',
    soft: 'Panelde görün.',
    body: 'Etiket basıldıktan teslimata kadar gönderinin her durumu siparişin yanında görünür; bekleyen ve takılan gönderiler öne çıkar.',
    chips: ['Kargo hareketleri', 'Teslim durumu', 'Bekleyen gönderiler'],
  },
  {
    id: 'saglik',
    scene: 'health',
    eyebrow: 'Bağlantı Sağlığı',
    strong: 'Bağlantılarınız çalışıyor mu?',
    soft: 'Her an görün.',
    body: 'Her mağaza ve kargo hesabının son senkronu, bağlantı bilgisi ve hata durumu ayrı izlenir; sorun olduğunda nerede olduğunu görürsünüz.',
    chips: ['Hesap bazında durum', 'Son başarılı senkron', 'Bağlantı bilgisi kontrolü'],
  },
]

export const LANDING_GUARD = {
  eyebrow: 'Güvenilirlik',
  strong: 'Emin değilse',
  soft: 'devam etmez.',
  body: 'CargoFlow eksik veya çelişkili bilgide yanlış gönderi üretmek yerine işlemi durdurur ve sebebini gösterir.',
  chips: ['Organizasyon bazında ayrı veri', 'Hesap bazında şifreli bağlantı', 'İşlem sizin onayınızla'],
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
  { name: 'Sürat Kargo', group: 'carrier', kind: 'Kargo', status: 'live' },
  { name: 'WooCommerce', group: 'commerce', kind: 'E-ticaret sitesi', status: 'internal_test' },
  { name: 'ikas', group: 'commerce', kind: 'E-ticaret sitesi', status: 'internal_test' },
  { name: 'Aras Kargo', group: 'carrier', kind: 'Kargo', status: 'internal_test' },
  { name: 'Hepsiburada', group: 'commerce', kind: 'Pazaryeri', status: 'in_development' },
  { name: 'n11', group: 'commerce', kind: 'Pazaryeri', status: 'in_development' },
  { name: 'Ticimax', group: 'commerce', kind: 'E-ticaret sitesi', status: 'in_development' },
]

/** Uygulamada bulunan, doğrulanmış yetenekler (tarih / yol haritası iddiası YOK). */
export const LANDING_HIGHLIGHTS = [
  { icon: 'wizard', title: 'Kurulum sihirbazı', body: 'Pazaryeri ve kargo bağlantısını adım adım kurun; eksik adım panelde görünür.' },
  { icon: 'tour', title: 'Ürün turu', body: 'Panelin ana ekranlarını kısa bir turla tanıyın; istediğiniz zaman yeniden başlatın.' },
  { icon: 'catalog', title: 'Katalog tarayıcısı', body: 'Ürün ve varyantları arayın, filtreleyin; kataloğu satış kanalıyla senkronize edin.' },
  { icon: 'auto', title: 'Otomatik etiket', body: 'İsteğe bağlıdır ve varsayılan olarak kapalıdır; açtığınızda uygun siparişler için etiket hazırlanır.' },
  { icon: 'printer', title: 'Baskı ve ZPL', body: 'Etiketi tarayıcıdan yazdırın ya da ZPL olarak indirin; mevcut yazıcı akışınızla çalışır.' },
  { icon: 'stores', title: 'Çoklu mağaza', body: 'Birden çok mağaza hesabı bağlayın; her hesabın siparişi ve bağlantısı ayrı tutulur.' },
] as const

/** Ürün modülleri — her biri uygulamada BUGÜN var olan bir ekrana karşılık gelir. */
export const LANDING_CAPABILITIES = [
  { icon: 'orders', title: 'Siparişler', body: 'Statü, kargo, tarih ve arama filtreleri; toplu seçim ve sipariş detayı.' },
  { icon: 'truck', title: 'Kargo İşlemleri', body: 'Gönderi oluşturma, takip numarası ve kargo hareketleri.' },
  { icon: 'barcode', title: 'Etiket Oluşturma', body: 'Barkodlu kargo etiketi; tarayıcıdan ya da ZPL ile baskı.' },
  { icon: 'template', title: 'Etiket Şablonları', body: 'Kendi yerleşiminizi gerçek sipariş verisiyle düzenleyin.' },
  { icon: 'route', title: 'Gönderi Takibi', body: 'Etiketten teslimata kadar gönderinin durumu.' },
  { icon: 'health', title: 'Bağlantı Sağlığı', body: 'Hesap bazında senkron ve bağlantı durumu.' },
  { icon: 'plug', title: 'Entegrasyonlar', body: 'Pazaryeri ve kargo hesaplarını tek yerden bağlayın.' },
  { icon: 'chart', title: 'Dashboard', body: 'Bekleyen işler, satış ve kargo özetleri bir bakışta.' },
  { icon: 'catalog', title: 'Katalog', body: 'Ürün ve varyantları satış kanalıyla senkronize edin.' },
] as const

export const LANDING_FAQ = [
  {
    q: 'CargoFlow hesabı nasıl açılır?',
    a: 'Hesaplar organizasyon yöneticisi tarafından oluşturulur. Giriş bilgilerinizle Panele Gir bağlantısından oturum açarsınız.',
  },
  {
    q: 'Hangi pazaryeri ve kargo firmaları canlı?',
    a: 'Bugün Trendyol ve Sürat Kargo canlı kullanımda. Test ve geliştirme aşamasındaki bağlantılar, durumlarıyla birlikte Entegrasyonlar bölümünde listelenir.',
  },
  {
    q: 'Gönderiler kendiliğinden mi oluşturulur?',
    a: 'Hayır. Gönderi oluşturma ve baskı sizin aksiyonunuzla çalışır. Otomatik etiket isteğe bağlıdır ve varsayılan olarak kapalıdır.',
  },
  {
    q: 'Kargo ataması belirsizse ne olur?',
    a: 'CargoFlow tahmin yürütmez; gönderiyi oluşturmaz, siparişi Kontrol Gerekli olarak işaretler ve sebebini gösterir.',
  },
  {
    q: 'Verilerim diğer firmalardan ayrı mı tutulur?',
    a: 'Evet. Siparişler, ürünler ve ayarlar organizasyon bazında ayrılır; bağlantı bilgileri hesap bazında şifreli saklanır.',
  },
] as const
