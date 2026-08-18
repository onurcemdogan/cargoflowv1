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

## EKSİK / DOĞRULANMAMIŞ (P2 kapsamı)

1. **Artımlı imleç kullanımı**: `lastSuccessfulSyncAt` YAZILIYOR; sonraki
   çekimin bu değerden İTİBAREN daraltılıp daraltılmadığı doğrulanmadı.
2. **Sınırlı çekim (bounded pull)**: sayfa/limit üst sınırı ölçülmedi.
3. **Yeniden deneme + backoff**: sınıflandırılmış retry politikası görülmedi.
4. **Rate-limit işleme**: 429/Retry-After yolu görülmedi.
5. **Resume/replay idempotency**: yarıda kesilen sync'in tekrarında mükerrer
   kayıt üretmediği test edilmedi (`upsertMarketplaceOrders` upsert olduğu için
   büyük olasılıkla güvenli — ÖLÇÜLMELİ).
6. **Manuel/arka plan çakışması**: kilidin gerçekten çakışmayı engellediği
   davranış testiyle kanıtlanmadı.

## Kurallar

- Testlerde dış ağ MOCK'lanır; gerçek pazaryeri çağrısı YOK.
- Sözleşme gerektirmedikçe pazaryeri MUTASYONU yok.
- Kiracı izolasyonu bozulmaz.

## Sonraki somut adım

Hermetik test: iki kiracı + iki hesap için `integration_sync_state` kilidinin
ve `complete=false` korumasının davranışını kanıtla; ardından artımlı imlecin
sonraki çekimi gerçekten daralttığını ölç.
