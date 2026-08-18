# P3 — B4 barkod worker finalizasyonu denetimi

Dal: `feat/surat-barcode-worker-finalization` · taban: `dedcecb`

Kapsam (STATE): **uygun sipariş seçimi · kuyruk öncesi finansal ön kontrol ·
idempotency**.

> P1/P2 dersi iki yönlü: "zaten var" da "yok" da ÖLÇÜLMEDEN yazılmaz.
> Aşağıdaki her satır dosya/satır okunarak doğrulandı.

## Zaten VAR (ölçüldü)

| Konu | Kanıt |
| --- | --- |
| Otoriter finansal kapı | [suratFinancialGate.ts](../../server/shipments/suratFinancialGate.ts) — `serviceMode` dallarının HEPSİNİN ÜSTÜNDE (`index.mjs:3216`), ağa çıkmaz, DB'ye yazmaz |
| Fail-closed | kapı `ok:false` ise route DERHAL döner; taşıyıcı çağrısı YOK |
| Guarded mod listesi | `GUARDED_SURAT_SERVICE_MODES` — 6 mod; "legacy mod = bypass" OLUŞAMAZ |
| Uygun sipariş seçimi | [suratCreatePrintPlan.ts](../../src/utils/suratCreatePrintPlan.ts) — in-flight / taşıyıcı / veri / fit / desi ön kontrolleri, mutasyon ÖNCESİ |
| Seçim tekilleştirme | aynı sipariş iki kez seçilirse TEK etiket (`duplicateCount`) |
| Idempotency deposu | `shipment_operations` + `unique(organization_id, idempotency_key)` ([schema.ts:238](../../server/db/schema.ts)) |
| Atomik rezervasyon | `reserveShipmentCreateOperation` — insert-on-conflict; eşzamanlı iki create'te YALNIZ kazanan taşıyıcıya gider |
| Süreç içi kilit | `suratCreateLocks` — aynı anahtarda ikinci istek uçuşu PAYLAŞIR |
| Belirsiz sonuç koruması | `IN_PROGRESS`/`UNKNOWN` → blocked; `FAILED_SAFE` → açık yetkilendirme olmadan tekrar YOK |
| Create çağrı tavanı | `maxCreateCalls: 1` — otomatik deneme sınırlı |

Kısaca: **kuyruk öncesi finansal kapı ve idempotency ALTYAPISI mevcut.**
Eksik olan, aşağıdaki iki BAĞLANTI.

---

## AÇIK 1 — `requestFingerprint` yazılıyor, HİÇ OKUNMUYOR

**Ölçüm.** `buildSuratCreateOperationContext` bir `requestFingerprint` üretir
(`index.mjs:3584`) ve kayda yazar (`:3935`). Kaynakta bu alanın KARŞILAŞTIRILDIĞI
tek bir yer YOKTUR — `grep requestFingerprint` yalnız bu iki satırı verir.

Bu, P2'deki imlecin AYNI kusuru: **üretilen kanıt tüketilmiyor.**

**Neden önemli.** Idempotency anahtarı finansal/fiziksel semantiği TAŞIMAZ:

```
idempotencyKey = `SURAT:${tenantId}:${orderId}:CREATE`
```

`desi`, `desiSource`, `serviceMode`, `environment` yalnız fingerprint'tedir —
anahtarda DEĞİL. `executeIdempotentSuratCreate` ise ilk satırında:

```js
if (existing?.status === 'SUCCESS') {
  return buildPersistedSuratCreateResponse(existing, operation)
}
```

**Somut hata senaryosu.** Sipariş `desi=1` ile oluşturulur ve başarılı olur.
Operatör desiyi düzeltip (`desi=5`) tekrar çalıştırır. Anahtar AYNIDIR, kayıt
`SUCCESS`tir → eski `desi=1` etiketi başarı olarak GERİ OYNATILIR. Kullanıcı
düzeltmenin uygulandığını sanır; fatura yanlış desiden kesilir ve kimse
uyarılmaz.

Aynı mekanizma `serviceMode` ve `environment` değişiminde de sessiz kalır.

## AÇIK 2 — finansal fingerprint kayda HİÇ ULAŞMIYOR

**Ölçüm.** Kapı bir `financialFingerprint` üretir (billingParty,
expectedSuratWhoPays, credentialRole, odemeTipi, cod*, pazaryerimi,
marketplaceIdentitySource…). `grep financialFingerprint` sonucu: **yalnız
`suratFinancialGate.ts` içinde** geçiyor. Kapının kendi trace'i dışında hiçbir
tüketicisi yok — idempotency kaydına yazılmıyor, replay'de kıyaslanmıyor.

Yani bir gönderi `TRENDYOL_PAYS` semantiğiyle oluşturulup, sonradan
`SELLER_PAYS` semantiğiyle yapılan istek AYNI anahtarla gelirse eski sonuç
"başarılı" diye döner. **Yanlış cariye yazılan gönderi geri alınamaz** —
kapının kendi yorumundaki gerekçe tam olarak budur, ama replay yolu bu
korumanın DIŞINDADIR.

### Doğru davranış: FAIL-CLOSED, sessiz replay DEĞİL, ikinci create DE DEĞİL

Üç seçenek ölçüldü:

