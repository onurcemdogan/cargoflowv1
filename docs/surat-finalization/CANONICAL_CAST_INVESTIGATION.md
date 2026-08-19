# Sürat kanonik `OrtakBarkodOlusturSonuc` cast hatası — inceleme

Tarih: 2026-08-19 · Dal: `fix/surat-canonical-cast-and-debug-v3`

## Gözlenen üretim hatası

```
System.InvalidCastException:
Unable to cast object of type 'System.String' to type 'KargoBarkod'
at SK_WebService.Api.Controllers.OrtakBarkodController
   .OrtakBarkodOlusturSonuc(...) line 1836
```

Başarısız sipariş: `11518942910`. UI'de `72700360…` ailesinden bir pazaryeri
kimliği görünüyor.

---

## 1. DEBUG KUSURU — KÖK NEDEN BULUNDU ve DÜZELTİLDİ

`DEBUG_ROOT_CAUSE = TRACE_V2_BUILT_BUT_NEVER_PERSISTED`

Ölçüm (tahmin değil):

| Halka | Durum |
| --- | --- |
| Sunucu izi üretir (`createTraceAttempt`/`appendTraceStage`) | ✅ VAR |
| Sunucu izi yanıtta döndürür (`traceAttempt`) | ✅ VAR |
| İstemci yanıttan izi okur | ❌ `traceAttempt` **`src/` içinde HİÇ GEÇMİYOR** |
| İstemci deposu yazıcısı `appendTrace` çağrılır | ❌ **SIFIR çağıran** |
| Panel `localStorage`'dan okur | ✅ ama depo DAİMA boş |

Sonuç: gerçek bir create denemesinden hemen sonra bile Canlı Debug
"Henüz bir Sürat gönderi denemesi kaydedilmedi." diyordu. Eski panellerin
dolu görünmesi çelişki değildi: onlar **operasyonel** kayıtları okuyordu.

> Bu, bu depoda **üçüncü** kez görülen aynı kusur ailesidir:
> P2 imleci yazdı/okumadı · P3 parmak izini yazdı/kıyaslamadı ·
> burada iz üretildi/saklanmadı.

**Düzeltme:** `surat_trace_attempts` (migration `0009`) — kiracı kapsamlı,
`(org, traceId)` tekil (deneme DEĞİŞMEZ), append-only aşamalar,
`schemaVersion=2`, 7 gün / 200 iz saklama. `shipment_operations` **debug
geçmişi olarak KULLANILMAZ**: debug silinebilir olmalı, operasyonel kayıt asla.

Yazıcı artık **gerçekten çağrılıyor** (`DEBUG-14`), yanıttan ÖNCE ve
**başarı/başarısızlık fark etmeksizin** — yalnız başarıda yazmak, tam da tanı
gereken durumu kayıtsız bırakırdı.

---

## 2. BARKOD HATASI — KANIT DURUMU

### Yapılamayan (dürüst sınır)

Bu geliştirme ortamında **üretim veritabanı erişimi YOKTUR** (`.env` yok,
`DATABASE_URL` tanımsız). Sipariş `11518942910` depoda YALNIZ benim yazdığım
test fixture'ında geçiyor.

Dolayısıyla Part 6/7'nin istediği alan-alan / tip-tip karşılaştırma **o
siparişin gerçek isteği/yanıtı üzerinden YAPILAMADI**. Bunu "yaptım" diye
raporlamak uydurma olurdu.

`LATEST_FAILED_ORDER_FOUND_AT_CARRIER = NOT_CHECKED_NO_PRODUCTION_ACCESS`

### Yapılan — depo kanıtı

Depoda **tarihsel, doğrulanmış başarılı** bir create artefaktı var:

```json
{
  "orderNumber": "11415535074",
  "serviceType": "OrtakBarkodOlusturSoap",
  "operationName": "OrtakBarkodOlustur",
  "responseCode": "013",
  "responseCategory": "BARCODE_SUCCESS",
  "verifiedShipment": true,
  "zplReady": true,
  "finalSuratBarcode": "Web00157962154"
}
```

