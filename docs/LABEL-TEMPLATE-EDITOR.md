# Kodsuz Etiket Şablonu Düzenleyicisi

Bu belge, operatörün **kaynak kodu değiştirmeden** etikete ne yazdırabildiğini
ve neyi yazdıramadığını tanımlar. Amaç, "düğme var ama hiçbir şey olmuyor"
durumunu kalıcı olarak ortadan kaldırmaktır.

## Kök neden (bu iş neden gerekti)

Düzenleyici ekranı vardı; çıktısı **hiçbir yerde okunmuyordu**:

- `template.fields` baskı ZPL'ine girmiyordu (`buildLabelData` yalnız
  `template.id` alanını kullanıyordu).
- HTML önizleme de alanları okumuyordu.
- Şablon yalnız **tarayıcı localStorage'ında** duruyordu; sunucudaki baskı
  yolu (`attachPrintZplArtifact`) onu göremiyordu. Yani başka bir cihazda ve
  arka plan otomatik etiketinde ayar **yoktu**.

Sonuç: alan yazılıyor, okunmuyordu.

## Etiketin sahiplik haritası

| Bölge | Sahibi | Kiracı ne yapabilir |
| --- | --- | --- |
| Code128, DataMatrix, 727 QR, T.No | **Taşıyıcı** | Hiçbir şey (değer de sunum da kilitli) |
| Adres, alıcı adı, telefon, il/ilçe, rota, aktarma | **Taşıyıcı** | Hiçbir şey |
| Ürün satırı (`2 x Ürün A (Renk: …) [SKU]`) | Composer | Parçaları aç/kapa |
| Ürün satırının altındaki bant | Composer | Blok ekle, sırala, punto, kalın, üst/alt |

Taşıyıcının bastığı metnin puntosunu değiştiremeyiz: o komutlar taşıyıcının
ZPL'inde gelir ve composer beyaz listesi onlara dokunmaz. Düzenleyici bu
satırlara **kasıtlı olarak düğme koymaz** — çalışmayan bir düğme, operatöre
sahte bir yetki göstermek olurdu.

## Kiracının gerçekten yapabildikleri

### 1. Ürün satırının parçaları

`Adet`, `Varyant`, `SKU` kutuları mevcut ürün satırının bileşenleridir.
Kapatılan parça **hiç basılmaz**; boş `()` veya sarkan `[]` oluşmaz.

- `Adet` kapalı → `Ürün A (Renk: Siyah, Beden: M) [SKU-1]`
- `SKU` kapalı → `2 x Ürün A (Renk: Siyah, Beden: M)`

Bu parçaların ayrı punto düğmesi **yoktur**: ürün satırının kendi sığdırma
merdiveni (`SURAT_FOOTER_PROFILES`) puntoyu otomatik seçer; elle punto vermek
o merdiveni bozardı.

### 2. Ayrı satır olarak basılan bloklar

`Satın Alan Adı`, `Sipariş Tarihi`, `Sipariş Saati`, `Paket No`,
`Sipariş No`, `Pazaryeri`.

Her blok için: **görünürlük**, **sıra** (sürükle-bırak), **punto** (10–60 dot),
**kalın**, **konum** (üst / orta / alt).

Bu bloklar **kapalı doğar**. Açık doğsalardı bir sürüm yükseltmesi mevcut
kiracıların etiketini kendiliğinden değiştirirdi.

## Kimlik kilidi

`shipmentCode`, `trackingNumber`, `shippingProvider` blokları
`IDENTITY_LOCKED_LABEL_FIELDS` içindedir ve `isTenantRenderableBlock` bunları
reddeder. Operatör bir barkodun değerini `packageId`, `orderNumber` veya
rastgele bir jetona **çeviremez**:

- Düzenleyicide bu satırlarda serbest metin girişi ve sunum kontrolü yoktur.
- Sunucu deposu (`normalizeLabelTemplateFields`) bu anahtarları gövdeden atar
  ve `rejected` listesiyle **açıkça** bildirir — bozuk veya kötü niyetli bir
  istemci gövdesi de yazamaz. Kabul edilen küme iki sınıftır: ayrı satır
  blokları **ve** ürün satırı parçaları. (Parçalar başta dışarıda kalmıştı ve
  "SKU'yu gizle" ayarı sunucuya hiç ulaşmıyordu; düzenleyicide kapanıyor,
  kaydediliyor, sonra sessizce varsayılana dönüyordu.)
