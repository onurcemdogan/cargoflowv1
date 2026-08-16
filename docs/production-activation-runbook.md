# CargoFlow — Production Activation Runbook

**Bu dosya bir plandır. İçindeki hiçbir komut bu oturumda ÇALIŞTIRILMADI.**

Kapsam: `order_filter_projection` (B2) + arka plan senkron (B3) altyapısının
üretimde etkinleştirilmesi. **Otomatik barkod işçisi bu rollout'a DAHİL DEĞİL**
(bkz. son bölüm).

Komutlar repoda GERÇEKTEN var olan `package.json` script'leridir.

---

## 0. Ön koşullar

- Kanarya tenant'ı **kullanıcı tarafından seçilir**. Bu runbook tenant seçmez.
- `DATABASE_URL`, `ORDER_DATA_ENCRYPTION_KEY`, `SHIPMENT_ENCRYPTION_KEY`,
  `CREDENTIAL_ENCRYPTION_KEY` üretim değerleriyle tanımlı olmalı.
- `LIVE_SURAT_BARCODE_WORKER` **tanımsız veya `false`** olmalı.

---

## 1. Kaynak doğrulama (write yok)

```bash
git rev-parse HEAD
```

```bash
git merge-base --is-ancestor <production-head> HEAD && echo ANCESTOR_OK
```

Beklenen: mevcut üretim HEAD'i bu dalın atasıdır (kayıp commit yok).

## 2. Tam kapı (write yok)

```bash
npm ci
```

```bash
npm run test:surat
```

```bash
npm run build
```

```bash
npm run lint
```

Beklenen: `fail 0`, build PASS, lint 0 error.

## 3. Projeksiyon ön kontrolü — SALT OKUNUR

```bash
npm run projection:preflight
```

Beklenen (0008 öncesi): `MIGRATION_0008_APPLIED NO`, çıkış kodu 1 (fail-closed).
Bu **beklenen** durumdur; migration henüz uygulanmadı.

## 4. Migration analizi (write yok)

```bash
npm run db:check
```

```bash
npm run db:generate
```

Beklenen: `Everything's fine`, ardından **"No schema changes"**. Yeni dosya
üretiliyorsa DUR: kod ile şema arasında drift var.

## 5. Migration — **İLK PRODUCTION WRITE**

> Buraya kadar hiçbir üretim verisi değişmedi. Aşağıdaki komut değiştirir.

```bash
npm run db:migrate
```

Uygulanacaklar: `0008` (order_filter_projection) ve `0009`
(integration_sync_state: last_attempted_at, sync_watermark_at).
Her ikisi de **additive**: DROP/TRUNCATE/ALTER COLUMN yok.

## 6. Şema doğrulaması

```bash
npm run projection:preflight
```

Beklenen: `MIGRATION_0008_APPLIED YES`, `PROJECTION_COLUMNS_OK YES`,
`PROJECTION_INDEXES_OK YES`, `PROJECTION_FK_CASCADE_OK YES`, çıkış kodu 0.
Tenant satırlarında `stale` = sipariş sayısı (backfill henüz yapılmadı).

```bash
npm run db:verify
```

## 7. Kanarya backfill — önce KURU KOŞUM

```bash
npm run projection:backfill -- --org <CANARY_ORG_ID> --dry-run
```

Beklenen: `MODE DRY_RUN`, `WRITTEN 0`, `SCANNED` = tenant sipariş sayısı.

## 8. Kanarya backfill — sınırlı gerçek koşum

```bash
npm run projection:backfill -- --org <CANARY_ORG_ID> --batch-size 500 --max-batches 2
```

Sonra kalanı:

```bash
npm run projection:backfill -- --org <CANARY_ORG_ID> --batch-size 500 --resume
```

Beklenen: `UNCOVERED_ORDERS 0`. `SKIPPED_STALE > 0` ise koşumu tekrarlayın
(canlı yazım daha yeniydi — doğru davranış).

## 9. Hazırlık kontrolü

```bash
npm run projection:preflight -- --org <CANARY_ORG_ID>
```

Beklenen: o tenant için `stale=0`, `candidate=YES`.
**Not:** `candidate` ≠ `ready`. Gerçek hazırlık gölge parite kabulünü de
gerektirir (adım 10-11).

## 10. Gölge mod

Tenant okuma modu `shadow` yapılır (uygulama yapılandırması; kod dağıtımı
gerekmez). Kullanıcıya dönen sonuç **her zaman eski yoldur**.

## 11. Parite gözlemi

Gölge karşılaştırması `parity: true` üretmelidir. `missingHashed` veya
`extraHashed` boş değilse **rollout DURUR** — bu sessizce tolere edilmez.

## 12. Gecikme doğrulaması (opsiyonel, yerel)

```bash
npm run benchmark:projection-prefilter -- 1000 5000 10000
```

Beklenen: `PARITY_ALL OK`. Süreler PGlite'a özgüdür; üretim Postgres'inde
tekrar ölçülmelidir (bkz. `docs` içindeki ölçüm notu).

## 13. Kanarya okuma modu

Tenant modu `projection` yapılır. Hazır olmayan tenant otomatik olarak
`legacy`'ye düşer (fail-safe).

## 14. Arka plan senkron kanaryası

Kanarya tenant'ta manuel yenileme ve zamanlanmış tur gözlenir:
tek uçuş korunuyor mu, `sync_watermark_at` ilerliyor mu, hata durumunda
`last_successful_sync_at` korunuyor mu.

## 15. Duman testleri

- Siparişler sayfası: liste, sekme, sayfalama, filtre
- Dashboard: sayaçlar
- "Şimdi Yenile": liste kaybolmuyor
- Etiket yazdır: **taşıyıcıya create ATMIYOR** (kalıcı artifact'tan)

---

## GERİ ALMA

Anında, kod dağıtımı gerektirmez:

1. Tenant okuma modunu `legacy` yap. Etki: **anında**.
2. Projeksiyon verisi **silinmez**. Migration **geri alınmaz**.
3. Diğer tenantlar etkilenmez.

Backfill'i geri almak gerekmez; projeksiyon satırları okunmadığı sürece
zararsızdır. Gerekirse tenant kapsamlı temizlik ayrı bir karardır.

---

## OTOMATİK BARKOD İŞÇİSİ — AYRI KANARYA

Bu rollout'ta **açılmaz**:

```
LIVE_SURAT_BARCODE_WORKER   tanımsız / false
```

Gerekçe: projeksiyon + senkron rollout'u ile canlı taşıyıcı yan etkisini aynı
anda devreye almak, bir sorun çıktığında hangi değişikliğin sebep olduğunu
ayırt etmeyi imkânsız kılar. Barkod işçisi ancak senkron kararlılığı
kanıtlandıktan sonra, **kendi ayrı kanaryasıyla** açılır.
