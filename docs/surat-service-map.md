# Sürat / Serendip servis haritası

Bu belge CargoFlow'un kullandığı Sürat operasyonlarını tahmine göre değil, resmî WSDL ve kullanıcıdaki resmî PDF dokümanlarına göre sınıflandırır. Başarı ölçütü yalnız HTTP 200 veya ZPL değildir; `OzelKargoTakipNo` ile yapılan doğrulamada kayıt bulunması ve taşıyıcı kimliklerinin eşleşmesidir.

## Resmî kaynaklar

- WSDL: <https://webservices.suratkargo.com.tr/services.asmx?WSDL>
- SOAP endpoint: `https://webservices.suratkargo.com.tr/services.asmx`
- GönderiyiKargoyaGönder REST canlı: `https://api01.suratkargo.com.tr/api/GonderiyiKargoyaGonder`
- GönderiyiKargoyaGönder REST test: `https://api02.suratkargo.com.tr/api/GonderiyiKargoyaGonder`
- KargoTakipHareketDetayi REST canlı: `https://api01.suratkargo.com.tr/api/KargoTakipHareketDetayi`
- Yerel resmî dokümanlar:
  - `GonderiyiKargoyaGonder Entegrasyonu API Dokümanı (1).pdf`
  - `KargoTakipHareketDetayi API Dokümanı v2 (1).pdf`
  - `KargoTakipHareketDetayi_WebServisDokümanı (1).pdf`
  - `SURAT API_Gönderi Oluştur v2 (1).pdf`

WSDL hem SOAP 1.1 (`text/xml` + `SOAPAction`) hem SOAP 1.2 (`application/soap+xml; action=...`) binding sunuyor. CargoFlow SOAP 1.1 kullanır.

## Operasyon tablosu

