# BARCODE_SOAP reddi — forensik sonuç

Üretim izi `CF-4103294752` · paket `4103294752` · takip `7270036349823921`
Taban: `72a1c12`

## Kanıtlanan

REST→SOAP devamı **çalışıyor**: iz iki ağ sınırı dizisi taşıyor. Yönlendirme,
finansal kapı, kiracı kimliği ve parite DOĞRU:
`snapshot = networkBoundary = LEN10:****0944`, `match = true`.

Reddeden adım BARCODE_SOAP. Taşıyıcı yanıtı:

```
Bilgiler güncellenirken hata oluştu.
```

## Bu mesaj depoda TANIMLI DEĞİL

Tek geçtiği yer [surat-flow.test.mjs](../../server/surat-flow.test.mjs) içinde
**sentetik** bir `FAILBARCODE` fikstürü ve o da FARKLI bir operasyon için
(`GonderiyiKargoyaGonderYeniSiparisBarkodOlustur`). `OrtakBarkodOlustur` için
bu mesajın anlamı, kodu ya da düzeltmesi hakkında depoda kanıt YOKTUR.

## Çağrı SIRASI hakkında bilinmeyen

`labelOnlyChain` (`index.mjs:3544`) `serviceType === 'OrtakBarkodOlusturSoap'`
ya da yol `/OrtakBarkodOlustur` ise **iki adımlı** zinciri seçer:
REST kayıt → SOAP barkod. SOAP bacağı `eecd6a2` (2026-07-17) ile
`72a1c12` arasında **erişilemezdi** — dolayısıyla doğrulanmış `013` başarısı
iki adımlı zincirden GELMİŞ OLAMAZ.

Depodaki `013` artefaktı şunları kaydeder: `orderNumber`, `serviceType`,
`operationName`, `responseCode`, `verifiedShipment`, `finalSuratBarcode`.
**Kaydetmediği:** `createShipmentPath` ve o çağrıdan önce bir REST kaydının
yapılıp yapılmadığı.

SOAP bacağı `Gonderi` gövdesinin TAMAMINI yeniden gönderiyor
(`buildSuratShipmentPayload(..., { commonBarcode: true })`), yani REST'in az
önce oluşturduğu kaydı GÜNCELLEMEYE çalışıyor olabilir — taşıyıcının
"güncellenirken hata" demesi bununla tutarlıdır. Ama bu bir HİPOTEZDİR.

## EKSİK OLAN TEK ŞEY

`OrtakBarkodOlustur` operasyonunun, aynı paket için REST
`GonderiyiKargoyaGonder` ÇAĞRILDIKTAN SONRA nasıl davranması gerektiği:

1. Bağımsız bir create+barkod mudur (öyleyse önce REST YAPILMAMALI)?
2. Yoksa kayıt sonrası barkod adımı mıdır (öyleyse gövde ne taşımalı —
   tam `Gonderi` mi, yalnız referans mı)?
3. `Bilgiler güncellenirken hata oluştu.` hangi alan/kural ihlalini gösterir?

Bunlar **taşıyıcı tarafı kurallardır**. Depoda, tarihsel artefaktta, WSDL/XSD
ya da teknik dokümanda karşılığı YOK (repoda WSDL/XSD/PDF izlenmiyor).

Tahmin ederek payload değiştirmek, kayıt zaten oluşmuşken ikinci bir fiziksel
gönderi ya da bozuk bir güncelleme riskidir.

`BLOCKED_EXTERNAL_CONTRACT = YES`

## Bu turda YAPILAN

İki bacak artık izde AYRI görünür (`legs` projeksiyonu): REST başarısı SOAP
hatasını GİZLEMEZ. Önceki davranışta tek bir `CARRIER_RESPONSE` gösteriliyordu.
