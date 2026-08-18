# P4 — Hepsiburada / N11 sağlayıcı-nötr temel denetimi

Dal: `feat/surat-barcode-worker-finalization` · taban: `641c6b1`

Kapsam (STATE): **sağlayıcı-nötr temel; dış sözleşme doğrulanmalı.**

> Kural (CONTRACT): dış API endpoint/auth/request/response alanları
> **ASLA TAHMİN EDİLMEZ**. Sözleşme kanıtı yoksa faz `blocked_external_contract`
> olur — sahte PASS da, uydurma wire sözleşmesi de yasaktır.

---

## 1. DIŞ SÖZLEŞME ARAMASI — SONUÇ: KANIT YOK

Repo genelinde arandı (node_modules ve .git hariç):

| Arama | Sonuç |
| --- | --- |
| Dosya adı `*hepsiburada*`, `*n11*` | **0 dosya** |
| `*.wsdl` | yalnız `tmp/pdfs/surat-services.wsdl` (Sürat = TAŞIYICI, pazaryeri değil) |
| `openapi*`, `swagger*`, `*postman*` | **0 dosya** |
| `server/fixtures/` | yalnız Sürat ZPL örnekleri (`real-template-masked.zpl`, `synthetic-surat-reference.zpl`, `surat-render/`) |
| `docs/` | Hepsiburada/N11 sözleşme belgesi **YOK** |
| Kimlik/credential şeması | Hepsiburada/N11 girdisi **YOK** |
| Adapter/client/endpoint kodu | **YOK** |

Kodda geçen Hepsiburada/N11 izleri YALNIZ etikettir, entegrasyon değildir:

- [providerRegistry.ts](../../src/dashboard/providerRegistry.ts) — `enabled: false`
  görüntü kaydı (Amazon, ÇiçekSepeti, Pazarama, Shopify, WooCommerce ile aynı
  durumda),
- [cargoflow.ts](../../src/types/cargoflow.ts) — `Marketplace` birleşiminde ad,
- [OrdersPage.tsx](../../src/pages/OrdersPage.tsx) — filtre listesinde ad,
- [suratCanonicalGonderiModel.ts](../../server/shipments/suratCanonicalGonderiModel.ts)
  — SÜRAT'ın `entegrasyonFirmasi` alanına yazılan **string**. Bu, Sürat
  sözleşmesinin bir alanıdır; Hepsiburada'nın kendi API'siyle İLGİSİ YOKTUR.

**Karar: `P4_HEPSIBURADA_N11 = blocked_external_contract`.**

Doğrulanmış sözleşme olmadan yazılabilecek tek şey tahmindir: endpoint yolu,
auth şeması (OAuth mı, basic mi, imzalı mı), sayfalama, tarih ekseni, statü
sözlüğü, paket/kalem kimliği. Bunların HİÇBİRİ tahmin edilemez — P2'de ölçülen
"Trendyol penceresi hangi tarih eksenini filtreliyor" belirsizliği, sözleşmesi
OLAN bir sağlayıcıda bile ne kadar dikkat gerektiğini gösterdi.

---

## 2. SAĞLAYICI-NÖTR TEMEL — ÖLÇÜLDÜ

Bu bölüm sözleşmeden BAĞIMSIZDIR ve şimdi ölçülebilir. Sonuç: **veri modeli
büyük ölçüde nötr, entegrasyon YOLU tek sağlayıcıya bağlı.**

### 2.1 ZATEN NÖTR (migration gerekmez)

| Katman | Kanıt |
| --- | --- |
| `orders.marketplace` | `text('marketplace').notNull()` — allowlist YOK |
| `shipments.marketplace` | aynı; serbest metin |
| `marketplace_accounts.marketplace` | serbest metin; tekillik `(org, marketplace, providerAccountId)` |
| Hesap izolasyonu | `(org, marketplace)` başına tek aktif hesap — kural sağlayıcıdan BAĞIMSIZ |
| Sync durumu / imleç | `integration_sync_state` `(org, provider, resource, account)` — `provider` serbest metin |
| Kalıcılaştırma | `persistSyncResult(db, org, normalizedOrders, …)` — imzasında Trendyol YOK |
| Mutabakat / arşivleme | pencere + hesap kapsamlı; sağlayıcıya bakmaz |
| Sipariş satırı tekilliği | `externalLineId` canonical; sağlayıcıya bakmaz |
| Frontend sağlayıcı kaydı | `providerRegistry` 8 pazaryeri + 10 taşıyıcı, `enabled` bayrağıyla |