| Operation | Request root / type / sıra | Response | İşlev ve doğrulama | Sorgu anahtarı | Kaynak |
|---|---|---|---|---|---|
| `GonderiyiKargoyaGonder` | `KullaniciAdi`, `Sifre`, `Gonderi:GonderiKargoModel` | `string` | Resmî PDF'ye göre gönderiyi kargo operatör ekranına aktarır. 013–016 barkod iletim kodlarıdır; tek başına Serendip kaydı kanıtı değildir. | Request'teki müşteri sipariş kodu | WSDL + GönderiyiKargoyaGönder PDF |
| `GonderiyiKargoyaGonderYeni` | `KullaniciAdi`, `Sifre`, `Gonderi:GonderiModel` | `string` | Yeni `GonderiModel` varyantı. Yanıt tipi etiket alanı tanımlamaz. | `OzelKargoTakipNo` eşlemesi salt-okunur sorguyla doğrulanmalı | WSDL |
| `GonderiyiKargoyaGonderYeniSiparisBarkodOlustur` | `KullaniciAdi`, `Sifre`, `Gonderi:GonderiModel` | `MesajTipi { isError, Message, Barcode }` | Gönderi isteğiyle birlikte barkod/ZPL döndürür. Dönen T.No ve BarkodNo doğrulama öncesi adaydır. | `create.Gonderi.OzelKargoTakipNo` | WSDL + canlı response şekli |
| `OrtakBarkodOlustur` | `KullaniciAdi`, `Sifre`, `Gonderi:GonderiModel` | `ResultMesaj { isError, Message, KargoTakipNo, Barcode[] }` | Barkod ve KargoTakipNo döndüren ayrı operasyon. CargoFlow yeni-sipariş operasyonuna sessiz fallback yapmaz. | `create.Gonderi.OzelKargoTakipNo` | WSDL |
| `KargoBarkodu` | `cariKodu`, `WebPassword`, `ozelKargoTakipNo` | `KargoBarkod { OzelKargoTakipNo, KargoTakipNo, Aciklama, Detay[], PdfBarkod, PpdBarkod[], BarkodNo[] }` | Mevcut kaydın taşıyıcı etiketi/barkodu için salt-okunur çözümleme. Ayrı e-Sürat Web/Sorgulama şifresi gerekir. | Yalnız `OzelKargoTakipNo` | WSDL |
| `KargoBarkoduSiparis` | `cariKodu`, `WebPassword`, `Gonderientity:Gonderi` | `KargoBarkod` | Sipariş gövdesiyle PDF/barkod döndüren operasyon. WSDL tek başına bunun nihai evrak oluşturduğunu kanıtlamaz; canlı mutasyon için hesap yetkisi ve resmî iş akışı teyidi gerekir. | Response `OzelKargoTakipNo` / `KargoTakipNo` | WSDL |
| `KargoBarkoduSiparisGuncelle` | `cariKodu`, `WebPassword`, `Gonderientity:KWebGonderiGirisi`, `webcari:KWebCari`, `k:ArrayOfKWebGonderiGirisiKargo` | `KargoBarkod` | Güncelleme isimli operasyon. İkinci aşama/finalize olarak kullanılması resmî olarak kanıtlanmadığı için otomatik çağrılmaz. | Response alanları | WSDL |
| `KargoTakipHareketDetayi` | `CariKodu`, `Sifre`, `WebSiparisKodu` | JSON taşıyan `string` | Resmî dokümana göre gönderi ve hareket detayını döndürür. CargoFlow yalnız `WEB_SIPARIS_KODU` tipini kabul eder. | `createRequest.OzelKargoTakipNo` | WSDL + KargoTakipHareketDetayi PDF'leri |
| `BarkoddanGelenKargoDetayi` | `CariKodu`, `Sifre`, `Barkod` | `string` | Barkod için ayrı salt-okunur operasyon. WebSiparisKodu yerine barkodun takip endpoint'ine gönderilmesini gerektirmez. | `BarkodNo` | WSDL |
| `TakipNo` | `GonderenCariKodu`, `TakipNo`, `Sifre` | DataSet; canlı kayıtta `WebSiparisKodu`, `TakipNo`, `Barkod`, `Durum`, `Desi` | T.No/KargoTakipNo için ayrı salt-okunur operasyon. T.No, `KargoTakipHareketDetayi.WebSiparisKodu` değildir. Ayrı `WebPassword` istemez. | `KargoTakipNo` | WSDL + bilinen gerçek kayıtta salt-okunur canlı test |
| `WebSiparisKodu` | `GonderenCariKodu`, `Sifre`, `WebSiparisKodu` | DataSet; canlı kayıtta `WebSiparisKodu`, `TakipNo`, `Barkod`, `Durum`, `Desi` | Müşteri sipariş referansıyla kayıt, T.No ve ana barkodu birlikte döndüren salt-okunur operasyon. Ayrı `WebPassword` istemez. | `createRequest.OzelKargoTakipNo` | WSDL + bilinen gerçek kayıtta salt-okunur canlı test |
| `WebSiparisKodundanKargoTeslimatBilgisi` | `gonderenCariKodu`, `satisKodu`, `Sifre` | `TeslimatBilgisiSonuc` | Web sipariş/satış koduyla teslimat sorgusu. | `satisKodu` | WSDL |
| `TakipNodanKargoTeslimatBilgisi` | `key`, `takipNo` | `TeslimatBilgisiSonuc` | T.No ile teslimat sorgusu; ayrı `key` yetkisi gerekir. | `KargoTakipNo` | WSDL |

Tüm SOAPAction değerleri `http://tempuri.org/<Operation>` biçimindedir ve request root operation adıyla aynıdır.

## `GonderiModel` element sırası

WSDL `xsd:sequence` sırası:

