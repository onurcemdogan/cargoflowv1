# Çizgi/kutu landmark raporu — kök neden analizi

## 0. Sonuç (özet)

Ekrandaki kutu ve çizgiler **renderer'dan gelmiyor**. Hepsi, render'a girdi
olarak verilen **sentetik fixture'ın kendi `^GB` komutlarından** geliyor.

Sentetik fixture'daki 7 `^GB` komutundan **6'sının gerçek Sürat şablonunda
bulunduğuna dair hiçbir kanıt yok** — bu satırları DuruSoft fotoğrafına
bakarak ben uydurdum. Bu, kullanıcının koyduğu
"DuruSoft görseline bakarak koordinat uydurma yok" kuralının ihlalidir.

Karar kuralı sonucu: **B şıkkı** — sentetik fixture yanlış referanstır.

## 1. Gerçek şablon repoda var mı?

**HAYIR.**

- Repodaki (git-tracked) **tek** `.zpl` dosyası
  `server/fixtures/synthetic-surat-reference.zpl` — onu da bir önceki turda
  ben oluşturdum.
- Gerçek etiket tanımlayıcılarını (`21012920014311`, `01254596670`,
  `7270035184060553`) içeren iki dosya var, ikisi de **test fixture'ı**:
  `server/print-zpl-persistence-flow.test.mjs` ve
  `server/surat-official-zpl-product-line-flow.test.mjs`.
  Bunların alan değerleri `GONDERICI AD`, `ALICI AD`, `IL / ILCE` gibi
  yer tutuculardır → bunlar da **yeniden kurgulanmış** şablonlardır,
  yakalanmış gerçek `technicalZpl` değildir.

