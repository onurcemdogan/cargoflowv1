# Arka Plan Etiket Worker'ı ve Trendyol Akış Senkronu

## Tek cümlelik güvence

Arka plan worker'ı **kendi create'ini kurmaz**. Elle basılan butonun
çağırdığı **aynı handler'ı** çalıştırır.

## Nasıl bağlandı

`runLabelJobViaCreateHandler(job)` (server/index.mjs):

1. `findOrderByPackageId` ile sipariş satırını bulur.
2. `getOrder` ile **butonun gönderdiğiyle aynı** view-model'i üretir.
3. Kimliği `loadRequestOrgConfig` ile org kaydından çözer — istek
   gövdesinden **değil** (tenantInject ara katmanının yaptığının aynısı).
4. Sentetik bir istek/yanıt çiftiyle
   `withSuratTracePersistence(createSuratShipment)` çağırır.

Ağ yoktur, ikinci bir uygulama yoktur. Aynı rota çözümü, aynı kimlik anlık
görüntüsü, aynı faturalama kapısı, aynı Trace V2 kalıcılığı, aynı
persistence. İkinci bir create yazılsaydı zamanla butondan ayrışır ve
güvenceler yalnız birinde kalırdı.

`server/trendyol-high-volume-auto-label-e2e-flow.test.mjs` (HV-6) bunu
yapısal olarak korur: worker gövdesinde `createSuratSoapPrimaryShipment`,
`OrtakBarkodOlustur` veya `services.asmx` **bulunamaz**. HV-8 sentetik
istek/yanıt sözleşmesini sabitler: create yolu ileride `response.setHeader`
gibi yeni bir API kullanmaya başlarsa derleme düşer — canlı bir paket
harcayarak öğrenmek yerine.

### Hazırlık kanonik alandan okunur

Etiketin hazır olup olmadığının tek otoritesi `labelState`'tir
(`READY | GENERATING | FAILED`); `ok` zaten ondan türetilir. Worker bir süre
`zpl`/`barcodeRaw` gibi türev alanlara bakıyordu — yanıt şekli değiştiğinde
sessizce "hazır değil" demeye başlardı. HV-9 bunu korur.

## Mükerrer gönderi neden imkânsız

- **Kuyruk tekilliği veritabanındadır**: `label_jobs` üzerinde
  `(org, marketplace, carrier, packageId, jobType)` UNIQUE. Webhook, akış ve
  elle yenileme aynı paketi bulsa bile **mantıksal iş tektir** (HV-2).
- **Talep `FOR UPDATE SKIP LOCKED`** ile yapılır: iki worker aynı işi
  alamaz.
- **Ağ sınırından sonra belirsizlik** → iş `UNKNOWN_AFTER_NETWORK` olur ve
  **bir daha talep edilmez**. Worker yeniden başlasa bile ikinci gönderi
  yaratılmaz (HV-4). Taşıyıcı etiketi geri alınamaz ve faturalanabilir;
  "tekrar dene" burada yanlış varsayılandır.

## Bayraklar — ikisi de VARSAYILAN KAPALI

| Değişken | Ne açar | Varsayılan |
| --- | --- | --- |
| `LABEL_WORKER_ENABLED` | Arka plan etiket worker'ı | **kapalı** |
| `TRENDYOL_STREAM_SYNC_ENABLED` | Trendyol akış senkronu | **kapalı** |

Bayrak açıkça `true`/`1` yapılmadıkça **hiçbir zamanlayıcı kurulmaz**:
boot'ta taşıyıcı çağrısı yok, periyodik create yok, pazaryeri çağrısı yok
(HV-1).

**Dağıtım sırasında otomatik etiket AÇILMAZ.** Önce kod dağıtılır ve
davranış gözlenir; worker ayrı ve bilinçli bir adımda açılır.

Kapanışta (`SIGTERM`/`SIGINT`) her iki zamanlayıcı da durdurulur; yeni tur
başlatılmaz.

## Eşzamanlılık

`AUTO_LABEL_CONCURRENCY` = `{ perCarrier: 2, perTenant: 2, global: 4 }`.
`Promise.all(binlerce)` asla kullanılmaz; her tur sınırlı eşzamanlılıkla
çalışır ve gözlenen en yüksek eşzamanlılık raporlanır (HV-3).

## Trendyol akış senkronu

`syncTrendyolStreamForOrganization` toplanan paketleri **elle "Şimdi
Yenile" akışının kullandığı aynı** `normalizeTrendyolOrders` +
`persistSyncResult` yolundan geçirir. İkinci bir persistence yazılmadı;
aksi hâlde hesap kapsamı, tekillik ve arşiv kuralları zamanla ayrışırdı.

- **Hesap kapsamı zorunlu**: çözülemezse organizasyon atlanır; NULL
  kapsamına gölge satır yazılmaz.
- **Arşivleme yok**: akış turu "tam liste" olduğunu kanıtlayamaz, bu yüzden
  `complete: false` geçilir.
- **Manuel senkron sürüyorsa tur atlanır** (istek sayısı ikiye katlanmaz).

### İmleç neden veritabanında ve pencere neden sabit

İmleç `organization_settings.settings_json.trendyolStreamCheckpoint`
altındadır (şema göçü gerekmez, diğer anahtarlar MERGE ile korunur —
HV-7). Süreç yeniden başlasa bile zincir kaldığı yerden sürer.

Pencere **sabit kalmalıdır**: imleç, verildiği sorguya göre çözülür. Pencere
her turda `Date.now()` ile yeniden hesaplansaydı filtre parmak izi her
seferinde değişir, `resolveStreamResume` imleci **her tur atar** ve zincir
hiç sürdürülemezdi. Bu yüzden yarım kalmış bir zincirde pencere
kaydedildiği gibi yeniden kullanılır; zincir tükendiğinde
(`NO_MORE_PAGES`) yeni ve güncel bir pencere planlanır.

Çekim yarıda kalsa bile (`FETCH_FAILED`) imleç yazılır: **kısmi ilerleme
korunur**.