- Render katmanı (`resolveTenantBlocks`) bu anahtarlar için tek bir ZPL
  komutu üretmez.

## Sığmama davranışı

Taşıyıcı içeriğinin altında kalan bant dardır. Ölçüm (gerçek üretim etiketi
`surat-real-success-11415535074.zpl`):

```
footer bandı   725 → 791   = 66 dot
ürün satırı                = 25 dot
kiracıya kalan             = 41 dot
```

Sığmayan blok **küçültülmez ve kırpılmaz**; basılmaz ve
`tenantBlocksDropped` ile hangi blok olduğu raporlanır. Düzenleyici, üretime
alınmadan önce nominal kapasiteye göre uyarı gösterir; kesin karar baskı
anında `planTenantBlocks` ile verilir (bant etiketten etikete değişir).

## Kalıcılık

Şablon `organization_settings.settings_json.labelTemplate` altında org
kapsamında saklanır — **şema göçü gerekmez**. Her yazım `version` alanını
artırır. `settings_json` MERGE edilir; `shipmentDefaults`,
`externalProcessing` ve onboarding anahtarları korunur.

Uçlar auth kapısının arkasındadır ve **taşıyıcıya/pazaryerine çıkmaz**:

- `GET /api/labels/template`
- `PUT /api/labels/template`

Kaydetme sunucuya yazamazsa operatör uyarılır; sessizce yerelde bırakılmaz.

### Varyant için ikinci bir çözücü yok

Sunucu tarafındaki blok yükleyicisi renk/beden/SKU'yu ürün satırının
**kanonik** zincirinden alır (`loadPrintLineItems` →
`resolveSuratProductLineItems`). Yükleyici bir süre `variantAttributes`'ı elle
okuyordu ve nitelikler `{name, value}` ile saklanırken
`{attributeName, attributeValue}` arıyordu — "Varyant" bloğu sunucuda **her
zaman boş** kalıyordu. İkinci bir çözücü, birincisiyle sessizce ayrışır.

### Cihazlar arası senkron

Sunucudaki şablon otoriterdir ve açılışta yüklenir. Birleştirme **birleşim**
alır, kesişim değil: yerel katalogda bulunmayan sunucu blokları da eklenir.
Aksi hâlde `defaultLabelTemplate.fields` eski 11 bloğu taşıdığı için A
cihazında ayarlanan "Satın Alan Adı / alt / 44 punto", localStorage'ı boş olan
B cihazında sessizce düşerdi.

## Önizleme

`LabelHtmlPreview`, baskı ZPL'iyle **aynı saf fonksiyonları** kullanır
(`resolveTenantBlocks`, `resolveTenantBlockValues`, `resolveProductLineParts`,
`buildProductMetaText`). Kopya bir biçimlendirici ikisini sessizce
ayrıştırırdı.

Önizlemede **taşıyıcı çağrısı = 0**, **pazaryeri çağrısı = 0**, gönderi
mutasyonu yoktur; bileşen `fetch`/`XMLHttpRequest` kullanmaz (TB-9).

## "Yazı Boyutları" bölümü

Bu bölüm **yalnız ekran önizlemesini** biçimlendirir; Sürat etiketinin basılan
metinlerini taşıyıcı ürettiği için baskıya etkisi yoktur. Başlık ve açıklama
bunu açıkça söyler.

## Kanıt

- `server/tenant-label-editor-render-flow.test.mjs` (TB-1…TB-14): çıktı
  üzerinden blok yazımı, punto/kalınlık, alt yerleşim, taşma raporu, kimlik
  kilidi, taşıyıcı komutlarının korunması, kalıcılık ve sürüm, ayarların
  birleşmesi, ürün satırı parçaları, şablonsuz kiracıda değişmezlik,
  sunucu yükleyicisinin gerçek siparişe uçtan uca uygulanması (TB-14).
- `src/test/labelTemplateEditor.dom.test.tsx`: dört müşteri hikâyesi gerçek
  düzenleyici arayüzü üzerinden, önizleme çıktısıyla birlikte.
