# Sürat finalization — runbook

## Yeni oturum akışı

1. `docs/surat-finalization/CONTRACT.md` oku.
2. Durumu sor:

```bash
node scripts/surat-finalize/orchestrator.mjs status
```

3. `FAILED_GATE` varsa **yalnız o gate'in kök nedenini** düzelt.
4. Gate'leri tekrar koş:

```bash
node scripts/surat-finalize/orchestrator.mjs continue
```

5. Faz PASS olana kadar 3–4 arası tekrarla.
6. Faz **atlama yok**. `force`/`skip`/`reset` komutu yoktur.
7. **Gerçek taşıyıcı create'i asla çalıştırma.**

Rapor: `node scripts/surat-finalize/orchestrator.mjs report`
Çıktılar: `.var/surat-finalization/latest-report.{json,md}` (git dışı).

## Kirli worktree korunur

Faz 5C.2 / 5C.2.1 çalışması commit edilmemiş olabilir. Şunları **çalıştırma**:

```
git reset · git reset --hard · git checkout . · git restore . · git clean · git stash
```

Kirli worktree içeriği doğrunun kaynağıdır; yeniden yazılmaz.

## Fazlar

| Faz | Kapsam |
| --- | --- |
| A | Finansal kapı — surat-flow 3/3, sıfır bypass, full/build/lint |
| B | Taşıyıcı yanıt sınıflandırması (016/039, iş mesajı korunur) |
| C | Trace v2 runtime — tek correlationId, expected vs wire, izolasyon |
| D | COD kimlik/politika arayüzü, Canlı Debug, legacy debug temizliği |
| E | Üretim hazırlığı — read-only doğrulama, NETWORK=0 kuru koşu |

Faz E bittiğinde bile `liveCreateAllowed=false` kalır. Gerçek canlı create
**insan kararıdır**.

## Yeni Claude oturumu için hazır istem

> Read docs/surat-finalization/CONTRACT.md and RUNBOOK.md.
> Run the Sürat finalization status command.
> Work only on CURRENT_PHASE / FAILED_GATE.
> Do not skip phases.
> After the minimum evidenced fix, run continue.
> Repeat until that phase passes.
> Never perform a real carrier create.