1. `KisiKurum?`
2. `SahisBirim?`
3. `AliciAdresi?`
4. `Il?`
5. `Ilce?`
6. `TelefonEv?`
7. `TelefonIs?`
8. `TelefonCep?`
9. `Email?`
10. `AliciKodu?`
11. `KargoTuru`
12. `OdemeTipi`
13. `IrsaliyeSeriNo?`
14. `IrsaliyeSiraNo?`
15. `ReferansNo?`
16. `OzelKargoTakipNo?`
17. `Adet`
18. `BirimDesi?`
19. `BirimKg?`
20. `KargoIcerigi?`
21. `KapidanOdemeTahsilatTipi`
22. `KapidanOdemeTutari?`
23. `EkHizmetler?`
24. `TasimaSekli`
25. `TeslimSekli`
26. `SevkAdresi?`
27. `GonderiSekli` (nillable int)
28. `TeslimSubeKodu?`
29. `Pazaryerimi`
30. `EntegrasyonFirmasi?`
31. `Iademi`
32. `AlimSaati?`

`WebSiparisKodu`, `SatisKodu`, `MarketplaceIntegrationCode` ve `DesiSource` bu modelde yoktur; strict XML'e eklenmez.

## Alan anlamları

| Kavram | Kaynak | Create alanı | Serendip/read alanı | ZPL/UI karşılığı | Canonical? |
|---|---|---|---|---|---|
| Trendyol `cargoTrackingNumber` (727...) | Trendyol paket response | `OzelKargoTakipNo` | `KargoTakipHareketDetayi.WebSiparisKodu` | Etikette müşteri/sipariş referansı olabilir | Hayır; Sürat T.No değildir |
| `packageId` / `shipmentPackageId` | Trendyol paket response | `ReferansNo` | Takip endpoint'ine gönderilmez | İç operasyon referansı | Hayır |
| `orderNumber` | Trendyol | Strict `GonderiModel` içinde ayrı alan yok | Takip endpoint'ine gönderilmez | Pazaryeri Sipariş No | Hayır |
| `KargoTakipNo` / T.No | Sürat read/create response veya ZPL | Create input değildir | `KargoTakipHareketDetayi.KargoTakipNo`; ayrıca `TakipNo` operasyonu | `T.No` | Evet, kimlik eşleşmesi sonrası |
| `BarkodNo` | Sürat response/ZPL | Create input değildir | `KargoBarkodu.BarkodNo[]` veya barkod read servisi | Ana Code128 | Evet, kimlik eşleşmesi sonrası |
| `WebSiparisKodu` | Sürat'teki müşteri referansı | Bu akışta `OzelKargoTakipNo` ile oluşur | `KargoTakipHareketDetayi.WebSiparisKodu` | Debug/referans | Hayır |

Bilinen iyi kontrol:

```text
KargoTakipHareketDetayi(WebSiparisKodu=7270034268450518)
=> Gonderiler=1
=> KargoTakipNo=07414623015915

WebSiparisKodu(WebSiparisKodu=7270034268450518)
=> DataSet satırı=1
=> TakipNo=07414623015915
=> Barkod=01248069999

TakipNo(TakipNo=07414623015915)
=> DataSet satırı=1
=> WebSiparisKodu=7270034268450518
=> Barkod=01248069999
```

Aynı endpoint'e `07414623015915` değerini `WebSiparisKodu` olarak vermek doğru tipte bir sorgu değildir. CargoFlow bunu taşıyıcıya göndermeden reddeder.

## Preflight sınıflandırması

| Koşul | Sınıf | Karar |
|---|---|---|
| Alıcı adı, adres, il, ilçe | `BUSINESS_REQUIRED` | Eksikse create engellenir. |
| Desi/kg | `BUSINESS_REQUIRED` | Ürün/API değeri yoksa kullanıcı onaylı manuel değer kabul edilir. |
| `OzelKargoTakipNo` | `BUSINESS_REQUIRED` + `SAFETY_REQUIRED` | Trendyol `cargoTrackingNumber` olmalı. |
| `ReferansNo` | `OPTIONAL` + operasyonel iz | `packageId` kullanılır; takip anahtarı değildir. |
| Telefon | WSDL'de `OPTIONAL`, PDF'de gerekli iş alanı | Trendyol ham verisinde varsa map edilir; boşluğu tek başına yanlış referans fallback'i doğurmaz. |
| Created/Picking/Invoiced ve Sürat ataması | `BUSINESS_REQUIRED` | Kapalı/iptal/teslim siparişte create yapılmaz. |
| `createCallCount`, idempotency, mevcut ZPL/adayı | `SAFETY_REQUIRED` | Belirsiz veya pending create tekrar edilmez. |
| Önceki `Gonderiler=0` | Tek başına create izni değildir | Pending aday/ZPL korunur; ikinci create yapılmaz. |

