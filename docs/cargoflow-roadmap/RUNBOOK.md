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

**S1 · P1 · P2 · P3 = passed.** **P4 · P5 = dis sozlesme DOGRULANDI ve yeniden
acildi (2026-08-19).** **P6 = blocked_external_contract (INSUFFICIENT).**

`liveCreateAllowed=false` · `marketplaceWritesEnabled=false` (her durumda).

### Dis sozlesme durumu

| Faz | external_contract_status | Not |
| --- | --- | --- |
| P4_HEPSIBURADA_N11 | `VERIFIED_PUBLIC_OFFICIAL` | HB uc nokta YOLLARI kanitlanmadi → yapilandirmadan gelir |
| P5_ARAS | `VERIFIED_PUBLIC_OFFICIAL_TEST_CONTRACT` | `production_endpoint_status=UNVERIFIED`; COD deger tablosu YOK |
| P6_SURAT_NON_MARKETPLACE | `INSUFFICIENT` | `Pazaryerimi=0` is semantigi kanitlanmadi |

Kanit ayrintisi (kaynak ailesi, tarih, dogrulanan olgular ve KANITLANMAYANLAR):
`STATE.json → phases.*.externalContract`. **Sir YAZILMAZ.**

### Hazirlik maddeleri — kod fazini BLOKLAMAZ

| Madde | Durum |
| --- | --- |
| `HB_N11_LIVE_CREDENTIAL_VERIFICATION` | BLOCKED_EXTERNAL_ENVIRONMENT |
| `ARAS_PRODUCTION_ENDPOINT` | BLOCKED_EXTERNAL_ENVIRONMENT |
| `ARAS_PRODUCTION_CREDENTIAL` | BLOCKED_EXTERNAL_ENVIRONMENT |
| `ARAS_COD_VALUE_TABLE` | BLOCKED_EXTERNAL_CONTRACT (COD fail-closed) |

### Yeni kod haritasi

```
server/marketplaces/
  marketplaceOrderSource.ts        ← UC gercek modelden turetilen seam
  hepsiburada/{Contract,OrderSource,LabelCapability}.ts
  n11/{Contract,OrderSource}.ts
server/carriers/aras/
  {arasContract,arasSetOrder,arasLabelArtifact,arasVerification}.ts
```

`server/index.mjs` DEGISMEDI → **Trendyol davranisi aynen korundu.**

### Degismezler — kolay bozulan yerler

- **HB `-sit` kurali** yalniz DOGRULANMIS hepsiburada hostlarinda uygulanir.
  Aras'ta boyle bir kural YOKTUR; uretim adresi disaridan gelir.
- **HTTP 200 basari DEGILDIR**: HB ortak barkodunda 101/102/400/500 is kodlari
  ve artefakt varligi ayrica denetlenir.
- **n11'de `cargoSenderNumber`=TAKIP, `cargoTrackingNumber`=BARKOD.** Isimler
  sezgiye ters; yer degistirirlerse yanlis numara sorgulanir ve yanlis barkod
  basilir.
- **Sayfalama karistirilmaz**: HB `offset/limit`, n11 `page`(0)/`size`(<=100).
- **Pencere**: Trendyol <=30 gun · HB paket 24 saat · n11 15 gun.
- **COD**: alanin VARLIGI degerini KANITLAMAZ. Dogrulanmamis kod ile COD
  gonderi ACILMAZ.

### Yeni komut — `reopen-external`

```bash
node scripts/cargoflow-roadmap/orchestrator.mjs reopen-external <FAZ> "<kanit>"
```

`block-external`in tersi ve onun kadar dardir: faz GERCEKTEN bloklu olmali,
kanit kaynagi YAZILMALI, onceki fazlar calistirilabilir olmali. Onceki engel
gerekcesi `previousBlockerDetail` olarak KORUNUR. RM-16..RM-19 kilitler.

### DIKKAT — ayni anda IKI gate kosusu BASLATMA

P3'te `P3_SURAT` bir kez dustu; sebep repo DEGILDI, ayni `continue` iki kez
baslatilmisti. Gate kosusu SERI baslatilmalidir.

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