- **A) Fingerprint'i anahtara kat.** Semantik değişince YENİ anahtar → YENİ
  create. **REDDEDİLDİ:** aynı sipariş için ikinci fiziksel gönderi doğar —
  çift maliyet, geri alınamaz.
- **B) Sessiz replay (bugünkü).** **REDDEDİLDİ:** düzeltme uygulanmadığı hâlde
  uygulanmış görünür.
- **C) Kıyasla ve REDDET.** Anahtar aynı kalır; kayıtlı fingerprint ile gelen
  istek farklıysa ne replay ne create — ayrı bir hata koduyla durulur ve fark
  operatöre gösterilir. **SEÇİLDİ.**

C seçeneği mevcut sözleşmeyi BOZMAZ: fingerprint AYNI olduğunda bugünkü replay
davranışı bit-bit korunur.

## AÇIK 3 — plan finansal kapıyı kuyruk ÖNCESİ sormuyor

**Ölçüm.** `resolveSuratCreateAndPrintPlan` yedi predicate kullanır
(`isInFlight`, `isSuratOrder`, `resolveDataBlock`, `resolveFitBlock`,
`isPrinted`, `hasPrintableLabel`, `resolveDesiBlock`). Finansal kapıya karşılık
gelen bir predicate YOKTUR.

**Etki SINIRLI ve bu ÖNEMLİ:** sunucu kapısı fail-closed olduğu için finansal
olarak bloklu bir sipariş taşıyıcıya GİTMEZ. Yani bu bir para güvenliği açığı
DEĞİL, bir **kuyruk hijyeni** açığıdır: kesin reddedilecek sipariş yine de
kuyruğa alınır, create denemesi harcanır ve kullanıcı hatayı toplu işin
ORTASINDA görür. P3 kapsamı bunu açıkça "kuyruk öncesi ön kontrol" diye adlandırır.

---

## Kapsam DIŞI (bilerek)

- Gerçek taşıyıcı create YOK — tüm testler mock/hermetik.
- Üretim migration YOK: `shipment_operations` şeması DEĞİŞMEZ; fingerprint
  mevcut şifreli response kaydının içinde taşınır.
- Mevcut idempotency dış sözleşmesi (hata kodları, blocked mesajları) korunur;
  YALNIZ yeni mismatch kodu eklenir.

---

# BAĞLAMA — YAPILDI

Karar katmanı: [suratIdempotencySemantics.ts](../../server/shipments/suratIdempotencySemantics.ts)
· testler: [surat-idempotency-semantics-flow.test.mjs](../../server/surat-idempotency-semantics-flow.test.mjs)
(16/16).

| Açık | Çözüm | Test |
| --- | --- | --- |
| 1 — fingerprint okunmuyor | her iki fingerprint replay dallarından ÖNCE kıyaslanır | `IDS-2`, `IDS-10` |
| 2 — finansal fingerprint kayda ulaşmıyor | `operation` bağlamında taşınır, kayda yazılır | `IDS-3`, `IDS-11` |
| 3 — kuyruk öncesi eleme yok | plana `resolveFinancialBlock` predicate'i eklendi ve App.tsx wire etti | `IDS-14`, `IDS-15` |

## Korunan sözleşmeler

- **Anahtar DEĞİŞMEDİ** (`IDS-13`): semantik anahtara katılsaydı aynı sipariş
  için ikinci fiziksel gönderi doğardı.
- **Eski kayıtlar bloklanmaz** (`IDS-6`, `IDS-7`): yalnız İKİ tarafta da bulunan
  eksen kıyaslanır. "Kanıt yokluğu" ≠ "farklı".
- **Aynı semantikte davranış bit-bit aynı** (`IDS-1`).
- **Sunucu kapısı hâlâ otoriter** (`IDS-16`): istemci elemesi kapının YERİNE
  GEÇMEZ; para güvenliği fail-closed sunucu kapısına bağlı KALIR.
- **Migration YOK**: fingerprint mevcut şifreli `payload` kaydının içinde
  taşınır (`recordToColumns` tüm record'u saklar).

## Mimari not — neden ayrı bir fingerprint yüzeyi

Parmak izi `resolveSuratFinancialFingerprint` ile alınır,
`evaluateSuratFinancialGate` DOĞRUDAN çağrılmaz. Sebep ölçüldü: sıfır-bypass
testi otoriter kapıyı ÇAĞRI YERİNDEN bulur (`indexOf`), ve dosyada daha ERKEN
duran ikinci bir `evaluateSuratFinancialGate({` çağrısı o değişmezi gölgeliyordu.
Ayrı isim, "burası karar uygulamaz" bilgisini hem koda hem teste taşır.

## Gate

`P3_B4_BARCODE_WORKER` artık `notImplemented` DEĞİL:

| Gate | Test |
| --- | --- |
| `P3_IDEMPOTENCY_SEMANTICS` | `surat-idempotency-semantics-flow.test.mjs` |
| `P3_ZERO_BYPASS` | `surat-zero-bypass-gate-flow.test.mjs` |
| `P3_FINANCIAL_GUARD` | `surat-financial-guard-flow.test.mjs` |
| `P3_CREATE_LIFECYCLE` | `surat-lifecycle.test.mjs` |
| `P3_ORCHESTRATOR` | `surat-one-click-orchestrator-flow.test.mjs` |

Ardından ortak kalite kapıları (`P3_SURAT`, `P3_UI`, `P3_BUILD`, `P3_LINT`).