## Aday zincirler ve başarı kuralı

Resmî kaynaklar ayrı bir zorunlu `FINALIZE` adımını kanıtlamıyor. Operation isimleri de tek başına bir zinciri kanıtlamaz. Bu nedenle CargoFlow her create adayını ayrı request builder, SOAPAction/route, parser ve idempotency anahtarıyla dener; bir create operasyonundan sonra başka bir create operasyonuna otomatik geçmez.

Canlı deney sırası:

1. `GonderiyiKargoyaGonderYeniSiparisBarkodOlustur` — tek birleşik create+label adayı.
2. REST v2 `Gonderi/GonderiOlustur` — ayrı create adayı.
3. `GonderiyiKargoyaGonderYeni` — string response veren ayrı create adayı.
4. Yalnız resmî alan bağı kanıtlanırsa create → label/finalize zinciri.

`OrtakBarkodOlustur` tek başına create adayı değildir. REST `GonderiyiKargoyaGonder` ile birleşik SOAP create operasyonu artık aynı kullanıcı işleminde ardışık çağrılmaz; bu iki create çağrısı ve mükerrer gönderi riski doğuruyordu. Kayıt read-only serviste kanıtlanmış fakat etiket yoksa yalnız `OrtakBarkodOlustur` gibi kanıtlanmış label operasyonu ayrıca çalıştırılabilir.

Katmanlı durum:

```text
operation sözleşmesi kabul edildi       -> CREATE_ACCEPTED
WebSiparisKodu read servisinde kayıt var -> SHIPMENT_REGISTERED
ZPL + ana BarkodNo parse edildi          -> LABEL_CREATED
KargoTakipHareketDetayi Gonderiler=1     -> TRACKING_ACTIVE
aynı referans + T.No + Barkod eşleşti     -> VERIFIED
```

`VERIFIED` dışında hiçbir durum canonical T.No/BarkodNo üretmez ve yazdırmayı açmaz.

`Gonderiler=0`, 013/014/015/016 veya teknik ZPL durumunda aday T.No, BarkodNo, ZPL ve `OzelKargoTakipNo` korunur; create tekrarlanmaz. İlk 30 dakika durum `LABEL_CREATED_UNVERIFIED` olur. Etiket oluşturulduktan en az 30 dakika sonra doğru `WebSiparisKodu` ile yapılan sorgu hâlâ `Gonderiler=0` döndürürse durum `LABEL_CREATED_NOT_REGISTERED` olur. Bu durumda canonical T.No/BarkodNo boş, ZPL indirme ve yazdırma kapalı kalır.

## CargoFlow gerçek çağrı haritası

```text
src/pages/OrdersPage.tsx:439
  -> src/App.tsx:414
  -> src/services/orderWorkflowService.ts:429,507
  -> src/providers/shipping/SuratKargoProvider.ts:22,32
  -> server/index.mjs:542,580 (create route ve preflight)
  -> server/index.mjs:797,824 (operation resolver ve kalıcı idempotency)
  -> server/index.mjs:3673 / 3832 / 4037 (operation'a özel caller/parser)
  -> server/index.mjs:4304 (katmanlı read-only doğrulama)
  -> server/index.mjs:435,1318 (kalıcı doğrulama ve canonical eşleşme)
  -> src/utils/printableLabel.ts:59 (VERIFIED baskı kapısı)
  -> UI/DB/ZPL canonical kimlikleri
```