**Kritik gözlem:** tarihsel BAŞARILI çağrı `OrtakBarkodOlusturSoap` — yani
**SOAP** yolu (`ORTAK_BARKOD_SOAP`). Bugün patlayan yığın izi ise
`SK_WebService.Api.Controllers.OrtakBarkodController` — yani **kanonik REST**
denetleyicisi (`SURAT_CANONICAL_API`).

Yani başarısı KANITLI olan yol ile bugün hata veren yol **AYNI YOL DEĞİLDİR**.
Bu, Part 10'un aradığı "daha önce çalışan mod" sorusuna doğrudan bir aday verir
ve bu aday **uydurma değil, depoda kanıtlı**.

### Yığın izinin söylediği

Hata `OrtakBarkodOlusturSonuc` — **sonuç kurucusu**. İstek doğrulaması değil.
Taşıyıcı, kendi yanıt DTO'sunu kurarken `String` → `KargoBarkod` cast'i
deniyor. Bu, gönderi **kaydedildikten sonra** da olabilir.

> "Exception aldık, demek ki gönderi oluşmadı" çıkarımı **KANITSIZDIR** ve
> tehlikelidir: ona göre davranmak ikinci bir fiziksel gönderi demektir.

---

## 3. SINIFLANDIRMA

`BARCODE_ROOT_CAUSE_CLASSIFICATION = CARRIER_CANONICAL_ENDPOINT_CAST_BUG_PLAUSIBLE`

**PLAUSIBLE — PROVEN DEĞİL.** Gerekçe:

- cast, taşıyıcının KENDİ sonuç kurucusunda ve KENDİ tip sisteminde oluşuyor;
- aynı iş akışının SOAP karşılığı tarihsel olarak `013 BARCODE_SUCCESS` verdi;
- ama başarısız denemenin gerçek isteği/yanıtı **elimizde yok**, dolayısıyla
  "bizim gönderdiğimiz bir alan bu cast'i tetikliyor" ihtimali **elenmedi**.

Elenmediği için `OUR_REQUEST_CONTRACT_BUG` / `OUR_TYPE_MAPPING_BUG`
**dışlanmamıştır**. Kanıt geldiğinde sınıflandırma güncellenmelidir.

Kesinleştirmek için gereken (artık toplanabilir): bir sonraki gerçek denemenin
Trace V2 kaydı — bu düzeltmeyle birlikte **artık kalıcı olarak saklanıyor** ve
istek şekli/tip bilgisi orada olacak.

---

## 4. KURTARMA ve FALLBACK

`suratCanonicalCastRecovery.ts`:

| Kanıt | Sınıf | İkinci create |
| --- | --- | --- |
| gönderi VAR + etiket VAR | `RECOVERED_AFTER_CANONICAL_RESULT_ERROR` | **YOK** |
| gönderi VAR + etiket YOK | `SAVED_BARCODE_FAILED` | **YOK** |
| gönderi YOK (sınırlı doğrulama) | `CANONICAL_RESULT_CAST_FAILED_NO_CONFIRMED_CREATE` | yalnız açık onayla |
| doğrulama tamamlanmadı | `INSUFFICIENT_EVIDENCE` | **YOK** |

`SAVED_BARCODE_FAILED` mesajı birebir: **"Sürat gönderiyi kaydetti ancak barkod
üretmedi."** — "etiket oluşturuldu" ya da "barkod bekliyor" **DEMEZ** (`CAST-2`).

Fallback denetçisi **dry-run** ve **varsayılan KAPALI**
(`LEGACY_FALLBACK_DEFAULT_ENABLED = false`). Dokuz koşulun HEPSİ gerekir;
özellikle `carrierCreateCallCount === 1` ve açık yetkilendirme. Bu oturumda
fallback **çalıştırılmadı**.

---

## 5. SONRAKİ ADIM (tek kontrollü deneme)

Artık bir sonraki gerçek deneme **kanıt bırakacak**: Trace V2 kaydı kiracı
kapsamında saklanıyor, sayfa yenilense de duruyor ve başarısız denemeler de
yazılıyor. O kayıt geldiğinde:

1. istek alan/tip karşılaştırması gerçek veriyle yapılabilir,
2. sınıflandırma `PLAUSIBLE`'dan çıkarılabilir,
3. gerekiyorsa SOAP yolunun fallback uygunluğu dry-run denetçisiyle ölçülür.
