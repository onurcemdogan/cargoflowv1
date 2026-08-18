# P2 — B3 artımlı senkronizasyon denetimi

Dal: `perf/orders-b3-incremental-sync` · taban: `0e94a08`

> P1 dersi: "zaten var" iddiası ÖLÇÜLMEDEN yazılmaz. Aşağıdakiler dosya/satır
> okunarak doğrulandı; davranış testleri ayrıca yazıldı (aşağıda).
>
> **Dersin ters yönü de geçerli:** "YOK" iddiası da ölçülmeden yazılmaz.
> Bu denetimin ilk turunda 2–4 numaralı maddeler "görülmedi/ölçülmedi" diye
> açık bırakılmıştı; kod okununca ÜÇÜ DE mevcut çıktı (bkz. son bölüm).

## Zaten VAR (doğrulandı)

| Konu | Kanıt |
| --- | --- |
| Kiracı başına sync durumu | `integration_sync_state` ([schema.ts:566](../../server/db/schema.ts)) |
| Hesap kapsamı | `marketplaceAccountId` — farklı hesaplar lock PAYLAŞMAZ |
| Benzersizlik | `(org, provider, resource, account)` unique, `nullsNotDistinct` |
| Checkpoint alanı | `lastSuccessfulSyncAt` |
| Sonuç metadatası | `lastSyncStatus`, `lastFetchedCount`, `lastErrorCode` |
| Tek-uçuş (single-flight) kilidi | aynı tabloda, kapsam yorumunda belirtilmiş |
| Kısmi sync koruması | `persistSyncResult(..., { complete })` — `complete=false` HİÇBİR kaydı arşivlemez |
| Pencere kapsamlı mutabakat | `staleOpenReconciler` yalnız sync penceresindeki kayıtları reconcile eder |

## Davranış testleri (ilk turda "yok" sanılmıştı)

| Konu | Kapsayan test |
| --- | --- |
| Manuel + arka plan çakışması | `SYNC-SINGLEFLIGHT-3`, `-4` |
| Farklı hesaplar birbirini bloklamaz | `SYNC-SINGLEFLIGHT-5` |
| Aynı hesapta ikinci uçuş başlamaz | `SYNC-SINGLEFLIGHT-1`, `-2` |
| Hata sonrası kilit serbest kalır | `SYNC-SINGLEFLIGHT-6` |
| Bekleme sınırlı (sonsuz blok yok) | `SYNC-SINGLEFLIGHT-4b` |
| Retry + PARTIAL veri güvencesi | `SYNC-SINGLEFLIGHT-7` |
| `complete=false` arşivlemez | `RCN-5` |

Dosyalar: [sync-single-flight-flow.test.mjs](../../server/sync-single-flight-flow.test.mjs),
[active-sync-reconciliation-flow.test.mjs](../../server/active-sync-reconciliation-flow.test.mjs)

---

# 1. ARTIMLI İMLEÇ — ÖLÇÜLDÜ, KARAR VERİLDİ, BAĞLANDI

## Ölçüm (denetim anı)

`lastSuccessfulSyncAt` yalnız YAZILIYOR ve durum yanıtlarında gösteriliyordu.
Çekim penceresini DARALTMAK için hiçbir yerde OKUNMUYORDU. Pencere istemci
parametrelerinden geliyor, yoksa **son 7 gün** varsayılıyordu. Yani davranış
artımlı değil, **kayan sabit pencere**ydi.

Bu bir hata DEĞİLDİ: kayan pencere kendini onarır. Bir sync "başarılı" deyip
kayıt düşürdüyse sonraki çekim onu yine yakalar. Saf imleç ise o kaydı KALICI
olarak atlar — eksik gönderi, eksik ciro. Bu yüzden imlece geçiş tek başına bir
iyileştirme sayılmadı.

## Karar: **B seçeneği** — imleç + emniyet payı + periyodik geniş tarama

Üç mekanizma BİRLİKTE çalışır; biri olmadan diğerleri güvenli değildir:

1. imleç GERİYE emniyet payı kadar kaydırılır (örtüşme KASITLIDIR),
2. imleç YALNIZ tam başarılı sync sonunda ilerler,
3. geniş pencere periyodik olarak yeniden taranır (kendini onarma).

Politika: [syncWindowPolicy.ts](../../server/orders/syncWindowPolicy.ts)
· testler: [orders-b3-sync-window-flow.test.mjs](../../server/orders-b3-sync-window-flow.test.mjs)
(19/19).

## Bağlama — YAPILDI

### 1.1 Çekim penceresi imleçten türetilir

Bağlama noktası `callTrendyolOrders`ın İÇİ DEĞİL, **ÇAĞIRAN taraf**tır. Sebep:
oradaki `query.startDate ?? son 7 gün` ifadesi sayesinde açık istemci tarihi
KENDİLİĞİNDEN kazanır; 30 günlük üst sınır ve `endDate < startDate` doğrulaması
olduğu yerde kalır. Ek dallanma gerekmedi.

`POST /api/orders/sync` artık sync başında `integration_sync_state` satırından
imleci okur, `resolveSyncWindow(...)` çağırır ve **istemci tarih vermediyse**
`query.startDate`/`query.endDate` alanlarını doldurur.

Ölçülen tuzak: `Number(null) === 0`. İmleci olmayan kiracı 0'a düşseydi pencere
1970'ten başlar ve 30 günlük üst sınır çekimi TAMAMEN reddederdi. `epochMsOrNull`
"yok" ile "epoch" ayrımını korur (`B3W-5`).