Takip butonu yolu `SuratKargoProvider.ts:454` ile başlar ve yalnız `shipment.ozelKargoTakipNo` veya onun kaynağı olan `order.cargoTrackingNumber` değerini `WEB_SIPARIS_KODU` tipiyle gönderir. `trackingNumber`, `shipmentCode`, `orderNumber`, `packageId`, T.No ve BarkodNo fallback olarak kullanılmaz.

## 17 Temmuz 2026 canlı ayrım testi

`OrtakBarkodOlustur` tek başına çağrıldığında Sürat `013`, aday T.No,
aday BarkodNo ve teknik ZPL döndürdü. Buna rağmen aynı
`OzelKargoTakipNo` için aşağıdaki dört salt-okunur kontrol de kayıt
döndürmedi:

- `KargoTakipHareketDetayi`: `Gonderiler=0`
- `WebSiparisKodu`: satır yok
- `TakipNo`: satır yok
- `CariKoduveSifre` 90 günlük geçmiş: eşleşme yok

Aynı kimlik bilgileriyle bilinen gerçek kontrol kaydı dört sorguda da doğru
T.No ve BarkodNo ile bulundu. Bu nedenle bağlantı veya parser hatası değil;
`OrtakBarkodOlustur` cevabının tek başına gerçek gönderi kaydı kanıtı
olmadığı doğrulandı.

Üretim kuralı:

```text
GonderiyiKargoyaGonder (resmî REST kayıt gövdesi)
  -> duplicate ise önce mevcut kaydı salt-okunur doğrula
  -> doğrulanmayan duplicate durumda DUR; barkod servisini çağırma
  -> kayıt kabul edildiyse seçili resmî etiket operasyonu
  -> KargoTakipHareketDetayi + WebSiparisKodu doğrulaması
  -> yalnız üçlü eşleşmede VERIFIED / yazdırılabilir
```

REST `Gonderi` nesnesi resmî PDF alanlarıyla sınırlıdır.
`WebSiparisKodu`, `SatisKodu`, `MarketplaceIntegrationCode` ve diğer yerel
alanlar bu gövdeye eklenmez. Trendyol `cargoTrackingNumber` yalnız
`OzelKargoTakipNo`, paket kimliği yalnız `ReferansNo` olarak gönderilir.

## 17 Temmuz 2026 nihai araştırma kararı

### Operation sınıflandırması

| Operation | Kesin rol | Serendip kaydı kanıtı | CargoFlow kararı |
|---|---|---|---|
| `OrtakBarkodOlustur` | `ResultMesaj` ile aday KargoTakipNo ve ZPL/barkod üretir. | Canlı 013 sonucundan sonra 30 dakikayı aşan doğru `WebSiparisKodu` sorgusunda `Gonderiler=0`; kayıt açtığı kanıtlanmadı. | `LABEL_ONLY`; create başarısı sayılmaz. |
| `GonderiyiKargoyaGonderYeniSiparisBarkodOlustur` | `GonderiModel` alıp `MesajTipi { isError, Message, Barcode }` döndürür. | WSDL response tipinde canonical `KargoTakipNo` alanı yok; tek başına kayıt kanıtı yok. | Seçilirse yalnız bu SOAPAction çağrılır; fallback yok. Dönen kodlar doğrulanana kadar adaydır. |
| `GonderiyiKargoyaGonderYeni` | `GonderiModel` alır, `string` döndürür. | WSDL kayıt görünürlüğünü veya takip kimliğini garanti etmiyor. | Otomatik zincire eklenmez. |
| `GonderiyiKargoyaGonder` | Resmî PDF'ye göre veriyi kargo operatör ekranına aktarır; 001–043 iş kodları döndürür. | `Tamam`/013–016 tek başına `Gonderiler=1` kanıtı değildir. | Ön kayıt/kabul sonucu olarak ele alınır; canonical kod yalnız read doğrulamasından gelir. |
| `KargoBarkodu`, `KargoBarkoduSiparis` | Mevcut/sipariş gövdesi üzerinden PDF ve barkod verisi döndürür. | WSDL bu operasyonların gönderi kaydı finalize ettiğini söylemiyor. | Read/label rolünde; kanıtsız finalize olarak çağrılmaz. |
| `KargoBarkoduSiparisGuncelle` | WSDL'de güncelleme operasyonudur. | Hangi önceki operation kimliğini finalize ettiği belgelenmemiştir. | Somut alan bağı olmadığı için otomatik çağrılmaz. |
| REST v2 `Gonderi/GonderiOlustur` | Resmî PDF başlığı ve request modeli doğrudan “Gönderi Oluştur” servisidir. | PDF response şemasını ve Serendip görünürlüğünü belgelemiyor; erişilebilir Swagger JSON bulunamadı. | En güçlü gerçek-create adayıdır fakat canlı kullanım için response sözleşmesi ve yetki teyidi eksiktir. |