Yani "gerçek Sürat ZPL örneği" repoda **mevcut değil**. Bu yüzden
istenen 3. adım (aynı maskelenmiş gerçek ZPL'yi iki motorda render etmek)
**yapılamadı**.

## 2. `^GB` envanteri

### Sentetik fixture (`synthetic-surat-reference.zpl`) — 7 komut

| # | rawCommand | x | y | w | h | t | tip | kanıt |
|---|---|---|---|---|---|---|---|---|
| 1 | `^GB760,770,3` | 20 | 15 | 760 | 770 | 3 | rectangle | **dolaylı kanıt var** |
| 2 | `^GB0,770,2` | 65 | 15 | 0 | 770 | 2 | vertical | **KANIT YOK** |
| 3 | `^GB760,0,2` | 20 | 110 | 760 | 0 | 2 | horizontal | **KANIT YOK** |
| 4 | `^GB760,0,2` | 20 | 285 | 760 | 0 | 2 | horizontal | **KANIT YOK** |
| 5 | `^GB760,0,2` | 20 | 455 | 760 | 0 | 2 | horizontal | **KANIT YOK** |
| 6 | `^GB760,0,2` | 20 | 545 | 760 | 0 | 2 | horizontal | **KANIT YOK** |
| 7 | `^GB760,0,2` | 20 | 700 | 760 | 0 | 2 | horizontal | **KANIT YOK** |

### Gerçek şablon — 0 komut (dosya yok, karşılaştırma yapılamadı)

### Yalnız sentetik fixture'da bulunanlar
7 komutun **tamamı** (gerçek şablon elde olmadığı için).

### Yalnız gerçek ZPL'de bulunanlar
Bilinmiyor.

## 3. 1 numaralı çerçevenin dolaylı kanıtı

`^GB760,770,3` (dış çerçeve) tamamen dayanaksız değil: canlı production
regresyonunda gerçek Sürat `technicalZpl`'inde **etiketin büyük bölümünü
kaplayan bir `^GB` çerçevesi** bulunduğu davranışla kanıtlanmıştı
(`contentBottom ≈ 785` → footer 0 → tüm baskılar bloklandı). Bu, çerçevenin
**varlığının** kanıtıdır; **koordinatlarının** (20,15,760,770,3) kanıtı
değildir.

## 4. Uydurulan satırların gerçek kaynağı

Sentetik fixture'ın çizgi yapısı, **CargoFlow'un KENDİ ürettiği** ZPL
şablonuyla birebir aynı desendedir —
`src/providers/labels/ZebraZplLabelProvider.ts`:

```
^FO0,0^GB799,799,1^FS                    → dış çerçeve
^FO44,0^GB1,799,1^FS                     → dikey ray çizgisi
^FO44,Y_HEADER_END^GB755,1,1^FS          → başlık ayırıcı
^FO44,Y_BARCODE_END^GB755,1,1^FS         → barkod ayırıcı
^FO44,Y_RECIPIENT_END^GB755,1,1^FS       → alıcı ayırıcı
^FO44,Y_SUMMARY_END^GB755,1,1^FS         → özet ayırıcı
^FO44,Y_ROUTING_END^GB755,1,1^FS         → rota ayırıcı
```

Yani "gerçek Sürat şablonu" diye sunduğum fixture, aslında **CargoFlow'un
kendi etiket tasarımının** kopyasıdır. Sürat'in şablonu değildir.

## 5. DuruSoft ekran görüntüsündeki çizgiler

Fotoğraf bir **ekran fotoğrafıdır**: moiré, perspektif ve düşük kontrast var.
Görünmeyen çizgi **yok kabul edilmemiştir**.

| Landmark | Durum |
|---|---|
| Dış sınır (dört taraf) | **KESİN VAR** |
| Sol dikey ray ayırıcı çizgisi | **KESİN VAR** |
| Başlık kutusu alt çizgisi (TEL satırının altı) | **KESİN VAR** |
| Barkod altı ayırıcı (alıcı adının üstü) | **KESİN VAR** |
| Alıcı/adres kutusu alt çizgisi (OdemeTipi üstü) | **KESİN VAR** |
| Ödeme/desi alt ayırıcısı (Parca Adedi üstü) | **KESİN VAR** |
| Ürün footer ÜST çizgisi | **BELİRSİZ** |
| Ürün footer ALT çizgisi | **BELİRSİZ** |
| Alıcı kutusu dört taraftan kapalı mı | **BELİRSİZ** (sol/sağ kenarlar dış çerçeve olabilir) |
| Ödeme/desi alanı tam kutu mu, yalnız yatay ayırıcı mı | **BELİRSİZ** (dikey ayraç görünmüyor ama moiré) |
| QR/rota bölümünü çevreleyen ayrı kutu | **BELİRSİZ** (ayrı kutu görünmüyor) |
| Sol rayın çizili olduğu Y aralığı | **BELİRSİZ** (uçların nerede bittiği okunamıyor) |

**Kritik uyarı:** fotoğraftaki yatay ayırıcı sayısının benim fixture'ımdaki
sayıyla yakın çıkması **kanıt değildir** — ikisi de aynı görselden türedi,
gerçek ZPL'den değil.

## 6. Ekrandaki "tuhaf" farkların kaynağı

Bir önceki turda paylaştığım zebrash görselinin DuruSoft çıktısından farklı
görünmesinin nedeni **motor değil, fixture koordinatlarıdır**:

- alıcı/adres bölümünde büyük boş alan → fixture'da adres `y=320`'de bitiyor
  ama TEL satırı `y=448`'e konmuş (uydurma koordinat)
- bölüm yükseklikleri (110/285/455/545/700) → uydurma
- dikey ray çizgisinin konumu (`x=65`) → uydurma

zebrash, girdideki `^GB` komutlarını **birebir** çiziyor; fazladan çizgi
üretmiyor, eksiltmiyor. Bu, Labelary karşılaştırmasıyla da doğrulandı
(çizgi konumları ≤1 dot).

## 7. Ürün satırı

Ürün satırı hâlâ yalnız final `^PQ`/`^XZ` öncesine **metin** olarak
ekleniyor:

```
^FO74,721^A0N,18,16^FB713,1,0,L,0^FD1 x ... (Renk: Krem, Beden: 40) [6496]^FS
```

Footer için **yeni `^GB` kutusu, alt çizgi veya yan çerçeve eklenmiyor**
(`augmentedSuratZpl` çıktısında `^GB` yok). Kaynak `technicalZpl`'deki
çizgiler korunuyor, silinmiyor.

## 8. Karar

- **B şıkkı**: sentetik fixture yanlış referanstır ve gerçek şablona göre
  düzeltilmelidir.
- Sentetik çizgiler **production koduna taşınmadı** — fixture yalnız test
  altındadır; production `technicalZpl`'i Sürat'ten geldiği gibi kullanır.
- `technicalZpl`'den `^GB` komutu **silinmedi** ve silinmeyecek.
- Endpoint/UI çalışmasına **devam edilmemelidir**: görsel eşdeğerlik iddiası
  ancak gerçek şablonla doğrulanabilir.

## 9. Devam etmek için gereken

`server/fixtures/real-template-masked.zpl` yolunda **gerçek** Sürat
`technicalZpl`'i gerekiyor. Alma yolları:

1. Siparişler ekranı → **ZPL İndir** (gerçek bir READY/PRINTED gönderi için)
2. `npm run surat:zpl:diagnose` teşhis CLI çıktısı
3. `shipments.carrier_payload_encrypted` içindeki `BarcodeRaw`

Maskeleme kuralı: **yalnız `^FD` alan değerleri** aynı uzunlukta sentetik
değerlerle değiştirilecek; `^FO/^FT/^GB/^BY/^BC/^BX/^BQ` komutları ve tüm
koordinatlar **değiştirilmeyecek**. Maskelenmiş dosya bu haliyle Labelary
karşılaştırmasına girebilir.
