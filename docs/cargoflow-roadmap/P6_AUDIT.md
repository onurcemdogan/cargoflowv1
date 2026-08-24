# P6 — Sürat pazaryeri dışı sözleşme denetimi

Dal: `feat/surat-non-marketplace-contract` · taban: `8279acf`

Kapsam (STATE): **pazaryeri dışı sözleşme kanıtı gerekli.**

> P6, P4/P5'ten FARKLIDIR: burada taşıyıcı entegre. Eksik olan sağlayıcı değil,
> sözleşmenin pazaryeri DIŞI dalıdır.

---

## 1. ZATEN VAR — model pazaryeri dışını TANIYOR

[suratCanonicalGonderiModel.ts](../../server/shipments/suratCanonicalGonderiModel.ts):

- `resolveSuratMarketplaceContext(order, { ownPlatformReference })` →
  `OWN_PLATFORM`, `pazaryerimi: 0`, `entegrasyonFirmasi: ''`,
- `validateSuratBillingContext` **ayrı bir pazaryeri dışı dalı** taşır ve
  fail-closed'dır: `pazaryerimi` 0, `entegrasyonFirmasi` boş ve referans DOLU
  olmak zorunda,
- wire alanları WSDL'de MEVCUT: `Pazaryerimi`, `OzelKargoTakipNo`,
  `EntegrasyonFirmasi` (`tmp/pdfs/surat-services.wsdl`).

Testle kilitlendi:
[surat-non-marketplace-boundary-flow.test.mjs](../../server/surat-non-marketplace-boundary-flow.test.mjs)
(4/4).

## 2. AÇIK — yol BAĞLI DEĞİL, çünkü tek bir vendor kuralı EKSİK

`ownPlatformReference` için **üretim çağıranı YOKTUR**. `grep` sonucu: yalnız
modelin kendi tanımı ve iki test. Yani bugün hiçbir çalışma zamanı yolu
pazaryeri dışı gönderi üretemez.

Bu, P2'deki imlecin ve P3'teki parmak izinin AYNI kusuru değildir — orada
üretilen kanıt tüketilmiyordu. Burada **bilerek bağlanmamış**: modelin kendi
yorumu bunu açıkça söyler — *"Pazaryeri dışı gönderide `ozelKargoTakipNo`
DIŞARIDAN verilir; burada yeni üretici yazılmaz."*

### Eksik olan TEK gerçek

Sürat, `Pazaryerimi=0` gönderisinde `OzelKargoTakipNo` alanına **ne bekliyor?**

- Format/uzunluk kısıtı var mı?
- Tekillik kapsamı ne (gönderici hesabı başına mı, global mi)?
- Boş bırakılabilir mi, yoksa zorunlu mu?
- Bu değer borçlandırma sınıflandırmasını nasıl etkiliyor?

`docs/surat-finalization/CONTRACT.md` YALNIZ pazaryeri dalını belgeler
(`Pazaryerimi=1 · EntegrasyonFirmasi='Trendyol'`). WSDL alan ADLARINI verir,
**iş kuralını vermez**.

### Neden tahmin edilemez

Modelin kendi uyarısı: `orderNumber`/`packageId`/`ReferansNo`'ya fallback
**Sürat'in borçlandırma sınıflandırmasını BOZAR**. Yani yanlış formatta bir
referans üretmek, yanlış cariye borç yazılmasına yol açabilir — bu yol
haritasının baştan beri kaçındığı **geri alınamaz finansal hata** sınıfı.

Bir referans üreticisi yazmak, sözleşme kanıtı olmadan tam olarak bu riski
almaktır.

**Karar: `P6_SURAT_NON_MARKETPLACE = blocked_external_contract`.**

## 3. Bu fazda YAPILAN (sözleşmeden bağımsız)

Sınır AÇIK ve FAIL-CLOSED olarak kilitlendi:

| Değişmez | Test |
| --- | --- |
| Pazaryeri dışı bağlam `pazaryerimi=0`, `entegrasyonFirmasi=''` üretir | `NM-1` |
| Referans verilmezse gönderi GEÇERSİZ (fail-closed) | `NM-2` |
| Pazaryeri dışı gönderi `entegrasyonFirmasi` ile faturalanamaz | `NM-3` |
| Referans ÜRETİCİSİ repoda YOK ve sessizce eklenemez | `NM-4` |

