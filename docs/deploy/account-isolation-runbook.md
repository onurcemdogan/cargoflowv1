# Trendyol Pazaryeri Hesap İzolasyonu — Deployment Runbook

Bu runbook `feat/trendyol-account-isolation` (FAZ 0) değişikliğinin production'a
alınması içindir. Migration + legacy backfill + yeni kod **birbirine bağımlıdır**;
yarım deploy yapılmamalıdır.

> Bu doküman talimattır. Buradaki komutları çalıştıran kişi **operasyon
> yöneticisidir**. Claude/otomasyon production DB'ye bağlanmaz, migration/backfill
> çalıştırmaz, deploy/PM2/Nginx yapmaz.

---

## 0. Migration ↔ uygulama uyumluluğu (KRİTİK)

`0006_faulty_mongoose.sql` şunları yapar (non-destructive: DROP TABLE / DELETE /
NOT NULL zorlaması YOK):

- `marketplace_accounts` tablosunu oluşturur.
- `orders`, `products`, `integration_sync_state` tablolarına **nullable**
  `marketplace_account_id` ekler.
- Bu üç tablonun eski `UNIQUE INDEX`'lerini **DROP** eder ve yerlerine
  `marketplace_account_id` içeren `UNIQUE ... NULLS NOT DISTINCT` constraint kurar.

**Uyumsuzluk:** ESKİ uygulama kodu `ON CONFLICT (organization_id, marketplace,
package_id)` (3 kolon) kullanır. Migration bu 3-kolonlu index'i kaldırdığı için,
migration'dan SONRA eski kod upsert'te "no unique constraint matching" hatası
verir. Bu nedenle:

- **Migration ile yeni kod arasında eski uygulama ÇALIŞAMAZ.**
- Migration ancak PM2 (uygulama) **DURDURULMUŞKEN** uygulanmalı ve hemen ardından
  YENİ kod başlatılmalıdır. Bakım penceresi boyunca PM2 kapalı kalır.
- Rollback gerekirse: yeni kod durdurulup migration geri alınana kadar eski kod
  da başlatılmamalıdır (aşağıya bakın).

**Backfill neden zorunlu:** Migration sonrası mevcut `orders/products/
integration_sync_state` kayıtlarının `marketplace_account_id` değeri NULL kalır.
Yeni uygulama yalnız AKTİF hesap kapsamındaki kayıtları gösterdiği için, backfill
yapılmadan mevcut siparişler/etiketler/ürünler kullanıcıya **kaybolmuş görünür**
(fiziksel silinmezler). Bu yüzden backfill deploy'un ayrılmaz parçasıdır.

---

## 1. Backfill CLI — kullanım

Hesap **tahmin edilmez**; operasyon yöneticisi eski Trendyol hesabının
`sellerId`'sini açıkça verir.

