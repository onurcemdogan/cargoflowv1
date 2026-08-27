# Dashboard Toplamaları — Postgres Tarafı

## Kök neden (ölçüldü, tahmin edilmedi)

Dashboard satış kartları, aralıktaki **tüm** siparişleri Node'a çekip orada
topluyordu. Katman ölçümü (PGlite, 2000 sipariş):

```
orders SELECT            35 ms
order_lines SELECT       31 ms
tam yol (map dâhil)      77 ms
istemciye giden yük    1933 KB
```

Maliyetin neredeyse tamamı **satır aktarımıdır**; eşleme ucuzdur. Doğru
düzeltme sorguyu hızlandırmak değil, **satırları hiç taşımamaktır**.

## Ölçüm (ÖNCE / SONRA)

```
boyut   JS p50   JS p95   SQL p50  SQL p95  satır ÖNCE  satır SONRA  yük ÖNCE
 2000   120.0    126.9      9.8     11.3       2000         165      2427 KB
10000   612.2    627.7     39.9     42.6      10000         165     12199 KB
25000  1486.7   1511.8    103.5    113.8      25000         165     30725 KB
```

Node'a dönen satır sayısı **sipariş sayısından bağımsızdır**: en fazla
gün × pazaryeri × dispozisyon kadardır.

Komut:

```bash
DASH_SIZES=2000,10000,25000 npx tsx server/benchmarks/dashboardAggregateBenchmark.ts
```

### ANALYZE zorunludur

İstatistiksiz taze bir veritabanında planlayıcı felaket bir plan seçiyor ve
aynı sorgu 10 ms yerine **~1400 ms** sürüyor. Üretimde autovacuum bunu
sürdürür; benchmark de seed sonrası `ANALYZE` çalıştırır. Aksi hâlde ölçüm
üretimi temsil etmez ve "SQL yavaş" gibi **yanlış** bir sonuca götürür.

## Anlam korunur

| Metrik | Tanım |
| --- | --- |
| PAKET | `DISTINCT package_id` (bölünmüş sevkiyat = iki birim) |
| KALEM | `order_lines` satır sayısı (adet toplamı değil) |
| ADET | `order_lines.quantity` toplamı |
| TUTAR | `total_amount` (NULL → 0) → negatifse Σ `unit_price × quantity` |
| GÜN | `order_date`'in UTC günü |
| EKSEN | `order_date` (aktivite tarihi değil) |

`totalsFromBuckets` alanları `calculatePeriodTotals` ile **birebir**
eşleşir; bu eşleşme DASH-SQL-2 ile kilitlidir ve fixture kasıtlı olarak
zordur (bölünmüş sevkiyat, iade, iptal, çok satırlı sipariş, tutarsız
sipariş, aralık dışı sipariş).

### NULL tutar = 0 TL (korunan davranış)

`rowToOrder`, `Number(null) = 0` ile NULL tutarı sıfıra çevirir; bugünkü
dashboard "tutarı yok" siparişi 0 TL sayar ve toplamı güvenilir işaretler.
Tartışılabilir bir davranıştır ama **bu turun işi değildir**: para anlamını
değiştirmemek için SQL de aynısını yapar.

## Dispozisyon neden kolon oldu

Dispozisyon `marketplace_status`'ın yanı sıra **şifreli** ham payload'daki
`status` sinyalini de kullanır; SQL onu okuyamaz. Kuralı SQL'de yeniden
yazmak ikinci bir uygulama doğurur ve Türkçe-katlamalı normalize,
RETURN>CANCEL>SALE önceliği ve alt-dize eşleşmesi zamanla ayrışır.

Bu yüzden değer **yazım anında**, istemcinin kullandığı aynı saf fonksiyonla
(`orderDispositionOf`) hesaplanıp `orders.sales_disposition` kolonuna
yazılır. Tek uygulama, SQL'de gruplanabilir.

### Geri doldurma zorunlu

Göçten önceki satırlarda kolon NULL'dur ve NULL 'sale' sayılır — geri
doldurulmazsa **geçmiş iade/iptaller satış görünür**. DASH-SQL-8 bunu
kanıtlar (öncesinde returnCount=0, sonrasında 2).

```bash
npx tsx server/orders/backfillSalesDispositionCli.ts --dry-run
npx tsx server/orders/backfillSalesDispositionCli.ts
```

İdempotenttir: yalnız `sales_disposition IS NULL` satırlara dokunur.

## İndeks denetimi (plan kanıtı)

**Yeni indeks EKLENMEDİ.** Spekülatif bir indeks eklenmiş, sonra plan
kanıtına dayanarak **geri alınmıştır**.

Tüm aralık (25.000 satırın 25.000'i seçiliyor):

```
Seq Scan on orders o  (rows=25000)  Execution Time: 56.9 ms
```

Seq scan burada **doğrudur**; %100 seçicilikte indeks daha yavaş olurdu.

Seçici pencere (3 gün, ~%7):

```
Bitmap Heap Scan on orders o (rows=1820)  Execution Time: ~3 ms
Recheck Cond: (organization_id = ... AND order_date >= ... AND order_date <= ...)
```

Bu, **mevcut** `orders_org_order_date_idx` indeksidir. Eklemeyi düşündüğüm
`(organization_id, marketplace_account_id, order_date)` indeksi plan
tarafından **kullanılmadı**; `IS NOT DISTINCT FROM NULL` zaten indeks
koşuluna dönüşmez. Kanıt desteklemediği için indeks kaldırıldı ve 0011
yalnız `ADD COLUMN` içerir.

## Kapsam — ne SQL'de, ne değil

**SQL'de:** satış/iade/iptal tutarları, paket sayısı, kalem sayısı, adet
toplamı; gün × pazaryeri × dispozisyon kovaları. `/api/analytics/orders`
bunu `summary` alanıyla döner (`summarySource: 'sql-aggregate'`).

**Hâlâ satır taşıyan:** istemcideki `buildDashboardViewModel`, kabul edilmiş
**iade mutabakatını** (claims) paket ve satır düzeyinde uygular; bu, sipariş
satırlarını gerektirir. Kart sayılarını SQL'e çevirmek claim düzeltmesini de
SQL'e taşımayı gerektirir ve bu **para anlamını değiştirir** — kendi
kanıtıyla ayrı bir iş olarak yapılmalıdır. Bu turda yapılmamıştır ve burada
açıkça kayda geçirilmiştir.
