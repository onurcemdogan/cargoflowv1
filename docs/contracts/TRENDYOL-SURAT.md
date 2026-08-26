# Sözleşme kaydı — TRENDYOL × SÜRAT

Sırlar İÇERMEZ. Her satır KANIT SEVİYESİ taşır.

| Alan | Değer | Kanıt seviyesi |
| --- | --- | --- |
| Marketplace | Trendyol | OFFICIAL |
| Carrier | Sürat Kargo | OFFICIAL |
| Servis modu | `SURAT_CANONICAL_API` | PRODUCTION (canary precheck, TarzimTuba) |
| Host | `https://api02.suratkargo.com.tr` | OFFICIAL_PUBLIC — aşağıya bakın |
| Operasyon | `POST /api/OrtakBarkodOlustur` | SCHEMA_DERIVED (ef944e2) |
| İstek şeması | `{KullaniciAdi, Sifre, Gonderi{31 alan}}` | OFFICIAL (Sürat "GonderiyiKargoyaGonder Entegrasyonu API Dokümanı", Gönderi class) |
| Yanıt şeması | `ResultMesaj {isError, Message, Barcode[], BarcodeNo[]}` | SCHEMA_DERIVED |
| Etiket | `Barcode[]` içindeki yapısal ZPL | PRODUCTION (11415535074) |
| Doğrulama seviyesi | MOCK_E2E | — |
| Son doğrulama | 2026-08-26 | — |

## Faturalama

`whoPays` own-property YOK → `TRENDYOL_PAYS` → `expectedSuratWhoPays=3` →
`PRIMARY_MARKETPLACE`. `whoPays=1` → `SELLER_PAYS` → `1` → `SELLER_PAYS`
hesabı. COD ÜÇÜNCÜ ve BAĞIMSIZ eksendir. `OdemeTipi` faturalama tarafını
BELİRLEMEZ (her iki tarafta da 1 gider).

Kanonik sözleşmede `WhoPays`/`KimOder` alanı **YOKTUR** (yasaklı alan
listesi). Pazaryeri faturalama bağlamı: `OzelKargoTakipNo` + `Pazaryerimi=1`
+ `EntegrasyonFirmasi='Trendyol'` + seçilen cari hesap.

## Kimlik eşlemesi

| CargoFlow | Sürat | Kanıt |
| --- | --- | --- |
| `packageId` | `ReferansNo` | PRODUCTION_PROVEN |
| `cargoTrackingNumber` (727…) | `OzelKargoTakipNo` | PRODUCTION_PROVEN |
| `cargoTrackingNumber` (727…) | **`WebSiparisKodu`** (okuma anahtarı) | PRODUCTION_PROVEN |
| `orderNumber` (115…) | — | — |

**DÜZELTİLMİŞ VARSAYIM.** `WebSiparisKodu = orderNumber` YANLIŞTI. Doğru
kaynak `createRequest.OzelKargoTakipNo`'dur:

* `docs/surat-service-map.md:31,34` — sorgu anahtarı kaynağı
* `docs/surat-service-map.md:83,88` — 727… → `OzelKargoTakipNo` → `WebSiparisKodu`
* `docs/surat-service-map.md:93-104` — canlı örnek `WebSiparisKodu=7270034268450518`
* `outputs/surat-e2e-final-report-2026-07-17.md:46` — sipariş 11419469827 için
  eşleşen anahtar `7270034487433781`

Sipariş numarasıyla sorgulamak HİÇBİR satır döndürmez; teyit kaydın varlığına
bakmaksızın başarısız olur.

**BİRLEŞTİRİCİ KURAL.** `WebSiparisKodu` = create sırasında `OzelKargoTakipNo`
olarak NE gönderildiyse O. Bu, görünürdeki çelişkiyi çözer:

| Akış | create `OzelKargoTakipNo` | okuma anahtarı | Kanıt |
| --- | --- | --- | --- |
| Trendyol pazaryeri (bu kayıt) | `cargoTrackingNumber` | `cargoTrackingNumber` | PRODUCTION_PROVEN |
| SSP / Serendip mutabakatı | `orderNumber` | `orderNumber` | PRODUCTION_PROVEN (`SSP-QUERY-1`) |

İki akış ÇELİŞMEZ. SSP mantığı DEĞİŞTİRİLMEDİ.

**BİRLEŞTİRİCİ KURAL.** `WebSiparisKodu` = create sırasında `OzelKargoTakipNo`
olarak NE gönderildiyse O. Bu, iki görünürdeki çelişkiyi çözer:

| Akış | create `OzelKargoTakipNo` | okuma anahtarı | Kanıt |
| --- | --- | --- | --- |
| Trendyol pazaryeri (bu kayıt) | `cargoTrackingNumber` | `cargoTrackingNumber` | PRODUCTION_PROVEN |
| SSP / Serendip mutabakatı | `orderNumber` | `orderNumber` | PRODUCTION_PROVEN (`SSP-QUERY-1`, golden 4065907241) |

