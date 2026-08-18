# P5 — Aras taşıyıcı-nötr temel denetimi

Dal: `feat/carrier-aras-foundation` · taban: `ad9bfd6`

Kapsam (STATE): **taşıyıcı-nötr temel; dış sözleşme doğrulanmalı.**

> Kural (CONTRACT): taşıyıcı wire sözleşmesi **UYDURULMAZ**. Kanıt yoksa faz
> `blocked_external_contract` olur.

---

## 1. ARAS DIŞ SÖZLEŞMESİ — KANIT YOK

| Arama | Sonuç |
| --- | --- |
| Dosya adı `*aras*` | yalnız `tmp/surat-ortak-barkod-arastirma-...md` (Sürat araştırma notu; "araştırma" kelimesi) |
| `Aras Kargo` / `arasKargo` / `ARAS_` literali | **2 gerçek geçiş** (aşağıda) |
| WSDL / OpenAPI / Postman | Aras için **YOK** (`tmp/pdfs/surat-services.wsdl` SÜRAT'a aittir) |
| Fixture | **YOK** |
| Credential şeması girdisi | **YOK** |
| Adapter / client / endpoint | **YOK** |

> **Ölçüm tuzağı — kaydedilmeye değer.** `grep -i "\baras\b"` ONLARCA yanlış
> pozitif verdi (`onboardingRepository.ts`, `index.mjs`, `labelBundlePreparer.ts`
> …). Sebep: Türkçe "**aras**ında" sözcüğünde `ı` (U+0131) UTF-8'de `C4 B1`
> baytlarıdır ve C yerelinde sözcük karakteri SAYILMAZ; bu yüzden `\baras\b`
> eşleşir. "Aras izi var" sonucu çıkarmak ÖLÇÜM HATASI olurdu. Doğrulama
> `Aras Kargo` literaliyle yapıldı.

Gerçek iki geçiş entegrasyon DEĞİLDİR:

1. [providerRegistry.ts:90](../../src/dashboard/providerRegistry.ts) — `Aras Kargo`,
   `enabled: false` görünüm kaydı (Yurtiçi, MNG, PTT, UPS, DHL ile aynı).
2. [surat-canonical-provider-flow.test.mjs:329](../../server/surat-canonical-provider-flow.test.mjs)
   — Aras'ı **yabancı taşıyıcı** olarak kullanan bir test: Sürat şablonu onun
   gönderisine uygulanamaz.

**Karar: `P5_ARAS = blocked_external_contract`.**

---

## 2. TAŞIYICI-NÖTR TEMEL — KANITLI ÖLÇÜDE TAMAMLANDI

Sözleşmeden bağımsız yarı ölçüldü ve **testle kilitlendi**:
[carrier-neutral-foundation-flow.test.mjs](../../server/carrier-neutral-foundation-flow.test.mjs)
(7/7).

Temeldeki asıl soru şudur ve bugün yanıtlanabilir:
**Sürat'a özel kod, kendisine ait OLMAYAN gönderileri sahipleniyor mu?**

### 2.1 ZATEN NÖTR (ölçüldü, kilitlendi)

| Değişmez | Kanıt | Test |
| --- | --- | --- |
| DB sağlayıcı anahtarı TEK kanonik dize (`'surat'`) | `SURAT_PERSISTENCE_PROVIDER` | `CN-1` |
| Görünen ad DB anahtarı olarak KULLANILMAZ | `isSuratProviderName` yalnız doğrulama | `CN-2` |
| Yabancı taşıyıcı adı Sürat'a UYMAZ | Aras/Yurtiçi/MNG/PTT/UPS → `false` | `CN-2` |
| Create ön kontrolü yabancı taşıyıcıyı ENGELLER | `suratAssigned !== false` → `canCallSurat` | `CN-3` |
| İstemci planı yabancı taşıyıcıyı ayrı kovaya koyar | `UNSUPPORTED_CARRIER_MESSAGE` | `CN-4` |
| Render yolu yabancı sağlayıcıyı reddeder | `409 not_surat_shipment`, lookup HİÇ yapılmaz | `CP-8`, `CP-9` (mevcut) |
| Sorgular EXACT eşleşir, fuzzy YOK | `printZplRepository` `eq(...)` | `CP-7` (mevcut) |
| Taşıyıcı kaydı çok sağlayıcılı, tek etkin taşıyıcı | `carrierProviderRegistry` | `CN-5` |
| `shipments.provider` allowlist'i YOK | serbest metin — migration gerekmez | — |

Yani ikinci bir taşıyıcı eklendiğinde **depolama ve sahiplenme sınırı hazırdır**:
Sürat yolu yabancı gönderiye create'te de, render'da da el koymaz.

### 2.2 BİLİNEN ve BİLEREK BIRAKILAN VARSAYILAN

`suratAssigned` YALNIZ `cargoProviderName` doluysa hesaplanır; boşsa `null`
kalır ve `!== false` koşulundan GEÇER. İstemci tarafı da (`App.tsx`) boş adı
Sürat sayar.

- **Bugün DOĞRU:** Trendyol paketi Picking'e alınmadan `cargoProviderName` boş
  gelebilir; bunu bloklamak çalışan akışı durdururdu. Ayrıca Sürat şu an TEK
  etkin taşıyıcıdır (`CN-5`), yani "bilinmeyen" ile "Sürat" pratikte aynıdır.
- **İkinci taşıyıcıda DEĞİŞMELİ:** Aras etkinleştiğinde adı boş bir sipariş
  Sürat yoluna girmeye devam eder ve YANLIŞ taşıyıcıya gidebilir.

Bu yüzden davranış **düzeltilmedi, KİLİTLENDİ** (`CN-6`). Şimdi fail-closed
yapmak, sözleşmesi olmayan bir taşıyıcı için çalışan akışı bozmak olurdu; test
düşmeden değişmesini de engelliyor. İkinci taşıyıcı geldiği gün `CN-6` düşer ve
karar BİLİNÇLİ verilir.

### 2.3 NÖTR DEĞİL — sözleşme bekleyenler

- Create dispatch'i `config.serviceMode` üzerinden yalnız **Sürat servis
  modlarını** tanır; taşıyıcı seçen bir katman YOKTUR.
- Finansal kapı, routing model, ZPL composer, tracking reconciler tasarımı
  gereği Sürat'a özeldir.
- `integration_credentials` CHECK'i hâlâ `('trendyol','surat')` — Aras kimliği
  YAZILAMAZ (P4 ile AYNI tek sert engel).

### 2.4 Adaptör arayüzü NEDEN yazılmadı

P4'teki gerekçenin aynısı, taşıyıcı tarafında: tek gerçek uygulaması olan bir
soyutlama ikinci uygulamanın şeklini TAHMİN eder. Sürat'ın idempotency modeli
(aday T.No/barkod, tesellüm doğrulaması, `FAILED_SAFE`) taşıyıcıya ÇOK özeldir
ve arayüze sızarsa Aras sözleşmesi geldiğinde sökülmesi gerekir.
`CN-7` bunu kilitler: sözleşme gelmeden repoya Aras adaptör/endpoint izi
girmemelidir.

---

## 3. Sözleşme geldiğinde gereken KANIT

1. Resmî API dokümanı / makine-okunur sözleşme,
2. gönderi oluşturma: yol, auth, zorunlu alanlar, **idempotency semantiği**,
3. etiket formatı (ZPL mi, PDF mi) ve barkod/takip kimliği sözleşmesi,
4. iptal/sorgulama uçları ve statü sözlüğü,
5. test/sandbox ortamı — **gerçek gönderi oluşturmadan** doğrulanabilir,
6. hata ve rate-limit sözleşmesi.

## Kapsam DIŞI

- Gerçek taşıyıcı create YOK, mutasyon YOK.
- `2.2`'deki varsayılan DEĞİŞTİRİLMEDİ — ikinci taşıyıcı olmadan değiştirmek
  kanıtsız davranış değişikliğidir.
- `integration_credentials` migration'ı YAPILMADI.

---

# YENİDEN AÇILDI — TEST SÖZLEŞMESİ DOĞRULANDI (2026-08-19)

`external_contract_status = VERIFIED_PUBLIC_OFFICIAL_TEST_CONTRACT`
`production_endpoint_status = UNVERIFIED`

Kaynak: **Aras Kargo resmî genel TEST web servisi**
(`customerservicestest.araskargo.com.tr/arascargoservice/arascargoservice.asmx`).

## Uygulanan (dal: `feat/carrier-aras-foundation`)

| Modül | Kapsam |
| --- | --- |
| `carriers/aras/arasContract.ts` | uç nokta çözümü · SetOrder alan kümesi · COD bilinen/bilinmeyen · sonuç sınıflandırma |
| `carriers/aras/arasSetOrder.ts` | alan BEYAZ LİSTESİ · SOAP 1.1 zarfı · IntegrationCode |
| `carriers/aras/arasLabelArtifact.ts` | ZPL/EPL/IMAGE bağımsız · değişmez artefakt · reprint |
| `carriers/aras/arasVerification.ts` | tek korelasyon anahtarlı doğrulama makinesi |

Testler: `carrier-aras-contract-flow.test.mjs` (25/25), `REAL_CARRIER_NETWORK=1`
ile çalıştırılırsa dosya BAŞTA durur.

## ÜRETİM ADRESİ TÜRETİLMEDİ — neden

Hepsiburada'da `-sit` → üretim dönüşümü RESMÎ olarak belgelenmiştir ve orada
uygulandı. Aras'ta böyle bir kural YOKTUR; test host'undan üretim host'u
türetmek TAHMİN olurdu. `resolveArasEndpoint` üretim adresi yapılandırılmadıysa
fail-closed döner.

## COD — alan VAR, DEĞER TABLOSU YOK

Sözleşme `CodAmount`, `CodCollectionType`, `CodBillingType`, `PayorTypeCode`,
`IsCod` alanlarının VARLIĞINI kanıtlar. **Alanın varlığı, alabileceği sayısal
değerleri kanıtlamaz.** Bu yüzden:

- COD OLMAYAN gönderi TAM desteklenir (gerekli her şey ispatlanabilir),
- COD gönderi, doğrulanmış değerler açıkça enjekte edilmedikçe FAIL-CLOSED
  (`ARAS_COD_VALUE_TABLE_UNVERIFIED`).

Yanlış COD kodu, tahsilatın yanlış tarafa yazılması demektir.

## `ResultCode` anlam tablosu da YOK

`0` dışındaki kodların iş anlamı dokümante değildir; bu yüzden "hangi kod ne
demek" UYDURULMAZ. `0` dışı başarı VARSAYILMAZ ve ham kod/mesaj korunur.

## Hazırlık maddeleri (kod fazını BLOKLAMAZ)

| Madde | Durum |
| --- | --- |
| `ARAS_PRODUCTION_ENDPOINT` | BLOCKED_EXTERNAL_ENVIRONMENT |
| `ARAS_PRODUCTION_CREDENTIAL` | BLOCKED_EXTERNAL_ENVIRONMENT |
| `ARAS_COD_VALUE_TABLE` | BLOCKED_EXTERNAL_CONTRACT (COD fail-closed kalır) |