### 1.2 İmleç watermark olarak yazılır

`lastSuccessfulSyncAt` artık **pencerenin üst sınırı**dır, `now()` değil.
Çekim sürerken oluşan siparişler `now` ile pencere sınırı arasına düşer; imleç
`now` yapılsaydı o aralık bir daha SORULMAZDI.

`recordSyncState` ve `updateAccountSyncMeta` opsiyonel `successfulSyncAt` alır;
verilmezse eski davranış (`now`) korunur — geriye dönük uyumlu.

İlerletme kararı `advanceCheckpoint(...)`tan gelir: kısmi sonuç, kurtarılamayan
hata veya rate-limit tükenmesinde imleç KORUNUR (`B3W-8`).

### 1.3 Periyodik tarama — MIGRATION'SIZ

`RECONCILIATION` modu "son geniş tarama ne zamandı" bilgisini ister;
`integration_sync_state` içinde böyle bir kolon YOK ve eklemek üretim
migration'ı demek. Bunun yerine mevcut veriden türetildi:
**imlecin düştüğü zaman kovası**.

`deriveReconciliationAnchorMs` = `floor(checkpoint / interval) * interval`.
Böylece `now - anchor >= interval` koşulu TAM OLARAK "şimdi, imlecin
kovasından SONRAKİ bir kovada" anlamına gelir:

- her kovada EN ÇOK bir geniş tarama (tarama fırtınası yok — `SW-16`, `SW-18`),
- sync'ler sürdükçe her kovada EN AZ bir geniş tarama (`SW-17`),
- kolon yok, migration yok, ek yazma yok.

### 1.4 Reconcile kapsamı = çekim penceresi

Reconcile penceresi eskiden KENDİ 7 günlük varsayılanını hesaplıyordu. İki
tarafın ayrışması arşivleme kapsamını bozardı. Artık ikisi de aynı çözülmüş
`query.startDate`/`endDate` değerlerinden türer (`B3W-3`).

### 1.5 Arka plan turu BİLEREK dokunulmadı

`syncTrendyolOrdersForOrganization` sabit penceresinde kaldı. Sebep ölçüme
dayanır: o tur `complete:false` ile çalışır, imleci ASLA ilerletmez ve işi
pazaryeri statüsünü tazelemektir. Trendyol penceresinin hangi tarih eksenini
(sipariş tarihi mi, paket son güncelleme mi) filtrelediği bu repoda kanıtlanmış
DEĞİLDİR; imleçle daraltmak eski açık kayıtların statü tazelemesini sessizce
kesebilirdi. Kanıt gelene kadar daraltma YAPILMAZ.

---

# 2–4. SINIRLI ÇEKİM · BACKOFF · 429 — DENETİM DÜZELTMESİ

İlk turda üçü de "ölçülmedi/görülmedi" diye açık bırakılmıştı. **Kod okundu:
üçü de VAR.** Davranış testleriyle kilitlendi:
[orders-b3-bounded-pull-flow.test.mjs](../../server/orders-b3-bounded-pull-flow.test.mjs)
(11/11).

| İlk iddia | Ölçüm | Test |
| --- | --- | --- |
| "bounded pull ölçülmedi" | `maxPages = min(totalPages, query.maxPages ?? 100)`; `size` 200'e kelepçeli; aralık 30 günle sınırlı | `B3P-8`, `B3P-9`, `B3P-10` |
| "sınıflandırılmış backoff görülmedi" | 429/5xx/ağ = geçici → üstel `[2000,4000,8000]` + jitter; kalıcı 4xx TEKRAR DENENMEZ; sayı üst sınırlı | `B3P-1`, `B3P-2`, `B3P-3`, `B3P-4` |
| "429/Retry-After yolu görülmedi" | `parseRetryAfterMs` saniye ve HTTP-date çözer, 60 sn'ye kelepçeler; 429'da taban gecikme yerine Retry-After kullanılır | `B3P-5`, `B3P-6`, `B3P-7` |

Ek olarak düşen sayfa BAŞTAN değil kaldığı yerden devam eder
(`partialContent` + `failedPage`) — `B3P-11`.

# 8. Replay / idempotency

Örtüşme kasıtlı olduğu için aynı kayıt ardışık iki pencerede de gelir. Upsert
tekilliği sayesinde DUPLICATE üretmez; artık varsayım değil, ölçüm: `B3W-11`
aynı siparişi iki kez yazar ve tek satır + tek order line bekler.

---

## Kurallar

- Testlerde dış ağ MOCK'lanır; gerçek pazaryeri çağrısı YOK.
- Sözleşme gerektirmedikçe pazaryeri MUTASYONU yok.
- Kiracı izolasyonu bozulmaz (`B3W-10`: hesaplar birbirinin imlecini görmez).

## Gate

`P2_B3_INCREMENTAL_SYNC` artık `notImplemented` DEĞİL. Bağlı gate'ler:

| Gate | Test |
| --- | --- |
| `P2_WINDOW_POLICY` | `orders-b3-sync-window-flow.test.mjs` |
| `P2_CURSOR_WIRED` | `orders-b3-sync-wiring-flow.test.mjs` |
| `P2_BOUNDED_PULL` | `orders-b3-bounded-pull-flow.test.mjs` |
| `P2_SINGLE_FLIGHT` | `sync-single-flight-flow.test.mjs` |
| `P2_PARTIAL_SAFETY` | `active-sync-reconciliation-flow.test.mjs` |

Ardından ortak kalite kapıları (`P2_SURAT`, `P2_UI`, `P2_BUILD`, `P2_LINT`).