Yani bir sipariş `marketplace='Hepsiburada'` ile yazılsa depolama, izolasyon,
mutabakat ve UI katmanları **bugün de çalışır**.

### 2.2 NÖTR DEĞİL — ölçülen üç bağlanma noktası

1. **Kimlik allowlist'i DB seviyesinde kilitli.**

   ```sql
   check integration_credentials_provider_check:
     provider in ('trendyol', 'surat')
   ```

   Hepsiburada/N11 kimliği bu tabloya **YAZILAMAZ**; genişletmek migration
   ister. Veri katmanındaki TEK sert engel budur.

2. **`IntegrationProvider` kapalı birleşim.**
   `credentialService.ts:9` → `'trendyol' | 'surat'`, ve
   `loadOrganizationIntegrationConfig` sabit `{ trendyol, surat }` döner.

3. **Çekim + normalize tek sağlayıcıya gömülü.**
   `callTrendyolOrders*` ve `normalizeTrendyolOrders` `server/index.mjs`
   içindedir (dosyada 322 Trendyol geçişi). Sağlayıcı seçen bir dispatch ya da
   adapter arayüzü **YOKTUR** (`grep marketplaceAdapter|providerAdapter` → 0).

### 2.3 Seam NEREDE — sözleşme geldiğinde yapılacak iş

Ölçüm net bir sınır gösteriyor:

```
[sağlayıcıya ÖZEL]  fetch → normalize
                          ↓  (normalizedOrders)
[sağlayıcıdan BAĞIMSIZ]  persistSyncResult → reconcile → accounts → UI
```

İkinci pazaryeri için gereken, aşağı akışı DEĞİŞTİRMEK değil, yukarıdaki iki
adımı bir arayüzün arkasına almaktır:

- `fetchOrders(window, credentials) → rawPages`
- `normalizeOrders(rawPages) → normalizedOrders`

**Bu arayüz şimdi yazılmadı.** Sebep ölçüye dayanır: tek bir gerçek uygulaması
olan bir soyutlama, ikinci uygulamanın gerçek şeklini TAHMİN eder. Trendyol'un
sayfalama/tarih/statü davranışı arayüze sızar ve sözleşme geldiğinde yanlış
soyutlamayı SÖKMEK, hiç soyutlamamış olmaktan pahalıya gelir. Sözleşme kanıtı
geldiğinde iki gerçek uygulamaya birden bakarak yazılmalıdır.

---

## 3. Sözleşme geldiğinde gereken KANIT

Faz açılmadan önce repoda bulunması gerekenler:

1. Resmî API dokümanı ya da makine-okunur sözleşme (OpenAPI/WSDL/Postman),
2. sipariş listeleme uç noktası: yol, auth şeması, sayfalama, **tarih ekseninin
   ne olduğu** (oluşturma mı, son güncelleme mi),
3. statü sözlüğü ve CargoFlow kanonik statülerine eşleme,
4. paket/kalem kimliği (`packageId` / `orderNumber` karşılıkları),
5. sandbox/test ortamı ve **gerçek mutasyon yapmadan** doğrulanabilir bir hesap,
6. rate-limit ve hata sözleşmesi (429/Retry-After karşılığı).

Bunlar olmadan yazılan her satır, P1/P2/P3'te ısrarla kaçınılan şeydir:
**ölçülmemiş iddia.**

## Kapsam DIŞI

- Gerçek pazaryeri çağrısı YOK, mutasyon YOK.
- `integration_credentials` allowlist migration'ı YAPILMADI: sağlayıcı
  eklenmeden migration üretmek, kullanılmayacak bir şemayı üretime taşımaktır.