### 013 / 014 / 016 sınıflandırması

| Kod | Resmî anlam | ZPL/barkod | Serendip sonucu | Durum |
|---|---|---|---|---|
| 013 | Barkod yeniden gönderildi | Var olabilir | Ayrı read teyidi gerekir | `LABEL_ONLY` |
| 014 | Desi/kg güncellendi, barkod yeniden gönderildi | Var olabilir | Ayrı read teyidi gerekir | `LABEL_ONLY` |
| 016 | Barkod gönderildi | Var olabilir | Ayrı read teyidi gerekir | `LABEL_ONLY` |

Bu kodların hiçbiri tek başına `SUCCESS`, canonical T.No veya yazdırma yetkisi üretmez.

### Durum makinesi

```text
Etiket/ZPL + aday kod geldi
  -> LABEL_CREATED_UNVERIFIED
  -> doğru WEB_SIPARIS_KODU ile Serendip read
     -> Gonderiler=1 + T.No/Barkod eşleşmesi: VERIFIED
     -> Gonderiler=0 ve 30 dakika dolmadı: PENDING_VERIFICATION
     -> Gonderiler=0 ve en az 30 dakika doldu: LABEL_CREATED_NOT_REGISTERED
```

`LABEL_CREATED_NOT_REGISTERED` güvenli terminal durumudur: adaylar tanı için korunur, canonical alanlar boş kalır, ikinci create, ZPL indirme ve yazdırma engellenir.

### Mock uçtan uca kanıtları

1. 013/016 + ZPL + `Gonderiler=0`: ilk anda pending, eşik sonrası `LABEL_CREATED_NOT_REGISTERED`, yazdırma kapalı.
2. Create sonucu + `Gonderiler=1` + eşleşen T.No/Barkod: `VERIFIED`, canonical kodlar dolu, yazdırma açık.
3. Gecikmeli `Gonderiler=0`: pending korunur ve aynı idempotency key ile ikinci create yapılmaz.
4. Duplicate: yeni create yerine doğru `WebSiparisKodu` ile mevcut kayıt okunur; read teyidi yoksa etiket açılmaz.

### Güncel deney kapısı

Mevcut resmî WSDL/PDF seti, hangi tek operation veya belgeli operation zincirinin kesin olarak Serendip'te `Gonderiler=1` kaydı açtığını yeterli response/alan bağıyla göstermiyor. Bu nedenle sonuç resmî isimden tahmin edilmeyecek; temiz siparişlerde operation başına bir kontrollü canlı create ile ölçülecek.

Canlı çağrıdan önce zorunlu kapılar:

- lint, build ve tüm Sürat snapshot/mock testleri başarılı,
- bilinen gerçek kayıt fingerprint'i üç read servisinde aynı T.No/BarkodNo döndürüyor,
- aday sipariş Created/Picking/Invoiced ve Sürat atanmış,
- orderNumber/packageId/cargoTrackingNumber için create geçmişi yok,
- `KargoTakipHareketDetayi` ve `WebSiparisKodu` sorgularında mevcut kayıt yok,
- adres/il/ilçe ve kullanıcı onaylı desi hazır.

