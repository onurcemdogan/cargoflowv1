# Trendyol pazaryeri create — doğrulanmış SOAP birincil rotası

Dal: `feat/surat-soap-primary-marketplace` (üretim HEAD `9f1e802`).

Bu turda hiçbir canlı create yapılmadı, hiçbir taşıyıcı ağ çağrısı kuruldu,
üretime hiçbir yazma ve hiçbir dağıtım yapılmadı; başarısız hiçbir sipariş
yeniden oynatılmadı.

---

## 1. Neden

Kanonik REST yolu artık **doğru kiracı ve doğru kimlikle** çağrıldığı hâlde
reddediliyor. Üretim izi (TarzimTuba · organizasyon `****f4ad` · entegrasyon
`****8c4f`) dört sınırda da `LEN10:****0944` gösterdi ve
`credentialFingerprintMatch=true` idi. Yani kimlik sorunu ELENDİ.

Taşıyıcı hatası:

```
System.InvalidCastException: Unable to cast object of type 'System.String'
to type 'KargoBarkod'
  SK_WebService.Api.Controllers.OrtakBarkodController
    .OrtakBarkodOlusturSonuc(...) line 1836
```

Hata taşıyıcının **kendi sonuç kurucusundadır**. Depoda doğrulanmış başarı
ise SOAP yolundadır:

```
orderNumber      11415535074
serviceType      OrtakBarkodOlusturSoap
operationName    OrtakBarkodOlustur
responseCode     013  (BARCODE_SUCCESS)
verifiedShipment true
finalSuratBarcode Web00157962154
```

---

## 2. Kapsam — bilerek DAR

Yalnız `SURAT_CANONICAL_API` modu değiştirilir. Kiracı `PRE_REGISTRATION_REST`,
`GONDERI_YENI_SOAP` ya da hâlihazırda `ORTAK_BARKOD_SOAP` seçtiyse **o seçim
korunur**. Bu tenantlar KIRIK DEĞİLDİR; onları sessizce yeniden yönlendirmek
bu düzeltmenin kılığına girmiş BAŞKA bir değişiklik olurdu.

Uygunluk pazaryeri bazındadır: depo kanıtı Trendyol içindir.

---

## 3. Bu bir geri düşüş DEĞİLDİR

`resolveSuratPrimaryCreateRoute` önceki denemenin sonucunu **göremez**, çünkü
öyle bir girdi ALMAZ.

Cast hatası sonuç kurucusunda oluştuğu için gönderinin taşıyıcıda
**oluşmadığı KANITLANMAMIŞTIR**. "Kanonik başarısız oldu → SOAP'ı dene" akışı
bu yüzden ikinci bir FİZİKSEL gönderi riskidir.

Mevcut idempotency yaşam döngüsü olduğu gibi korunur:

| Kayıt durumu | Davranış |
| --- | --- |
| `SUCCESS` | replay; semantik değişmişse FAIL CLOSED |
| `IN_PROGRESS` / `UNKNOWN` | bloklanır |
| `FAILED_SAFE` | açık yetkilendirme olmadan bloklanır |
| `createCallCount >= 1` | bloklanır |

Anahtar `SURAT:<tenant>:<order>:CREATE` — `serviceMode` anahtara **girmez**.
Birincil mod değişimi bu yüzden yeni bir kilit doğurmaz.

---

## 4. Legacy adaptör ≠ legacy kimlik

SOAP zarfı değiştirilmedi. Kimlik güvenceleri ise kanonik yolla AYNI:

- dondurulmuş kiracı kimlik anlık görüntüsü (istek gövdesi kimlik için
  OKUNMAZ),
- **iki** parite kapısı:
  1. zincir başlamadan (doğrulanmış zincirin ilk ağ çağrısı SOAP değil,
     kayıt tescilidir — pariteyi yalnız zarfta ölçmek, ayrışma hâlinde
     tescilin ZATEN yapılmış olması demekti ve "ağ çağrısı 0" iddiası
     doğru olmazdı),
  2. gerçek ağ sınırında, serileşen zarf üzerinden.
- Trace V2 tam yaşam döngüsü: `PRE_FLIGHT · ROUTING · REQUEST_READY ·
  ACTUAL_WIRE_READY · CARRIER_CALL_STARTED · CARRIER_RESPONSE ·
  VERIFICATION · FINAL`.

Gerçek tel yakalaması zarftan yapılır: alan ADLARI ve TİPLERİ görünür, PII
DEĞERLERİ ve ham kimlik ASLA taşınmaz.

`WhoPays` / `KimOder` / `FirmaId` doğrulanmış SOAP `Gonderi` sözleşmesinde
YOKTUR ve bu yüzden EKLENMEDİ; yalnız "sözleşmede yok" olarak raporlanır.

---

## 5. Başarı sözleşmesi

HTTP 200 tek başına başarı değildir; 013 de tek başına yeterli değildir.

| Kod | Sınıf | Anlam |
| --- | --- | --- |
| 013 / 016 + takip + barkod | `CREATED_CONFIRMED` | artefaktlar tam |
| 016, artefakt eksik | `CREATED_VERIFICATION_INCOMPLETE` | doğrulama eksik |
| 039 | `SAVED_BARCODE_FAILED` | KAYIT OLUŞTU, barkod yok — kör tekrar mükerrer gönderi demektir |
| 038 | `RETRYABLE_CARRIER_BUSY` | denetimli tekrar |
| ERROR | `REJECTED_BUSINESS_RULE` | terminal |

Legacy `ok` alanı **ezilmedi**. Depo modeli iki ayrı başarı seviyesi tanır
(`src/utils/suratCreateResult.ts`): yazdırılabilir etiket oluşturma başarısı
ile fiziksel taşıyıcı kabulü AYNI ŞEY DEĞİLDİR ve ikincisi birincinin
önkoşulu değildir. `ok`u sınıflandırmayla AND'lemek doğrulanmış etiketleri
"başarısız" gösterirdi. Sınıflandırma ayrı alanlarda taşınır.

Operatör yüzeyi artık dört durumu ayırır: `CARRIER_NOT_CALLED` ·
`SAVED_BARCODE_FAILED` · `CREATE_FAILED` · `LABEL_READY_AWAITING_ACCEPTANCE`
/ `VERIFIED`.

---

## 6. Açık kalan — dürüstlük notu

Depo kanıtının kendisi (`docs/surat-service-map.md`) şunu söyler:
`OrtakBarkodOlustur` **tek başına** create adayı DEĞİLDİR; 013 + ZPL, 30
dakika sonra `Gonderiler=0` dönerse `LABEL_CREATED_NOT_REGISTERED` olur.

Bu yüzden bu rota "gönderi kesin oluştu" DEMEZ. Kayıt kanıtı hâlâ read
teyidinden gelir ve mevcut yaşam döngüsü bunu zaten uygular. Rota birincil
yapıldı; kayıt doğrulama sözleşmesi GEVŞETİLMEDİ.
