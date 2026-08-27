# Adres Sunumu — Kodsuz Özelleştirme

## Önceki turun eksiği

Önceki rapor "adres puntosu düzenlenemez" diyordu. Bu, istenen kodsuz
şablon davranışını karşılamıyordu.

Kök varsayım şuydu: *adresi taşıyıcı basar, biz dokunamayız.* Bu yalnız
**ham** modda doğrudur.

## İki render modu

| Mod | Adres kimin? | Kiracı ne yapabilir |
| --- | --- | --- |
| `RAW_SURAT_FALLBACK` | Taşıyıcı | Hiçbir şey — biçim **aynen** korunur |
| `COMPOSED` (varsayılan) | Composer bandı bizim | Punto, kalınlık, satır aralığı, satır sınırı, hizalama, görünürlük |

`COMPOSED` modda taşıyıcının adres `^FD` gövdesi **boşaltılır** (komut yapısı
yerinde kalır → `deletions = 0`) ve adres bizim ayarlarımızla yeniden basılır.
Ham ZPL artefaktı **hiçbir koşulda** değişmez (ADDR-8).

## Ayarlanabilir özellikler

`visible`, `fontSize` (12–48 dot), `bold`, `lineHeight` (1–2), `maxLines`
(1–6), `wrap`, `width`, `align` (sola/ortala/sağa).

Girdi güvenli aralığa **kısılır**, reddedilmez (ADDR-10): absürt bir punto
sessizce kabul edilip etiketi bozmaz, sınıra çekilir.

## Güvenlik — neden geometri zorunlu

Adres, etiketin en dar bandındadır. Gerçek üretim etiketinden ölçüldü:

```
adres satırları        417 … 458
sonraki taşıyıcı içeriği   476
kullanılabilir bant    400 … 470  (70 dot)
```

Puntoyu körlemesine büyütmek adresi barkod/DataMatrix/rota alanlarının
**üzerine** bindirir ve etiketi **taranamaz** yapar.

`resolveAddressBlockLayout` kararı geometriye bağlar:

1. Metin kelime sınırında sarılır (kırpma yok).
2. Satır sayısı `maxLines`'ı aşarsa **reddedilir**.
3. Yükseklik banda sığmazsa **reddedilir**.
4. Kutu korunan alanlarla kesişirse **reddedilir**.

Reddedilen yapılandırma **sessizce küçültülmez ve kırpılmaz**; düzenleyicide
Türkçe bir hata gösterilir ("Bu boyutta adres etikete sığmıyor; puntoyu,
satır sayısını veya satır aralığını azalt") ve şablon üretime alınmaz.

## Düzenleyici

"Teslimat Adresi" bölümü: göster/gizle, punto, kalın, satır aralığı, satır
sayısı, hizalama — ve **anında** doğrulama satırı. Sığan yapılandırmada kaç
satır/kaç dot kullanıldığı, sığmayanda hata gösterilir.

## Kanıt

`server/label-address-styling-flow.test.mjs`:

| Test | Ne kanıtlar |
| --- | --- |
| ADDR-1 | Varsayılan bugünkü çıktıyla aynı (16 dot, sola) |
| ADDR-2 | Büyük punto çıktıyı **gerçekten** değiştirir |
| ADDR-3 | Kalın = +1 dot ikinci vuruş; yeni font yüklenmez |
| ADDR-4 | Uzun adres kelime sınırında sarar, kelime kaybolmaz |
| ADDR-5 | Sığmayan yapılandırma üretime alınmadan reddedilir |
| ADDR-6 | Adres barkod/korunan alanların üzerine binemez |
| ADDR-7 | Sunum değişikliği taşıyıcı çağrısı üretmez (motor saf) |
| ADDR-8 | Ham Sürat artefaktı bayt bayt değişmez |
| ADDR-9 | Kiracı A stili kiracı B etiketini etkilemez (motor durumsuz) |
| ADDR-10 | Absürt girdi güvenli aralığa kısılır |

Düzenleyici tarafı: `src/test/labelTemplateEditor.dom.test.tsx`
HIKAYE-4 / HIKAYE-4b.