`NM-4` asıl koruma: üretim kodunda `ownPlatformReference` çağıranı belirirse
test DÜŞER. O gün ya vendor kuralı doğrulanmıştır (P6 açılır, test güncellenir)
ya da referans UYDURULMUŞTUR (test doğru şekilde engeller).

## 4. Sözleşme geldiğinde gereken KANIT

1. Vendor'ın `Pazaryerimi=0` için yazılı talimatı,
2. `OzelKargoTakipNo` format/tekillik kuralı,
3. borçlandırmanın pazaryeri dışı gönderide hangi cariye yazıldığı,
4. test ortamında **gerçek gönderi oluşturmadan** doğrulama yolu.

## Kapsam DIŞI

- Referans üreticisi YAZILMADI.
- Gerçek taşıyıcı create YOK, mutasyon YOK.

---

# ÇÖZÜLMEMİŞ SÖZLEŞME ALANLARI — KESİN KAYIT

Aşağıdaki alanların pazaryeri DIŞI dal için değeri **bilinmiyor**. Hiçbiri
tahmin edilmeyecek: her biri yanlış cariye borç yazma riski taşır ve bu hata
geri alınamaz.

| Alan | Pazaryeri dalı (KANITLI) | Pazaryeri dışı (BİLİNMİYOR) |
| --- | --- | --- |
| `billingParty` | `TRENDYOL_PAYS` (whoPays yok) / `SELLER_PAYS` (=1) | Trendyol sözleşmesi UYGULANMAZ. Kimin borçlandığı tanımsız. |
| `credentialRole` | `PRIMARY_MARKETPLACE` | Hangi cari? Pazaryeri carisi burada geçerli DEĞİL olabilir. |
| `Pazaryerimi` | `1` | Model `0` üretiyor; vendor'ın `0` için kuralı DOĞRULANMADI. |
| `EntegrasyonFirmasi` | `'Trendyol'` | Boş (`''`) mu, başka bir değer mi — teyit YOK. |
| `OzelKargoTakipNo` provenance | sağlayıcı `cargoTrackingNumber` (727…) | Sağlayıcı YOK. Format/uzunluk/tekillik kapsamı BİLİNMİYOR. |
| `ReferansNo` / gönderi kimliği | `packageId` | Hangi alanın kimlik sayılacağı ve borçlandırmayı nasıl etkilediği BİLİNMİYOR. |
| COD etkileşimi | COD bağımsız eksen; rol `DEDICATED_COD`/`SELLER_PAYS`/`PRIMARY` | Pazaryeri dışı + kapıda ödeme birleşimi HİÇ tanımlanmadı. |

## P6 YALNIZ ŞUNLARDAN BİRİYLE AÇILIR

1. **Resmî Sürat dokümantasyonu** — WSDL/XSD/PDF ya da teknik entegrasyon
   kılavuzunun `Pazaryerimi=0` dalını tanımlayan bölümü.
2. **Yazılı Sürat teknik teyidi** — vendor'dan alınmış, yukarıdaki alanları
   açıkça belirten yazılı onay.
3. **Doğrulanmış üretim artefaktı** — pazaryeri dışı, bilinen-iyi bir gönderi
   ve onun **kanıtlanmış borçlandırma/cari sonucu**.

Sözlü aktarım, benzetme, "muhtemelen pazaryeri gibidir" ve başka taşıyıcıdan
genelleme **yeterli değildir**.

## O ANA KADAR GEÇERLİ DEĞİŞMEZ

```
UNKNOWN_NON_MARKETPLACE_BILLING
  → PRE_FLIGHT BLOCKED
  → NETWORK_CALL = 0
```

S1'in fail-closed finansal guard'ı **gevşetilmeyecek**. `NM-4` üretim kodunda
bir `ownPlatformReference` çağıranı belirdiği an düşer; o gün ya sözleşme
kanıtlanmıştır ya da bir referans uydurulmuştur.

## Yol haritası durumu

```
ROADMAP_IMPLEMENTATION_COMPLETE = YES   (P1–P5 geçti, 51/51)
ROADMAP_OPERATIONAL_COMPLETE    = NO    (P6 dış sözleşmeye bağlı)
```

Bu ayrım kasıtlıdır: kod tarafı bitti, operasyonel kapsam bitmedi.
