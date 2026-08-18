# P1 — B2 performans denetimi

Dal: `perf/orders-b2-production-rollout`
Denetim tarihi: 2026-08-18 · commit tabanı: `c904f29`

Amaç: **var olanı yeniden yazmamak.** Aşağıdakiler ölçülerek bulundu.

## Zaten VAR (yeniden yapma)

| Konu | Kanıt |
| --- | --- |
| Sunucu tarafı sayfalama | [`findOrders`](../../server/orders/orderRepository.ts) — `page`/`pageSize`/`total` döner |
| Sayfa boyutu sınırı | `resolvePageSize` (orderRepository.ts:44) |
| N+1 kaldırılmış satır yükleme | `findLinesForOrders` tek sorguda sipariş kümesi için satırları çeker; `orderPersistenceService` bunları `Map` ile gruplar |
| Aralık sorgusu | `findOrdersInRange` |
| Sayım | `countOrdersByOrganization` |
| Tekil erişim | `findOrderById`, `findOrderByPackageId` |
| Bakım araçları | `malformedOrderAuditCli`, `orderLineRepairCli`, `historicalOrderBackfill` |

## EKSİK (P1 kapsamı)

1. **Migration 0008 yok.** `drizzle/` içinde en son `0007_big_thunderbolts.sql`.
   Kanonik sipariş projeksiyonu ve ona ait indeksler henüz üretilmedi.
2. **0008 araç zinciri yok**: preflight, prova (rehearsal), yeniden
   başlatılabilir/idempotent backfill, gölge parite (shadow parity),
   okuma-anahtarı (read-switch) ve geri alma planı.
3. **Sentetik yüksek hacim benchmark'ı yok.** Üretim p50/p95 ölçümü bu ortamda
   YAPILAMAZ — gerektiğinde yalnız o ölçüm için
   `BLOCKED_EXTERNAL_ENVIRONMENT`, fazın tamamı için değil.
4. **Sınırlı dashboard okumaları** doğrulanmadı; `findOrdersInRange` kullanımı
   dashboard yolunda ayrıca ölçülmeli.

## DENETIM DUZELTMESI (bb47cef)

Yukaridaki "N+1 kaldirilmis" satiri EKSIKTI. Kiyaslama yazilinca olculdu:
liste yolunda sorgu sayisi sayfa boyutuyla buyuyordu (10 satir → 13 sorgu,
200 satir → 103). Sebep: siparis SATIRLARI toplu cekiliyordu ama
`attachShipment` dongu ICINDE her siparis icin ayri gonderi/operasyon
sorgusu yapiyordu.

Duzeltildi: `findShipmentsForPackages` + `findLatestOperationsForPackages`
ile sayfa basina tek okuma. Sorgu sayisi artik sayfa boyutundan bagimsiz.

Ders: "toplu cekiliyor" varsayimi OLCULMEDEN denetime yazilmamali.

## Kalan is (guncel)

- **Dashboard/analitik okumasi**: DOGRULANDI (B2-5, B2-6). Tarih araligiyla
  sinirli, `attachShipment` kullanmiyor, sorgu sayisi satir sayisindan
  bagimsiz. Kasitli olarak CAP'SIZ — eksik sayim yanlis ciro demek olurdu.
- **0008 migration**: KAPSAM BELIRSIZ. "Kanonik siparis projeksiyonu" ifadesi
  repoda YALNIZ bu belgede geciyor; onceden tanimli bir sema/spec YOK.
  Siparis tablosunda zaten alti hedefli indeks var. Uretilmeden once
  projeksiyonun HANGI sorguyu hizlandiracagi netlesmeli — kanitsiz migration
  uretilmedi.
- **Uretim p50/p95**: `BLOCKED_EXTERNAL_ENVIRONMENT` (yalniz bu olcum).

## Kurallar

- Üretim migration'ı **çalıştırılmaz**. 0008 yalnız üretilir + hermetik test edilir.
- Üretim p50/p95 **uydurulmaz**.
- Mevcut sayfalama sözleşmesi (`page`/`pageSize`/`total`) **bozulmaz**.

## Sonraki somut adım

`drizzle` şemasına kanonik projeksiyonu ekleyip `0008` migration'ını üret,
ardından hermetik PGlite testiyle indeksleri ve idempotent backfill'i doğrula.
