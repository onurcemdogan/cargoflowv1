# CargoFlow yol haritası — runbook

Bu dosya sohbet hafızasının yerini alır. Yeni oturum yalnız şunu çalıştırır:

```bash
node scripts/cargoflow-roadmap/orchestrator.mjs status
```

Sonra sırayla:

```bash
node scripts/cargoflow-roadmap/orchestrator.mjs continue
```

`continue` **yalnız gate çalıştırır**. Kodu Claude düzeltir; düşen gate'in kök
nedenini kanıtlar, minimum düzeltmeyi yapar, hedefli testi koşar, sonra tekrar
`continue`. Faz atlama, force ve reset komutu **yoktur**.

Rapor: `node scripts/cargoflow-roadmap/orchestrator.mjs report`
Çıktılar: `.var/cargoflow-roadmap/latest-report.{json,md}` (git dışı).

## Fazlar

| Faz | Dal | Kapsam |
| --- | --- | --- |
| S1_SURAT_HARDENING | `fix/surat-canonical-kargobarkod-and-debug-ui` | Kimlik parite kapısı, Canlı Debug, başarısız create durumu |
| P1_B2_PERFORMANCE | `perf/orders-b2-production-rollout` | Sayfalama, sayımlar, N+1, 0008 araçları |
| P2_B3_INCREMENTAL_SYNC | `perf/orders-b3-incremental-sync` | Kiracı checkpoint, artımlı imleç, resume |
| P3_B4_BARCODE_WORKER | `feat/surat-barcode-worker-finalization` | Kuyruk öncesi finansal ön kontrol, idempotency |
| P4_HEPSIBURADA_N11 | `feat/marketplaces-hepsiburada-n11-foundation` | Sağlayıcı-nötr temel |
| P5_ARAS | `feat/carrier-aras-foundation` | Taşıyıcı-nötr temel |
| P6_SURAT_NON_MARKETPLACE | `feat/surat-non-marketplace-contract` | Pazaryeri dışı sözleşme |

## Değişmez kurallar

- `master`'a **push yok**; her faz kendi dalında.
- Gerçek taşıyıcı create **yok**. Tüm fazlar bitse bile `liveCreateAllowed=false`.
- Üretim migration/restart **yok**.
- Operasyonel veri **silinmez**: orders, shipments, shipment_operations,
  idempotency, tracking, printZpl, technicalZpl, Trace V2.
- Dış sözleşme eksikliği yalnız P4/P5/P6'da ilerlemeye izin verir; uygulanabilir
  bir fazı "sözleşme yok" diyerek atlamak yasaktır (RM-4 bunu kilitler).
- Uygulanmamış iş `NOT_IMPLEMENTED` ile **BLOCKED** kalır — sahte PASS yok.

## Guncel konum

**S1 = passed** (c904f29). **P1 = passed** (0e94a08).
**P2 = in_progress**, dal `perf/orders-b3-incremental-sync`.

P2 denetimi TAMAMLANDI ve BAGLANDI: [P2_AUDIT.md](P2_AUDIT.md).

Ozet — artimli imlec ARTIK GERCEKTEN calisiyor:

- cekim penceresi `integration_sync_state` imlecinden turetiliyor (eskiden
  imlec yalniz yaziliyor, hic OKUNMUYORDU),
- imlec pencerenin UST SINIRINA yaziliyor (`now()` degil) ve YALNIZ tam
  basarili sync'te ilerliyor,
- periyodik genis tarama imlecin ZAMAN KOVASINDAN turetiliyor → yeni kolon ve
  uretim migration'i GEREKMEDI,
- reconcile kapsami ile cekim penceresi AYNI kaynaktan geliyor.

Denetimin "yok" sandigi sinirli cekim / siniflandirilmis backoff /
429-Retry-After maddeleri OLCULDU: ucu de ZATEN VARDI, testle kilitlendi.

Arka plan turu BILEREK sabit penceresinde birakildi (gerekce: P2_AUDIT §1.5).

`P2_B3_INCREMENTAL_SYNC` gate'i artik `notImplemented` DEGIL; bes gercek test
paketi + ortak kalite kapilarindan olusuyor.

Sonraki somut adim: `continue` yesillenince P3 (`feat/surat-barcode-worker-
finalization`) — kuyruk oncesi finansal on kontrol ve idempotency.

## S1 gecmisi

`S1_LIVE_DEBUG_UI` **GECTI** (cbff077): Canli Debug varsayilan bolum, legacy
satir sayisi acilista 0, genis silme dugmesi birincil ekrandan kalkti.

Kalan TEK gate: **`S1_FAILED_ORDER_STATE`**.

`CREATE_FAILED` + `carrierAcceptanceConfirmed=false` + tracking/barcode/zpl yok
olan bir deneme, siparis listesinde basarili kayit ya da "barkod bekliyor" gibi
gorunmemeli. Ilgili yerler:

- [orderClassification.ts](../../src/utils/orderClassification.ts) — `operationStatus`
  ve `verifySuratShipment` kanitindan sekme/durum turetir.
- Faz B siniflandirmasi hazir: `finalClassification` = `CREATE_FAILED`
  ([suratResponseClassification.ts](../../server/shipments/suratResponseClassification.ts)).

Gate'i gercek bir testle baglamak icin `scripts/cargoflow-roadmap/gates.mjs`
icindeki `S1_FAILED_ORDER_STATE` girdisini `notImplemented` yerine komutlu
gate'e cevir (ornek: `S1_LIVE_DEBUG_UI`).

## Eski notlar

`S1_LIVE_DEBUG_UI` ve `S1_FAILED_ORDER_STATE` bilerek BLOCKED. Yapılacaklar:

1. Canlı Debug'ı Trace V2'ye bağla (5 sekme: Özet · Karar/Mapping · Request ·
   Response · Geçmiş). Varsayılan ekranda legacy satır sayısı **0** olmalı.
2. Çapraz deneme karışımını gider: seçilen tek `traceId` bütün sekmeleri sürsün.
   Bilinen doğru değerler — `ReferansNo=4085791254`,
   `OzelKargoTakipNo=7270036019076954`.
3. `CREATE_FAILED` siparişi başarılı kayıt gibi göstermeyen bir durum kullan.

Hazır bileşenler: [SuratLiveDebugPanel](../../src/components/SuratLiveDebugPanel.tsx)
ve [görünüm modeli](../../src/debug/suratLiveDebugViewModel.ts) — Trace V2'den
okur ve legacy v1 kayıtlarını aday listesine hiç almaz.

## Yeni oturum için hazır istem

> Read docs/cargoflow-roadmap/CONTRACT.md and RUNBOOK.md.
> Run the roadmap status command.
> Work only on CURRENT_PHASE and its FAILED_GATE.
> Do not skip phases. Do not push master.
> After the minimum evidenced fix, run continue. Repeat until the phase passes.
> Never perform a real carrier create.
