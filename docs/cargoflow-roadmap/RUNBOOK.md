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

**S1 · P1 · P2 · P3 = passed.** **P4_HEPSIBURADA_N11 = in_progress.**

Son dal: `feat/surat-barcode-worker-finalization`.

### P2 (bitti)

Artimli imlec BAGLANDI: cekim penceresi `integration_sync_state` imlecinden
turetiliyor, imlec pencerenin UST SINIRINA yaziliyor (`now()` degil) ve YALNIZ
tam basarili sync'te ilerliyor. Periyodik genis tarama imlecin ZAMAN
KOVASINDAN turetildi → migration GEREKMEDI. Ayrinti: [P2_AUDIT.md](P2_AUDIT.md).

### P3 (bitti)

Olculen kusur: `requestFingerprint` uretiliyor/yaziliyor ama HIC okunmuyordu;
`financialFingerprint` kapinin disina hic cikmiyordu. Anahtar
`SURAT:${tenant}:${order}:CREATE` oldugu icin duzeltilmis desi ya da degismis
odeyen taraf ESKI etiketi "basarili" diye geri oynatiyordu.

Cozum FAIL-CLOSED: her iki parmak izi replay dallarindan ONCE kiyaslanir; fark
varsa NE replay NE create. Anahtar DEGISMEDI (katilsaydi ayni siparis icin
ikinci fiziksel gonderi dogardi). Eski kayitlar bloklanmaz: yalniz IKI tarafta
da bulunan eksen kiyaslanir. Ayrinti: [P3_AUDIT.md](P3_AUDIT.md).

Ayrica plana kuyruk oncesi finansal predicate eklendi (kuyruk hijyeni; otoriter
kapi SUNUCUDA ve fail-closed KALIR).

### Arac notu

`boundOutput` dusen testin hata metnini artik ATMIYOR. Onceki davranis 1,2 MB
suite ciktisini bas+son kirpiyordu ve dosya seviyesindeki hata tam ortada
kaliyordu; bir P3 kosusunun sebebi bu yuzden raporda gorunmedi.

### DIKKAT — ayni anda IKI gate kosusu BASLATMA

P3'te `P3_SURAT` bir kez dustu. Sebep repo DEGILDI: ayni `continue` iki kez
baslatilmisti ve iki tam suite es zamanli kostu (ortak yerel config store'a
yazan `surat-service-mode-roundtrip` carpisti). Tek kosuda 1875/1875 gecti.
Gate kosusu SERI baslatilmalidir.

### Sonraki faz — P4_HEPSIBURADA_N11

Gate su an BLOCKED (`NOT_IMPLEMENTED`) ve bu DOGRU: saglayici-notr temel icin
Hepsiburada/N11 DIS SOZLESMESI dogrulanmadan kod yazilmaz. CONTRACT'a gore
P4/P5/P6 `blocked_external_contract` isaretlenebilir; bu bir INSAN kararidir ve
orkestratorde bilerek komutu YOKTUR.

Once yapilacak: dis sozlesme kanitini topla (API dokumani, kimlik, sandbox).
Kanit yoksa fazi `blocked_external_contract` isaretleme karari alinmalidir.

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
