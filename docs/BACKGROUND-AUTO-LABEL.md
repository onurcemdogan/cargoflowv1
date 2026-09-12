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

## ═══ AKTİVASYON SINIRI — GEÇMİŞ YIĞIN KORUMASI ═══

### Kanıtlanmış boşluk

Bir tur boyunca üretim kodunda `enqueueLabelJob` çağıran **tek bir yer
yoktu**. Kuyruk, worker ve politika hazırdı ama **üretici** yoktu: yani
`LABEL_WORKER_ENABLED=true` yapılsaydı worker boş kuyruğu dönüp duracak,
hiçbir etiket üretilmeyecekti. "Otomatik etiket" üretici olmadan
tamamlanmış sayılmaz.

### En kritik risk

Üretici eklenirken bayrak açıldığı anda **geçmiş yığının tamamının** sıraya
girmesi. Bu, tek bir ayar değişikliğiyle binlerce **geri alınamaz** ve
**faturalanabilir** Sürat etiketi demektir.

### Çözüm

`autoLabel.activatedAt` (ISO) org ayarlarında saklanır ve aday sorgusu
**SQL'de** `first_seen_at >= activatedAt` ile sınırlanır: sınırdan önceki
paketler Node'a **bile gelmez**.

**Fail-safe:** sınır yoksa, boşsa veya geçersizse hiçbir paket sıraya
girmez. "Sınır tanımsız" asla "sınırsız" demek değildir. Paketin ilk
görülme zamanı bilinmiyorsa da sıraya girmez.

Açmadan önce kaç paketin etkileneceği sorulabilir:
`countAutoLabelCandidates(db, orgId, boundaryMs)`.

Tek turda en fazla `AUTO_LABEL_PRODUCER_BATCH` (200) aday işlenir —
sınırsız yığın işleme yoktur.

### Kanıt

`server/auto-label-activation-boundary-flow.test.mjs`: 120 geçmiş + 3 yeni
paketli kiracıda aktivasyon sonrası **yalnız 3** paket incelenir ve sıraya
alınır (BOUNDARY-2); üretici iki kez çalışsa da mükerrer iş doğmaz
(BOUNDARY-3); aktivasyon diğer org ayarlarını silmez (BOUNDARY-4);
üretici hem durum hem akış senkronuna bağlıdır (BOUNDARY-7).

Politika tarafı: `surat-auto-label-policy-flow` AUTO-BOUNDARY-1…4.

---

## `Created` paketler ve arka planda Picking geçişi

### Ölçülen durum

Worker ve akış senkronu açık, PM2 günlüğünde *"arka plan etiket worker
etkin"* yazıyor — ama `QUEUED_TOTAL = 0`. Altı yeni `Created` sipariş
hiçbir zaman sıraya girmedi.

### Kök neden: üç katman, üç farklı gerçek

| katman | fonksiyon | `Created` kararı |
| --- | --- | --- |
| üretici | `classifyMarketplaceLifecycle` | `NOT_YET` → sıraya **almaz** |
| worker hazırlığı | `canCallSurat` | `false` → `NOT_ELIGIBLE` |
| create orkestrasyonu | `ensureTrendyolPickingBeforeSurat` | Picking'e **alır** |

Elle buton aynı paket için `Created → Picking` geçişini **zaten**
yapıyordu; arka plan yol o yeteneğe ulaşmadan iki kapı önce
reddediliyordu.

### Çözüm

`Created` kapısı **silinmedi**. Yaşam döngüsü sınıfı hâlâ `NOT_YET`'tir.
Değişen tek şey: `resolveBackgroundPreparationGate` artık çağırana
*"geçişi yapmaya yetkili misin?"* diye sorar. Yetki yoksa sonuç bugünküyle
**aynıdır**.

Geçişi yapan yer değişmedi: elle butonun kullandığı kanonik create
orkestrasyonu. **İkinci bir Picking uygulaması yoktur** — worker create
handler'ın kendisini sentetik istekle çalıştırır.

### İkinci aktivasyon sınırı — neden

Bu bir **pazaryeri mutasyonudur**. Otomatik etiketin açık olması bunun
onayı sayılmaz: aksi hâlde kod dağıtıldığı an, `activatedAt` sonrası
görülmüş ve `Created` diye **bekleyen** paketler topluca Picking'e
alınırdı.

Bu yüzden `autoLabel.backgroundPicking` kendi `activatedAt` damgasını
taşır ve geçerli sınır **iki damganın geç olanıdır**. Varsayılan
**kapalı**; ayar yoksa davranış bugünküyle birebir aynıdır.

### Operatör komutları

```
npm run auto-label:activation:inspect -- --name "<org>"
npm run auto-label:activation:enable  -- --name "<org>"
npm run auto-label:activation:enable-background-picking -- --name "<org>"
```

`inspect` salt-okunurdur. Açma komutları yalnız kiracı ayarını yazar:
Trendyol'a çağrı yok, Sürat'e çağrı yok, iş satırı yok. Damga daima
`now`dur; komut geçmişe çekilebilir bir tarih bayrağı kabul etmez.

### Yakalama (catch-up) ile ilişkisi

Yakalama aktivasyon sınırını atlar; **sınırı atlayan bir yol pazaryeri
statüsünü değiştiremez.** Bu yüzden yakalama `Created` paketleri
`PICKING_TRANSITION_REQUIRED` ile reddeder. Modülün "yalnız aktivasyon
sınırı atlanır" sözü böylece gerçekten doğrudur — daha önce değildi.

### Kanıt

`server/auto-label-background-picking-flow.test.mjs`: AUTO-BG-1…10.
Onay yokken `Created` bloke (AUTO-BG-2b/a); onay varken bile sınırdan önce
görülmüş paketler dokunulmaz (AUTO-BG-2b/b); terminal paketler yetki
verilse bile geçmez (AUTO-BG-4); READY etiket varken buton taşıyıcıya
çıkmaz (AUTO-BG-6) ve kalıcı ZPL'i bayt bayt döndürür (AUTO-BG-7).
