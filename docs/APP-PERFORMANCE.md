# Uygulama Performansı — ölçüm raporu

Ölçüm komutu:

```bash
PERF_ORDERS=2000 PERF_REPEATS=30 npx tsx server/benchmarks/appPerformanceBenchmark.ts
```

## Kapsam uyarısı (önce okunmalı)

Bu rakamlar **hermetik PGlite** üzerinde ölçülmüştür. Üretim PostgreSQL'inin
ağı, diski, bağlantı havuzu, eşzamanlı yükü ve planlayıcı istatistikleri
**yoktur**. Bu yüzden rakamlar **üretim SLA'sı olarak alıntılanamaz**;
yalnız koşular arası **göreli** karşılaştırma içindir.

Ortamdan bağımsız ve üretime taşınabilen tek sonuç **sorgu sayısıdır**.

## Ölçüm (2000 sipariş, 30 tekrar)

| Yol | p50 (ms) | p95 (ms) | Sorgu |
| --- | ---: | ---: | ---: |
| Sipariş listesi — sayfa 50 | 22,5 | 29,6 | 5 |
| Sipariş listesi — sayfa 100 | 31,4 | 38,9 | 5 |
| Dashboard — dönemsel satış (27 gün) | 139,8 | 190,8 | 2 |
| Sipariş detayı | 4,3 | 6,8 | 4 |
| Hazır etiket okuması | 7,0 | 10,5 | 5 |

## N+1 muhafızı

Sayfa başına sorgu sayısı **sayfa boyutundan bağımsızdır**:

```
10 satır  → 5 sorgu
50 satır  → 5 sorgu
100 satır → 5 sorgu
```

Sipariş, gönderi ve operasyon okumaları sayfa başına **tek** sorguyla
çözülür (`findLinesForOrders`, `findShipmentsForPackages`,
`findLatestOperationsForPackages` toplu `inArray` kullanır). Bu değişmez
`server/app-performance-flow.test.mjs` (PERF-1…PERF-3) ile korunur; test
gecikme eşiği dayatmaz, yalnız sorgu sayısını sabitler.

## UI pazaryerini BEKLEMEZ

`UI_WAITS_FOR_TRENDYOL = NO`.

- Çalışma zamanı kanıtı (PERF-5): `listOrders`, `listOrdersForAnalytics`,
  `getOrder` ve `resolvePersistedLabel` çağrılırken `fetch` tuzaklanır ve
  **hiç çağrılmaz**.
- Yapısal kanıt (PERF-6): `GET /api/orders` handler'ı Trendyol istemcisi,
  senkron tetikleyicisi veya ham `fetch` içermez.

Kullanıcının listesi yalnız yerel PostgreSQL'den gelir; pazaryeri
yavaşladığında ekran yavaşlamaz.

## Bilinen darboğaz (dürüst tespit)

**Dashboard dönemsel satış** en yavaş yoldur: 2000 siparişte p95 ≈ 191 ms.
`listOrdersForAnalytics` aralıktaki **tüm** siparişleri sayfalamasız çeker ve
view-model'e çevirir; maliyet sipariş sayısıyla **doğrusal** büyür. Aylık
20.000 siparişte ~1,4 sn beklenir.

Sorgu sayısı zaten minimumdur (2); kazanç ancak **veritabanı tarafında
toplama** (SQL `GROUP BY` ile aggregate) ile gelir — satırları uygulamaya
taşımak yerine. Bu, ayrı ve kapsamı belirlenmiş bir iştir; bu turda
**yapılmamıştır** ve burada açıkça kayda geçirilir.