İki akış ÇELİŞMEZ; SSP mantığı DEĞİŞTİRİLMEDİ.

## Host — ÇÖZÜLDÜ (salt-okunur kanıtla)

2026-08-26 salt-okunur uç fingerprinting (DNS/HEAD/GET; kimlik bilgisi YOK,
gövde YOK, mutasyon YOK):

| Kontrol | api01 | api02 |
| --- | --- | --- |
| DNS | 104.18.24.222 / .25.222 (Cloudflare) | AYNI edge IP'leri |
| `/swagger/ui/index` | **HTTP 522** — origin yanıt vermiyor | **HTTP 200** |
| `/swagger/docs/v1` | 404 (gövde 3162 B) | 404 (gövde 1926 B) → FARKLI backend |
| Canlı sözleşme | — | `/swagger/v2/swagger.json` → **"Sürat Kargo Web API" 1.0.0** |

`/api/OrtakBarkodOlustur` **api02'nin canlı Web API'sinde tanımlıdır**.
api01'in origin'i şu an ulaşılamıyor.

**Çelişki nasıl çözülür:** depo PDF'lerindeki `api01=Canlı / api02=Test`
eşlemesi 2024 tarihli **`GonderiyiKargoyaGonder` REST ürününe** aittir. Bu
kayıt farklı bir ürünü — "Sürat Kargo Web API" — tanımlar ve o ürün api02'de
yayındadır. `server/index.mjs:70-75` legacy sabitleri de eski ürüne aittir.

`HOST_CLASSIFICATION = API02_LIVE_FOR_THIS_ACCOUNT` (OFFICIAL_PUBLIC).
Host DEĞİŞTİRİLMEDİ ve değiştirilmemelidir.

## Canlı sözleşme — UÇ AİLESİ MATRİSİ

`docs/contracts/surat-web-api-swagger-v2.json` (api02, **OpenAPI 3**, 20 uç,
45 şema; sır İÇERMEZ).

> DÜZELTME: bu kayıt bir tur boyunca "yalnız yol listesi, şema yok" diyordu.
> YANLIŞTI — belge OpenAPI 3'tür ve şemalar `components.schemas` altındadır;
> Swagger-2 anahtarlarına (`parameters`/`definitions`) bakıldığı için boş
> görünmüştü.

Dördü de `OrtakBarkod` etiketi altındadır:

| Uç | İstek | Yanıt | Adres taşır? | Semantik |
| --- | --- | --- | --- | --- |
| `/api/OrtakBarkodOlustur` **(kullandığımız)** | `OrtakBarkodOlusturParam{KullaniciAdi,Sifre,Gonderi:GonderiModel}` | `ResultMesaj` | EVET (31 alan) | YENİ gönderi kurar |
| `/api/PazaryeriOrtakBarkod` | `MarketPlace{KullaniciAdi,Sifre,Data:Gonder}` | `ResultMesaj` | HAYIR | MEVCUT pazaryeri kaydını referansla çağırır |
| `/api/PazaryeriGonderi` | `OrtakBarkodOlusturParam` | `ResultMesaj` | EVET | YENİ gönderi kurar (pazaryeri) |
| `/api/CreateCommonBarcode` | `CreateCommonBarcodeParam{UserName,Password,Shipment:ShipmentModel}` | `CreateCommonBarcodeResult` | EVET | `GonderiModel`'in İngilizce aynası |

`Gonder` (yalnız `PazaryeriOrtakBarkod`):

```
EntegrasyonFirmasi  → WebMusteriEntegrasyon (enum)
KargoMusteriKodu    string
WebSiparisKodu      string
Desi / Kg           decimal
Adet                int32
```

`WebMusteriEntegrasyon` enum: **Trendyol=1**, Hepsiburada=2, N11=3,
Gittigidiyor=4, CicekSepeti=5, Dolap=6, Bos=7.

### WhoPays — SÖZLEŞMEDEN DOĞRULANDI

`MusteriEntegrasyonOdemeSekli`: Bos=0, **GondericiOder=1**, AliciOder=2,
**EntegrasyonFirmasiOder=3**, EntegrasyonFirmasiKendiOder=4,
EntegrasyonFirmasiOderKendi=5.

`expectedSuratWhoPays` eşlemesi artık TAHMİN DEĞİL: `TRENDYOL_PAYS → 3` =
"entegrasyon firması öder", `SELLER_PAYS → 1` = "gönderici öder". Eşleme
DEĞİŞMEDİ; artık resmî kaynağı var.

### `KargoBarkod` nerede oluşur

