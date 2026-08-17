# Sürat finansal sözleşmesi — kanıtlanmış kurallar

Bu belge sohbet hafızasından bağımsızdır. Kod ile çelişirse **kod ölçülür**,
belge kanıtla güncellenir; belge gerekçe göstermeden gevşetilmez.

## Trendyol fatura tarafı

`rawOrder.whoPays` **kendi özelliği** olarak:

| Durum | Sonuç |
| --- | --- |
| var ve `1` / `"1"` | `SELLER_PAYS` |
| **yok (absent)** | `TRENDYOL_PAYS` |
| `null` / desteklenmeyen | `UNKNOWN` → **FAIL CLOSED** |

`ABSENT != NULL`. Bu ayrım `Object.prototype.hasOwnProperty.call` ile korunur.
`raw.whoPays ?? …`, `if (!raw.whoPays)`, `raw.whoPays || …` gibi kalıplar bu
ayrımı yok ettiği için **yasaktır**.

Trendyol'un `whoPays=3` değeri, Sürat `getCargo` yanıtındaki `whoPays=3` ile
**aynı enum değildir**; birbirine çevrilmez.

## Beklenen Sürat semantiği

| BillingParty | expectedSuratWhoPays |
| --- | --- |
| `TRENDYOL_PAYS` | `3` |
| `SELLER_PAYS` | `1` |
| `UNKNOWN` | `null` (create yok) |

## Ödeme tipi — fatura tarafından bağımsız

`OdemeTipi=1` → `PESIN` · `OdemeTipi=2` → `UCRET_ALICI`

```
OdemeTipi != WhoPays
OdemeTipi != BillingParty
OdemeTipi != COD
```

## Kapıda ödeme (COD)

Bağımsız eksendir. `KapidanOdemeTahsilatTipi`: `1=NAKIT`, `2=POS`.

Kimlik rolleri: `PRIMARY_MARKETPLACE` · `SELLER_PAYS` · `COD`
Politikalar: `DEDICATED_COD` · `SELLER_PAYS` · `PRIMARY`

**Sessiz fallback yoktur.** "Boşsa satıcı öder kimliği kullanılır" gibi örtük
davranış kaldırılmıştır; eksik kimlik açık hata üretir.

## Pazaryeri bağlamı

`Pazaryerimi=1` · `EntegrasyonFirmasi='Trendyol'`

`OzelKargoTakipNo` **sağlayıcı kaynaklı** olmak zorundadır
(`trackingSource === 'cargoTrackingNumber'`). İç referans (packageId,
orderNumber, kendi barkodumuz) ikame edilemez.

## Ana güvenlik değişmezi

UNKNOWN / eksik / tutarsız / belirsiz finansal bağlamda:

```
PRE_FLIGHT = BLOCKED  →  CARRIER_CREATE_CALLED = false  →  NETWORK_CALL = 0
```

Bunu hiçbir yol atlayamaz: single · bulk · retry · background · worker · CLI ·
legacy serviceMode · experimental serviceMode.

Kapı, `serviceMode` dallarının **üstündedir**; altında değil.

## Wire ile semantiğin ayrımı

Kanonik istek sözleşmesinde `WhoPays`/`KimOder` alanı **yoktur**. Bu yüzden
aşağıdaki üçlü **tutarlıdır ve doğrudur**:

```
expectedSuratWhoPays = 3
wireWhoPaysPresent   = false
wireWhoPaysReason    = CONTRACT_HAS_NO_WHO_PAYS_FIELD
```

Hayali `WhoPays`/`KimOder` alanı isteğe **enjekte edilmez**.