Bir adayda belirsiz veya başarısız create sonucu otomatik tekrarlanmaz. İlk `VERIFIED` sonucunda diğer create deneyleri durur. Bütün aday operation'lar sözleşmeye uygun denenip hiçbiri `VERIFIED` olmazsa terminal sonuç `EXPERIMENTS_EXHAUSTED` olur.

## 17 Temmuz 2026 — canlı kanıtlarla kesinleşen üretim modeli

Aynı gün öğleden önce yapılan kontrollü canlı deneyler ve satıcının fiziksel
teslimatının eşzamanlı gözlemi, önceki bölümlerdeki açık soruları kapattı:

1. **Sipariş kaydı Trendyol tarafından önceden açılıyor.** Hiç dokunulmamış
   temiz siparişte (11419469827) tek `GonderiyiKargoyaGonderYeni` çağrısı
   `"Bu gonderi daha önce oluşturulmuş."` döndürdü. Combined operasyonun
   temiz siparişlerde `014` (desi güncellendi) döndürmesi de aynı nedene
   bağlıdır: sipariş, Sürat'a Trendyol entegrasyon beslemesiyle bizden önce
   ulaşıyor.
2. **"Aday" T.No ve barkod aslında önceden atanmış canonical kodlardır.**
   Satıcı 17.07 ~08:51'de paketleri Ferah Acente'ye teslim ettiğinde,
   karşılaştırılabilir 4 siparişin 4'ünde tesellümde atanan `TakipNo` ve
   `Barkod`, create/label yanıtından saklanan aday kodlarla birebir eşleşti
   (11419672319→23316119245247/01249708190, 11419815579→14518713191244,
   11419775609 (`OrtakBarkodOlustur`)→41176176501029, ty4004828871→
   72222561881876). Eşleşme, CargoFlow etiketi hiç yazdırılmadan (Trendyol
   etiketiyle teslimde) bile korunuyor; bağ sipariş kaydı üzerindendir.
3. **Read yüzeyleri kaydı yalnız fiziksel tesellümden sonra gösterir.**
   `WebSiparisKodu`, `TakipNo`, `Barkod` ve `KargoTakipHareketDetayi`
   sonuçları TF serisi *Tesellüm* evrakıdır. Create'ten 9-12 saat sonra bile
   kabul edilmemiş gönderi hiçbir yüzeyde görünmez. Dolayısıyla
   `LABEL_CREATED_NOT_REGISTERED` bir taşıyıcı hatası değil, "fiziksel kabul
   bekleniyor" ara durumudur; 30 dakikalık eşik kayıt yokluğunu kanıtlamaz.
4. **`KargoTakipHareketDetayi` anlık tutarsız dönebilir.** Aynı gönderi için
   dakikalar içinde `Gonderiler=1` → boş yanıt gözlendi. Doğrulama çoklu
   yüzey (öncelik `WebSiparisKodu` DataSet) kullanmalı; boş/deforme KTH
   yanıtı "kayıt yok" değil "belirsiz" sayılmalıdır.
5. **Kanıtlanmış VERIFIED zinciri (sipariş 11419469827).** Tesellüm sonrası
   `/api/shipments/surat/label` (`OrtakBarkodOlustur`, tek çağrı):
   ZPL(2069B) içinde canonical T.No `24446119471462`, canonical Barkod
   `01249704068` ve `OzelKargoTakipNo` üçü birden; `Gonderiler=1` ve
   `KargoTakipNo` eşleşti; `printEnabled=true`; halka açık takip sayfası ve
   `surat-serendip-live-check` aynı gönderiyi `SERENDIP_VERIFIED` olarak
   buldu. `createCallCount=1`, `labelCallCount=1`, mükerrer kayıt yok.

Düzeltilen kod hatası: `executeRegisteredSuratLabel` etiket sayaç kilidini
taşıyıcıya ulaşmadan yazıyordu; istek gövdesi (desi dahil) artık sayaç
yazılmadan önce doğrulanıyor ve taşıyıcıya ulaşmayan hata etiket hakkını
tüketmiyor.
