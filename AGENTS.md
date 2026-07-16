# CargoFlow çalışma notları

## Proje amacı

CargoFlow, Türk e-ticaret satıcıları için siparişleri, kargo barkodlarını, etiketleri ve yazdırma akışını tek panelden yönetmeyi hedefleyen bir kargo operasyon uygulamasıdır. İlk canlı entegrasyon odağı Trendyol siparişleri ve Sürat Kargo ortak barkod akışıdır.

## Mevcut repo durumu

Bu çalışma alanı bir MVP/local geliştirme reposudur:

- Frontend: React + TypeScript + Vite
- Backend/proxy: Node.js + Express (`server/index.mjs`)
- Yerel ayarlar: entegrasyon anahtarları Windows kullanıcı klasöründe şifreli saklanır
- Etiket: HTML önizleme, ZPL indirme ve Chrome üzerinden temiz yazdırma akışı
- Testler: Node test runner ile server/akış testleri

Not: Ürün vizyonunda PostgreSQL, Row-Level Security ve Google Cloud Run var; ancak bu repoda görünen mevcut kod local MVP ağırlıklıdır. Bu altyapılar için dosya/konfigürasyon görmeden varsayım yapma.

## Klasör yapısı

- `src/App.tsx`: ana uygulama state’i ve sayfa yönlendirme mantığı
- `src/pages/`: Dashboard, Siparişler, Kargo İşlemleri, Entegrasyonlar, Debug ve yazıcı ekranları
- `src/components/`: tablo, drawer, modal, etiket önizleme ve barkod/QR bileşenleri
- `src/services/`: sipariş iş akışı, entegrasyon ayarları, debug ve audit servisleri
- `src/providers/marketplace/TrendyolProvider.ts`: Trendyol sipariş/ürün sağlayıcısı
- `src/providers/shipping/SuratKargoProvider.ts`: frontend’in Sürat gönderi/takip provider’ı
- `src/providers/labels/ZebraZplLabelProvider.ts`: ZPL etiket üretimi
- `src/providers/printing/`: yazdırma/indirme provider’ları
- `src/utils/`: etiket verisi, Sürat doğrulama, ZPL analizi, desi, tarih/format yardımcıları
- `server/index.mjs`: Express API proxy; Trendyol ve Sürat’e gerçek istek atan ana backend dosyası
- `server/*-flow.test.mjs`: Sürat, label, print, dashboard, persistence ve local config akış testleri

## Komutlar

- Kurulum: `npm install`
- Local frontend + backend: `npm run dev`
- Aynı Wi-Fi’den erişilebilir mod: `npm run dev:host`
- Sadece backend: `npm run dev:api`
- Sadece frontend: `npm run dev:web`
- Build: `npm run build`
- Lint: `npm run lint`
- Kritik akış testleri: `npm run test:surat`

Local adresler:

- Frontend: `http://127.0.0.1:5173/`
- Backend health: `http://127.0.0.1:8787/api/health`
- Vite proxy: `/api` isteklerini `http://127.0.0.1:8787` adresine yönlendirir

## Sürat Kargo entegrasyonu

Canlı Sürat API’ye gerçek istek atan ana dosya `server/index.mjs` dosyasıdır.

Önemli fonksiyonlar:

- `createSuratShipment`: Sürat gönderi oluşturma endpoint’inin giriş noktası
- `createSuratRegisteredCommonBarcode`: önce Sürat ön kayıt, sonra ortak barkod ve operasyonel barkod doğrulama akışı
- `createSuratLegacyRestJson`: `GonderiyiKargoyaGonder` REST çağrısı
- `createSuratCommonBarcodeSoap`: `OrtakBarkodOlustur` SOAP çağrısı
- `resolveSuratOperationalBarcode`: teknik ZPL geldiyse gerçek T.No/numeric barkodu bulmak için ek sorgu
- `callSuratKargoBarkodu`: `KargoBarkodu` SOAP çağrısı
- `trackShipmentSoap` / `trackShipmentRest`: Sürat takip sorguları

Frontend tarafında:

- `src/providers/shipping/SuratKargoProvider.ts`: backend’den dönen Sürat sonucunu sipariş shipment objesine taşır
- `src/utils/suratVerification.ts`: T.No, numeric ana barkod, Web barkod ve yazdırılabilirlik kontrolünü yapar
- `src/utils/suratZplAnalysis.ts`: ZPL içinden Web barkod/numeric barkod/T.No analizi yapar
- `src/providers/labels/ZebraZplLabelProvider.ts`: yalnız doğrulanmış Sürat verisiyle ZPL üretmelidir
- `src/utils/printableLabel.ts` ve `src/utils/browserLabelPrint.ts`: Chrome yazdırma için temiz HTML etiket üretir

## Barkod güvenlik kuralları

- `Web...` ile başlayan barkod final operasyonel Sürat barkodu değildir.
- Trendyol `cargoTrackingNumber` final Sürat barkodu değildir.
- Etiket basılabilir sayılması için Sürat’ten doğrulanmış T.No/KargoTakipNo ve numeric ana barkod birlikte gelmelidir.
- Sürat API başarılı ve doğrulanmış veri dönmeden mock/sahte barkod üretme veya yazdırma akışı açma.
- API hata dönerse kullanıcıya net hata göster; sessiz fallback kullanma.
- Canlı Sürat API’ye gerçek gönderi oluşturma isteği atmadan önce kullanıcıdan açık onay al.

## Test beklentisi

Sürat/barkod/etiket/yazdırma alanında değişiklik yaptıktan sonra en az şu komutları çalıştır:

```bash
npm run lint
npm run build
npm run test:surat
```

Canlı API testi gerekiyorsa önce kullanıcıdan izin iste. İzin yoksa mock/sandbox testleriyle sınırlı kal.
