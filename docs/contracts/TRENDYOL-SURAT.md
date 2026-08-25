# Sözleşme kaydı — TRENDYOL × SÜRAT

Sırlar İÇERMEZ. Her satır KANIT SEVİYESİ taşır.

| Alan | Değer | Kanıt seviyesi |
| --- | --- | --- |
| Marketplace | Trendyol | OFFICIAL |
| Carrier | Sürat Kargo | OFFICIAL |
| Servis modu | `SURAT_CANONICAL_API` | PRODUCTION (canary precheck, TarzimTuba) |
| Host | `https://api02.suratkargo.com.tr` | **ÇELİŞKİLİ** — aşağıya bakın |
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

## Host — ÇÖZÜLMEMİŞ ÇELİŞKİ

| Kaynak | api01 | api02 |
| --- | --- | --- |
| Sürat PDF ×3 (`tmp/pdf-text/`) | **Canlı Link** | **Test Link** |
| `server/index.mjs:70-75` (legacy REST sabitleri) | `SURAT_REST_LIVE_BASE_URL` | `SURAT_REST_TEST_BASE_URL` |
| `suratWebApiClient.ts:29-36` (kanonik) | — | "VENDOR_CONFIRMED_LIVE" |

Kanonik istemcinin iddiasını destekleyen ARTEFAKT DEPODA YOK: `ef944e2`
commit metni ve kod yorumu dışında e-posta/Swagger/örnek bulunamadı
(`git log --all -S"api02"` tarandı). `HOST_CONTRACT_CONFIDENCE = CONFLICTING`.

Host DEĞİŞTİRİLMEDİ: api01'e geçmek gerçek ve faturalanabilir gönderi
yaratabilir; önce satıcı teyidi gerekir.

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