`ResultMesaj.Barcode` sözleşmede `{"type":"array","items":{}}` — **tipsiz
dizi**. Sunucu tarafında bu liste `KargoBarkod` taşır. `String → KargoBarkod`
cast'i tam olarak buraya bir MESAJ (string) konmaya çalışıldığında oluşur.
`KargoBarkod` istekte YOKTUR; hata Sürat kendi yanıtını kurarken doğar.

### AÇIK SORU — hangi uç? (DARALTILDI)

**ÜÇ uç AYNI gövdeyi alır** (`OrtakBarkodOlusturParam` → `ResultMesaj`):

```
/api/OrtakBarkodOlustur       ← şu an kullandığımız (GENEL)
/api/PazaryeriGonderi         ← PAZARYERİ, aynı gövde, aynı yanıt
/api/GonderiyiKargoyaGonder
```

`/api/PazaryeriOrtakBarkod` ise FARKLI gövde ister (`MarketPlace{Data:Gonder}`)
ve **`KargoMusteriKodu`** alanına ihtiyaç duyar.

**`KargoMusteriKodu` ÇÖZÜLEMEDİ.** Yalnız bu Swagger'da geçiyor: WSDL'de
YOK, hiçbir PDF'te YOK, hiçbir üretim izinde YOK, kendi commit'lerimden
önceki geçmişte YOK. Sözleşmede açıklama/örnek/varsayılan da YOK (0 adet).
`KARGO_MUSTERI_KODU_CONFIDENCE = UNKNOWN`.

**Tarihsel kanıt yön değiştirdi.** Kanıtlanmış başarılı SOAP operasyonu
`GonderiyiKargoyaGonderYeniSiparisBarkodOlustur`, WSDL'de
`{KullaniciAdi, Sifre, Gonderi: GonderiModel}` alır — yani **adres taşıyan
tam model**. Bu, "pazaryeri gönderisi adres taşımayan uca gitmeli" okumasını
ÇÜRÜTÜR: pazaryeri siparişi için tam `GonderiModel` göndermek tarihsel
olarak ÇALIŞMIŞTIR.

Dolayısıyla en güçlü aday artık **`/api/PazaryeriGonderi`**:

| Ölçüt | PazaryeriGonderi | PazaryeriOrtakBarkod |
| --- | --- | --- |
| İstek gövdesi | **mevcut gövdemizle AYNI** | farklı; yeni alanlar |
| Bilinmeyen alan | **YOK** | `KargoMusteriKodu` UNKNOWN |
| Yanıt | `ResultMesaj` (aynı) | `ResultMesaj` (aynı) |
| Tarihsel şekil uyumu | **EVET** | hayır |
| Pazaryeri farkındalığı | evet (ad) | evet (ad + şekil) |

`EXPECTED_ENDPOINT = /api/PazaryeriGonderi` — **SUPPORTED, PROVEN DEĞİL.**
Sözleşmede hiçbir uç için açıklama metni yoktur; ayrım YALNIZ ad ve şekle
dayanır. Uç ADA BAKARAK değiştirilmez.

**Yanıt tarafı riski YOK:** her iki pazaryeri ucu da `ResultMesaj` döndürür,
yani ayrıştırıcı ve baskı hattı DEĞİŞMEDEN çalışır. Değişecek tek şey YOL.

### `Iademi` — GERİ ALINDI

Canlı sözleşme `GonderiModel.Iademi = {"type":"boolean"}` der. Kısa süre
sayısal `0`'a çevrilmişti; gerekçe 2024 tarihli `GonderiyiKargoyaGonder`
PDF'inin `byte Iademi` satırıydı. O PDF **başka bir ürünün** sözleşmesidir.
Kaynak hiyerarşisinde canlı doğrudan sözleşme üstte olduğu için `boolean`
geri alındı. `IADEMI_FINDING = NOT_A_MISMATCH`.

## Marketplace ön koşulu

`Created` durumundaki paket için `ensureTrendyolPickingBeforeSurat` Sürat'tan
ÖNCE çalışır (`server/index.mjs:3357`, kural `5033-5040`). Başarısız olursa
Sürat ÇAĞRILMAZ (`TRENDYOL_PICKING_UPDATE_FAILED`). Resmî Trendyol dokümanı
depoda YOK; bu kural depo-içi kaynaklıdır.

## Açık madde

`System.InvalidCastException: String → KargoBarkod` —
`OrtakBarkodController.OrtakBarkodOlusturSonuc:1836`. `KargoBarkod` YALNIZ
yanıt DTO'sudur (`tmp/pdfs/surat-services.wsdl:1219`; yalnız `*Result`
tiplerinde). İstekte BULUNAMAZ, dolayısıyla hata Sürat kendi yanıtını
kurarken oluşur. Sınıflandırma için host çelişkisi önce kapanmalıdır.
