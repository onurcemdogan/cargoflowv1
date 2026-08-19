# Üretim izi CF-4088628726 — iki çelişkinin ölçümü

Üretim HEAD `9f1e802`. Sipariş `11519931308`, paket `4088628726`.
Dal: `fix/surat-production-trace-and-tenant-source`.

Bu belge **ölçüm kaydıdır**. Tahmin, çıkarım ve "muhtemelen" ifadesi
içermez; kanıtlanamayan şey KANITLANAMADI olarak yazılır.

Bu turda hiçbir canlı create yapılmadı, hiçbir taşıyıcı ağ çağrısı
kurulmadı, üretime hiçbir yazma yapılmadı.

---

## Çelişki B — `ACTUAL_WIRE_READY` vardı, denetçi her alanı `ABSENT` gösterdi

### Aday nedenler ve hangisinin ölçüldüğü

| # | Aday | Sonuç |
| - | ---- | ----- |
| A | Yakalanan yük kalıcılaştırılmadı | **ELENDİ** |
| B | Denetçi YANLIŞ aşamayı okudu | **DOĞRULANDI** |
| C | Serileştirme alanları düşürdü | **ELENDİ** |
| D | `FINAL` aşaması yükün üzerine yazdı | **ELENDİ** |

### Kanıt

`server/surat-trace-persistence-forensics-flow.test.mjs` üretim aşama
dizisini (9 aşama, dolu `ACTUAL_WIRE_READY`) birebir kurar, DB'ye yazar ve
geri okur:

- `TRACE-PERSIST-1` — yük ekleme + yeniden okuma sonrası AYNEN durur.
- `FORENSIC-1` — ham kalıcı kayıtta `data.gonderiRuntimeType === 'object'`
  iken, `REQUEST_READY` aşamasında `Gonderi` / `OdemeTipi` anahtarları
  YOKTUR. Kayıp yazma tarafında değil, OKUMA tarafındadır.
- `TRACE-PERSIST-2` — ayrıştırma istisnası tel yükünü silemez.
- `TRACE-PERSIST-4` — tek `traceId`, dokuz aşama.

Denetçi `REQUEST_READY` aşamasına bakıyor ve HAM anahtar arıyordu; yakalama
ise `ACTUAL_WIRE_READY` aşamasına `gonderiFieldTypes` / `safeValues`
biçiminde yazıyor. `REQUEST_READY` KARAR anıdır; tel değildir.

### Aynı turda bulunan ikinci kusur

`redactTraceValue`, sır benzeri sonek taşıyan HER anahtarı maskeliyordu ve
sır TAŞIMAYAN `sifrePresent` (bir boolean) `«REDACTED»` oluyordu. Güvenli
sonekler artık açıkça listelenir.

### Düzeltme

İzdüşüm `server/shipments/suratTraceProjection.ts` modülüne alındı; test,
denetçinin KULLANDIĞI kodu çalıştırır. Ayrı bir kopya olsaydı test yeşil,
denetçi kör kalırdı.

`STAGE_MISSING` ile `ABSENT` artık ayrıdır: ağa hiç çıkmamış bir deneme,
"alansız gönderildi" gibi okunamaz.

---

## Çelişki A — kanarya `****2622`, canlı iz `****0944`

### Ölçülebilen

`integration_credentials` üzerinde `(organization_id, provider)` TEKİL
indeksi vardır. Bu, tek organizasyon içinde iki Sürat satırı bulunmasını
engeller; dolayısıyla ayrışmanın kaynağı **satır seçimi olamaz**.

Her iki yol da aynı yükleyiciyi ve aynı önceliği kullanıyordu. Geriye
GİRDİNİN farklı olması kalır — yani farklı `organizationId`. Kanarya
organizasyonu `--name` ile çözer, canlı POST ise `request.auth`.

### Ölçülemeyen — ve uydurulmayan

Üretim veritabanına erişim olmadan iki tarafın HANGİ organizasyonu okuduğu
bu turda doğrulanamadı. Bu nedenle Çelişki A **"düzeltildi" ilan
EDİLMEMİŞTİR**.

### Yapılan

Ayrışma artık ampirik olarak karşılaştırılabilir:

- `loadActiveSuratIntegrationForOrganization` tek otoriter yükleyicidir;
  türetme onun İÇİNDE bir kez yapılır (kanarya ve canlı POST aynı fonksiyon).
- Yükleyici okuduğu kaydın kimliğini MASKELİ döner.
- Kanarya `CANARY_ORGANIZATION_ID` / `CANARY_INTEGRATION_ID` basar; aynı
  alanlar izin `ROUTING` aşamasına `tenantOrganizationIdMasked` /
  `tenantIntegrationIdMasked` olarak düşer ve denetçi bunları gösterir.
- Kimlik verilmediyse `UNKNOWN` görünür — boş dize DEĞİL; boş dize iki farklı
  bilinmeyeni eşit gösterirdi.
- `getIntegrationCredentialRecord` birden çok satırda FAIL CLOSED olur.
  Tekil indeks bunu bugün erişilemez kılar; indeks düşerse `rows[0]` sessizce
  YANLIŞ cariyi seçer ve açılan gönderi geri alınamaz.
- `credentialSource`, anlık görüntü çözülmediyse artık
  `tenant.surat.primary` DEMEZ (`UNRESOLVED_SNAPSHOT`). Boş parmak izini
  kiracının birincil hesabı diye etiketlemek, çözülmüş kimlik izlenimi verir.

### Bir sonraki tur için gereken tek gözlem

Aynı kiracı üzerinde kanarya çıktısındaki `CANARY_INTEGRATION_ID` ile yeni
bir izin `tenantIntegrationIdMasked` alanı yan yana konur:

- Eşitse → ayrışma kayıt seçiminde DEĞİLDİR; kalan tek yer deponun içeriğidir.
- Farklıysa → iki yol farklı organizasyonu okuyor; ayrışmanın yeri kanıtlanır.

Bu gözlem canlı create GEREKTİRMEZ; kanarya salt okunurdur.

---

## Bu turda değişmeyenler

- `SOAP_PRIMARY_ELIGIBLE = NO` (servis modu değiştirilmedi).
- Otomatik REST→SOAP geri düşüş YOK.
- Başarısız hiçbir gönderi yeniden oynatılmadı.
- Sipariş / gönderi / idempotency / etiket / finansal kanıt kaydı silinmedi.
