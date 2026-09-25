// TANITIM SAYFASI İÇERİĞİ — YALNIZ BUGÜNKÜ DOĞRU.
//
// Kurallar (testle kilitli):
//   · Yalnız CANLI entegrasyonlar anılır: Trendyol (pazaryeri) ve Sürat Kargo.
//     WooCommerce `internal_test`, ikas/Ticimax `off`, Aras hazır DEĞİL — bu
//     sayfada "mevcut" gibi GÖSTERİLMEZ.
//   · Herkese açık kayıt YOK (üretimde kapalı) → kayıt/deneme çağrısı YOK.
//   · Kamuya açık fiyat YOK → fiyat bölümü YOK.
//   · Uydurma müşteri sayısı, referans, oran veya sertifika YOK.
//   · "Tam otomatik / hatasız / her yazıcıda" gibi iddialar YOK.

export const LANDING_HERO = {
  eyebrow: 'E-ticaret operasyonları',
  headline: 'Siparişten kargo etiketine tek operasyon akışı.',
  body:
    'Trendyol siparişlerinizi, ürün kataloğunuzu, Sürat Kargo gönderi ve etiket sürecinizi tek panelde yönetin.',
} as const

export const LANDING_WORKFLOW = [
  {
    title: 'Siparişleri görün',
    body:
      'Trendyol siparişleri panele senkronize edilir; statü, kargo ve etiket durumlarıyla tek listede görünür.',
  },
  {
    title: 'Gönderiyi hazırlayın',
    body:
      'Desi ve gönderi bilgilerini kontrol edin, Sürat Kargo gönderisini panelden oluşturun.',
  },
  {
    title: 'Etiketi yazdırın',
    body:
      'Etiketi önizleyin; tarayıcı üzerinden yazdırın veya ZPL olarak indirin — mevcut baskı akışınızla.',
  },
  {
    title: 'Operasyonu takip edin',
    body:
      "Bekleyen işlemleri, kargo durumlarını ve bağlantı sağlığını Dashboard'dan izleyin.",
  },
] as const

export const LANDING_CAPABILITIES = [
  {
    title: 'Sipariş Yönetimi',
    body: 'Siparişleri statü, kargo, tarih ve arama filtreleriyle yönetin; toplu seçimle işlem yapın.',
  },
  {
    title: 'Ürün Kataloğu',
    body: 'Ürün ve varyantları sunucu tarafında arayın, filtreleyin; kataloğu satış kanalıyla senkronize edin.',
  },
  {
    title: 'Kargo Operasyonu',
    body: 'Sürat Kargo gönderi oluşturma ve takip bilgilerini tek ekrandan kontrol edin.',
  },
  {
    title: 'Etiket ve Baskı',
    body:
      'Etiket yerleşimini gerçek sipariş verisiyle düzenleyin; etiketlerinizi mevcut baskı akışınız üzerinden yazdırın.',
  },
  {
    title: 'Operasyon Görünürlüğü',
    body: "Bekleyen işlemleri, satış ve kargo özetlerini Dashboard'dan takip edin.",
  },
  {
    title: 'Entegrasyon Yönetimi',
    body: 'Pazaryeri ve kargo bağlantılarınızı, gönderi ayarlarınızı tek yerden yönetin; bağlantı durumunu görün.',
  },
] as const

/** YALNIZ bugün canlı olan entegrasyonlar. */
export const LANDING_INTEGRATIONS = [
  { name: 'Trendyol', kind: 'Pazaryeri' },
  { name: 'Sürat Kargo', kind: 'Kargo' },
] as const

export const LANDING_CONTROL_POINTS = [
  {
    title: 'İşlemler sizin onayınızla',
    body: 'Gönderi oluşturma, senkron ve baskı açık kullanıcı aksiyonuyla çalışır; otomatik etiket isteğe bağlıdır ve varsayılan olarak kapalıdır.',
  },
  {
    title: 'Hesap bazında ayrılmış veri',
    body: 'Siparişler ve ürünler organizasyon ve pazaryeri hesabı bazında ayrı tutulur.',
  },
  {
    title: 'Görünür bağlantı durumu',
    body: 'Senkron ve bağlantı durumları panelde görünür; sorun olduğunda nerede olduğunu görürsünüz.',
  },
] as const
