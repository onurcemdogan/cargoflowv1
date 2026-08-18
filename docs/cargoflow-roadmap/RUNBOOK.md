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

## Guncel konum — YOL HARITASI TAMAMLANDI

`CURRENT_PHASE=COMPLETE`. Uygulanabilir dort fazin HEPSI gecti; kalan uc faz
DIS SOZLESME eksikligiyle bloklu. `liveCreateAllowed=false` (her durumda).

| Faz | Durum | Dal |
| --- | --- | --- |
| S1_SURAT_HARDENING | passed | `fix/surat-canonical-kargobarkod-and-debug-ui` |
| P1_B2_PERFORMANCE | passed | `perf/orders-b2-production-rollout` |
| P2_B3_INCREMENTAL_SYNC | passed | `perf/orders-b3-incremental-sync` |
| P3_B4_BARCODE_WORKER | passed | `feat/surat-barcode-worker-finalization` |
| P4_HEPSIBURADA_N11 | blocked_external_contract | — |
| P5_ARAS | blocked_external_contract | `feat/carrier-aras-foundation` |
| P6_SURAT_NON_MARKETPLACE | blocked_external_contract | `feat/surat-non-marketplace-contract` |

### P2 · P3 (gecti)

- **P2**: imlec artik OKUNUYOR — cekim penceresi `integration_sync_state`ten
  turetiliyor, imlec pencerenin UST SINIRINA yaziliyor ve YALNIZ tam basarili
  sync'te ilerliyor. Periyodik genis tarama imlecin ZAMAN KOVASINDAN turetildi:
  migration GEREKMEDI. [P2_AUDIT.md](P2_AUDIT.md)
- **P3**: `requestFingerprint` ve `financialFingerprint` artik replay'den ONCE
  kiyaslaniyor. Duzeltilmis desi ya da degismis odeyen taraf eski etiketi
  "basarili" diye geri oynatamaz; fark varsa NE replay NE create.
  [P3_AUDIT.md](P3_AUDIT.md)

### P4 · P5 · P6 (dis sozlesme bekliyor)

Ucunde de kural AYNI: **dis API alani TAHMIN EDILMEDI.** Her fazin denetimi,
sozlesme geldiginde ne gerektigini madde madde yaziyor.

- **P4** — Hepsiburada/N11 sozlesmesi repoda YOK (adapter/WSDL/fixture/credential
  = sifir). Saglayici-notr temel OLCULDU: depolama, izolasyon ve mutabakat
  ZATEN notr; kimlik allowlist'i, kapali `IntegrationProvider` birlesimi ve
  index.mjs'e gomulu fetch/normalize notr DEGIL. Adaptor arayuzu BILEREK
  yazilmadi. [P4_AUDIT.md](P4_AUDIT.md)
- **P5** — Aras sozlesmesi YOK. Tasiyici-notr temelin sozlesmeden BAGIMSIZ
  yarisi tamamlandi ve kilitlendi: Surat yolu yabanci gonderiyi ne create'te ne
  render'da sahiplenir (`carrier-neutral-foundation-flow`, 7/7).
  [P5_AUDIT.md](P5_AUDIT.md)
- **P6** — Surat ENTEGRE; eksik olan sozlesmenin pazaryeri DISI dali. Model
  pazaryeri disini zaten taniyor ve fail-closed dogruluyor, ama
  `ownPlatformReference` icin URETIM CAGIRANI YOK ve bu BILEREK boyle. Eksik tek
  gercek: `Pazaryerimi=0` gonderisinde `OzelKargoTakipNo` NE olmali.
  [P6_AUDIT.md](P6_AUDIT.md)

### Yeni komut — `block-external`

```bash
node scripts/cargoflow-roadmap/orchestrator.mjs block-external <FAZ> "<gerekce>"
```

Faz ATLAMA komutu DEGILDIR. Kapilari: yalniz P4/P5/P6, yalniz SIRADAKI faz,
`passed` faz geri alinamaz, gerekce ZORUNLU. RM-11 S1/P1/P2/P3'un bu kapidan
GECEMEDIGINI kilitler.

### Faz ACILIRSA ne yapilir

Sozlesme kaniti geldiginde: ilgili `P*_AUDIT.md`nin "Sozlesme geldiginde gereken
KANIT" bolumunu karsila, sonra fazi `in_progress` yapip gate'i gercek testlere
bagla. P6'da `NM-4`, P5'te `CN-6`/`CN-7` bilerek konmus BEKCILERDIR: o gun
duserler ve karar BILINCLI verilir.

### DIKKAT — ayni anda IKI gate kosusu BASLATMA

P3'te `P3_SURAT` bir kez dustu. Sebep repo DEGILDI: ayni `continue` iki kez
baslatilmisti ve iki tam suite es zamanli kostu. Tek kosuda 1875/1875 gecti.

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