Dry-run (VARSAYILAN — DB'yi değiştirmez):

```bash
npm run marketplace-account:backfill -- \
  --organization-id <UUID> \
  --marketplace Trendyol \
  --provider-account-id <SELLER_ID> \
  --dry-run
```

Apply (dry-run çıktısındaki onay token'ı ile):

```bash
npm run marketplace-account:backfill -- \
  --organization-id <UUID> \
  --marketplace Trendyol \
  --provider-account-id <SELLER_ID> \
  --apply \
  --confirmation-token <TOKEN>
```

Rollback dry-run / apply:

```bash
npm run marketplace-account:backfill -- --rollback-batch <BATCH_ID> --dry-run
npm run marketplace-account:backfill -- --rollback-batch <BATCH_ID> --apply
```

Notlar:

- Manifest `MARKETPLACE_BACKFILL_MANIFEST_DIR` (vars. çalışma dizini) altına
  `marketplace-account-backfill-<BATCH_ID>.json` olarak yazılır. **Secret/PII
  içermez**, `.gitignore`'dadır. Rollback bu dosyayı okur — **saklayın**.
- CLI yalnız `marketplace_account_id IS NULL` kayıtları hedefe çevirir; NULL
  olmayan hiçbir scope'u değiştirmez; başka tenant'a dokunmaz; tek transaction'da
  uygular (hata → tümü ROLLBACK). Conflict varsa hiçbir şey değiştirmeden durur.
- İkinci kez çalıştırılırsa idempotenttir (0 kayıt değiştirir).
- Hedef hesap yoksa apply sırasında **pasif** olarak oluşturulur (aktif hesabı
  değiştirmez).

---

## 2. Production deploy sırası

> Bakım penceresi + PM2 kapalı + DB yedeği zorunlu. Adımların hepsi tamamlanana
> kadar yarım bırakılmaz.

1. **Bakım penceresi başlat** (kullanıcı erişimini kapat / bakım sayfası).
2. **Yeni provider sync'lerini durdur** (zamanlanmış sync/cron varsa kapat).
3. **PostgreSQL backup al ve doğrula** (`pg_dump`; boyut/erişilebilirlik doğrula).
4. **PM2 uygulamasını durdur** (`pm2 stop <app>`). Migration boyunca kapalı kalır
   (bkz. §0 — eski kod migrasyonlu şemada çalışamaz).
5. **Yeni master kodunu çek** (branch review + merge sonrası `git pull`).
6. `rm -rf node_modules && npx -y npm@10.9.8 ci`
7. `npm run build`
8. **Migration uygula** (proje komutu; production DB). `npm run db:check` ile
   şema/journal tutarlılığını doğrula.
9. **Backfill DRY-RUN** — eski hesabın açık `sellerId`'siyle her organization için:
   `... --provider-account-id <SELLER_ID> --dry-run`. Çıktıdaki
   `legacy*Found / conflicting* / eligible*` sayılarını ve onay token'ını topla.
10. **Sayıları operasyon yöneticisine doğrulat.** `conflicting* > 0` ise apply
    YAPMA — conflict'i incele (§Rollback), otomatik merge/delete yok.
11. **Backfill APPLY** — doğrulanan token ile:
    `... --apply --confirmation-token <TOKEN>`. Her org için `BATCH_ID` +
    manifest dosyasını sakla.
12. **Backfill sonrası SQL doğrulaması** — beklenen `marketplace_account_id`
    dağılımı: `SELECT marketplace_account_id, count(*) FROM orders WHERE
    organization_id = '<UUID>' GROUP BY 1;` (NULL kalan legacy kayıt beklenmiyorsa
    0 olmalı; kalanlar başka hesaba aitse ayrı backfill gerekir).
13. **Doğru Trendyol hesabını active yap** — (a) backfill edilen eski hesap hâlâ
    kullanılıyorsa onu; (b) yeni bir hesaba geçiliyorsa yeni hesabı. Aktif hesap
    ayarları kaydedince (`PUT /api/local-config/integration`) deterministik çözülür.
14. **PM2 başlat** (`pm2 start <app>`). (Yeni kod artık migrasyonlu şemayla uyumlu.)
15. **Health check** — `/api/health` 200; DB `configured:true, ok:true`.
16. **Smoke test** — Orders/Products/Dashboard yüklenir; aktif hesabın kayıtları
    görünür; başka hesabın order id'siyle `GET /api/orders/:id` ve `/label` **404**.
17. **Yeni hesap COMPLETE sync** — `POST /api/orders/sync` (auth) → 200/COMPLETE;
    `syncStatus=COMPLETE`, `lastSuccessfulSyncAt` güncellenir.
18. **İzolasyon doğrulaması** — aktif hesapta başka hesabın verisi görünmüyor;
    Dashboard/recentOperations/sayaçlar yalnız aktif hesap.
19. **Eski hesap etiket erişimi** — eski hesabı geçici active edip birkaç
    LABEL_READY/LABEL_PRINTED siparişin etiketinin indirilip yazdırılabildiğini
    doğrula (reprint). Sonra §20.
20. **Tekrar hedef hesabı active yap** ve bakım penceresini kapat.

Not: Adım 13 UI'da tek aktif hesabı belirler; hangi hesabın aktif olacağı
operasyonel karardır. Backfill (adım 11) aktif hesabı değiştirmez.

---

## 3. Rollback runbook

Her senaryoda **önce PM2'yi durdur** (yarım durum kullanıcıya yansımasın).

### 3.1 Uygulama restart başarısız olursa
- `pm2 logs` ile hatayı incele. Kod hatasıysa: PM2 durdur, önceki sürüme dön
  (`git checkout <prev>`, `npm ci`, `npm run build`, `pm2 start`) **ancak** migration
  hâlâ uygulanmışsa eski kod çalışmaz (§0). Bu durumda önce §3.2 (migration
  rollback) uygulanmalı.

### 3.2 Migration başarısız olursa
- Migration transaction'ı atomiktir; kısmi uygulanmışsa DB'yi backup'tan
  (adım 3) geri yükle. Şema doğrulaması: `npm run db:check`.
- Eski kodu ancak migration geri alındıktan / backup geri yüklendikten SONRA başlat.

### 3.3 Backfill conflict verirse
- Apply zaten hiçbir şey değiştirmeden durur (transaction rollback). Dry-run
  raporundaki `conflictingOrders/Products/SyncStates` kayıtlarını incele:
  aynı hesap + packageId/externalProductId/(provider,resource) çakışması demektir.
- Otomatik merge/delete YAPMA. Çakışan kayıtları operasyon yöneticisiyle
  değerlendir (ör. legacy kaydın gerçekten o hesaba mı ait olduğu). Gerekirse
  çakışan legacy kaydı elle ayıklayıp backfill'i tekrar dene.

### 3.4 Backfill sonrası sayılar yanlışsa
- İlgili `BATCH_ID` manifestiyle: `--rollback-batch <BATCH_ID> --dry-run` →
  `reversible*` ve `modifiedSince*` sayılarını gör. `safe:true` ise
  `--rollback-batch <BATCH_ID> --apply` batch'in bağladığı kayıtları tekrar NULL
  yapar. `safe:false` ise (kayıtlar sonradan başka işlemle değişmiş) rollback
  DURUR — elle inceleme gerekir.

### 3.5 Yeni hesap siparişleri görünmezse
- Aktif hesabın doğru çözüldüğünü doğrula: `marketplace_accounts` içinde
  `(org, 'Trendyol')` için tek `is_active=true` satır olmalı ve `provider_account_id`
  beklenen `sellerId` olmalı. Değilse ayarları tekrar kaydet (adım 13).
- Ardından COMPLETE sync (adım 17) tekrar denenir.

### 3.6 Eski hesap verileri yanlış hesapta görünürse
- Muhtemelen backfill yanlış `--provider-account-id` ile çalıştı. İlgili
  `BATCH_ID` ile rollback (§3.4, `safe:true` iken) → NULL'a döndür → doğru
  `sellerId` ile backfill'i tekrar çalıştır.

---

## 4. Kapılar (deploy öncesi CI)

```bash
rm -rf node_modules
npx -y npm@10.9.8 ci
npm run lint
npm run build
npm run db:check
npm run test:surat
```

`test:surat` backfill (`marketplace-account-backfill`) + izolasyon + foundation
testlerini içerir.
