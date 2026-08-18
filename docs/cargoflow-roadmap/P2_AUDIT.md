# P2 — B3 artımlı senkronizasyon denetimi

Dal: `perf/orders-b3-incremental-sync` · taban: `0e94a08`

> P1 dersi: "zaten var" iddiası ÖLÇÜLMEDEN yazılmaz. Aşağıdakiler dosya/satır
> okunarak doğrulandı; davranış testi henüz yazılmadı.

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

## DENETİM DÜZELTMESİ — davranış testleri ZATEN VAR

İlk listede "doğrulanmamış" dediğim maddelerin bir kısmı aslında test edilmiş.
Testler çalıştırıldı: **19/19 PASS**.

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

## GERÇEKTEN AÇIK KALAN (P2 kapsamı)

1. **Artımlı imleç daraltması**: `lastSuccessfulSyncAt` YAZILIYOR; sonraki
   çekimin bu değerden İTİBAREN daraltılıp daraltılmadığı ÖLÇÜLMEDİ. P2'nin
   asıl konusu budur.
2. **Sınırlı çekim (bounded pull)**: sayfa/limit üst sınırı ölçülmedi.
3. **Backoff politikası**: retry'in KENDİSİ var (SINGLEFLIGHT-7); üstel/
   sınıflandırılmış backoff görülmedi.
4. **Rate-limit (429/Retry-After)** işleme yolu görülmedi.

## Kurallar

- Testlerde dış ağ MOCK'lanır; gerçek pazaryeri çağrısı YOK.
- Sözleşme gerektirmedikçe pazaryeri MUTASYONU yok.
- Kiracı izolasyonu bozulmaz.

## Sonraki somut adım

Hermetik test: iki kiracı + iki hesap için `integration_sync_state` kilidinin
ve `complete=false` korumasının davranışını kanıtla; ardından artımlı imlecin
sonraki çekimi gerçekten daralttığını ölç.
