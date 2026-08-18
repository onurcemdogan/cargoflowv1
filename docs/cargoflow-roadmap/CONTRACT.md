# CargoFlow yol haritası — değişmezler

Kod ile çelişirse **kod ölçülür**; bu belge kanıtla güncellenir.

## Faz sırası ve kilit

`S1 → P1 → P2 → P3 → P4 → P5 → P6`

Bir faz yalnız öncekiler `passed` ise açılır. Tek istisna: **P4/P5/P6**
`blocked_external_contract` olduğunda sonraki faz açılabilir — dış sözleşme
eksikliği bizim çözebileceğimiz bir şey değildir ve tüm yol haritasını
durdurmamalıdır. Uygulanabilir bir faz bu gerekçeyle atlanamaz.

## Kanıt kuralları

- Çıkış kodu tek başına kanıt değildir; gate `requireOutput`/`forbidOutput`
  bildirmişse çıktı da doğrulanır.
- Uygulanmamış iş `NOT_IMPLEMENTED` gerekçesiyle **BLOCKED** kalır.
- Komut adları `package.json`'dan doğrulanır; uydurulmaz.
- Gate sonuçları cache'lenmez — her `continue` yeniden ölçer.

## Sürat finansal sözleşmesi (S1 bağlamı)

`whoPays` yok → `TRENDYOL_PAYS` → beklenen `3`; `=1` → `SELLER_PAYS` → `1`;
`null`/desteklenmeyen → `UNKNOWN` → **fail-closed**.

`OdemeTipi` (1=PESIN, 2=UCRET_ALICI), COD ve kimlik rolü **bağımsız**
eksenlerdir; biri diğerini türetmez. Kanonik sözleşmede `WhoPays`/`KimOder`
alanı yoktur — telde bulunmaması hata değildir.

Ağ sınırından hemen önce kimlik paritesi doğrulanır: çözücünün seçtiği hesap
ile telde giden hesap aynı parmak izini vermelidir. Aksi hâlde
`SURAT_CREDENTIAL_WIRE_MISMATCH` ile **ağ çağrısı yapılmaz**.

## Güvenlik

Gerçek taşıyıcı create yok · üretim yazma yok · üretim config değişikliği yok ·
baskı yok · geçmiş veri mutasyonu yok · operasyonel silme yok.
