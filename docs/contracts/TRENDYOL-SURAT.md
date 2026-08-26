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

## Canlı sözleşmenin söyledikleri — ve SÖYLEMEDİKLERİ

`docs/contracts/surat-web-api-swagger-v2.json` (api02'den alındı, sır
İÇERMEZ) **20 uç** listeler. ANCAK: hiçbir uç için `parameters`,
`definitions` ya da yanıt şeması YOKTUR — yalnız yol listesidir.

Dolayısıyla bu sözleşme alan tiplerini (`Iademi` dahil) ve `KargoBarkod`
rolünü **BELİRLEYEMEZ**. Bu sorular hâlâ açıktır.

### AÇIK SORU — pazaryeri için AYRI uç var

Listede şunlar da bulunuyor:

```
/api/OrtakBarkodOlustur      ← şu an KULLANDIĞIMIZ (genel)
/api/PazaryeriOrtakBarkod    ← pazaryeri ortak barkod
/api/PazaryeriGonderi        ← pazaryeri gönderi
/api/CreateCommonBarcode
```

Biz `Pazaryerimi=1` + `EntegrasyonFirmasi=Trendyol` taşıyan bir pazaryeri
gönderisini **GENEL** uca gönderiyoruz. Genel ucun sonuç kurucusunun
pazaryeri gönderisini işleyememesi, gözlenen
`String → KargoBarkod` cast hatası için **KANITA DAYALI BİR ADAYDIR**.

**UÇ DEĞİŞTİRİLMEDİ.** Swagger bu uçların gövdesini belgelemiyor;
`PazaryeriOrtakBarkod`'un ne kabul ettiği ve ne döndürdüğü BİLİNMİYOR.
Kanıtsız uç değiştirmek `bfcf7b8` hatasının tekrarı olur. Sürat'a sorulacak
soru budur.

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
