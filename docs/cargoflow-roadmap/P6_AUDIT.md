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
