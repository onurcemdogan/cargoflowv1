// YEREL ORTAM YÜKLEYİCİ — SUNUCU VE OPERATÖR ARAÇLARI İÇİN TEK YOL.
//
// ═══ ÖLÇÜLEN PARİTE AÇIĞI ════════════════════════════════════════════════
// `server/index.mjs` açılışta `.env` dosyasını yüklüyordu; operatör CLI'ları
// YÜKLEMİYORDU. Sonuç: üretimde `npm run auto-label:worker:preflight`
//     ENV_DATABASE_URL   MISSING
//     ENV_ORDER_DATA_KEY MISSING
// yazardı — üretim sunucusu AYNI anahtarları sorunsuz okurken.
//
// Bu YANLIŞ ALARM en kötü anda gelir: worker'ı açmadan önce çalıştırılan
// teşhis aracı, sağlıklı bir sistemi bozuk gösterir ve operatörü yanlış
// yöne sevk eder. Teşhis aracı, ölçtüğü sistemle AYNI ortamı görmelidir.
//
// ═══ DAVRANIŞ AYNEN KORUNUR ══════════════════════════════════════════════
// Zaten tanımlı bir değişken ASLA EZİLMEZ (`process.env[key] != null`
// kontrolü). Yani PM2/systemd ile verilen gerçek üretim değerleri
// dosyadakinin ÖNÜNDEDİR — mevcut sunucu davranışının birebir aynısı.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `.env` dosyasını okur ve YALNIZ tanımsız anahtarları doldurur.
 *
 * Dosya yoksa sessizce geçer: `.env` opsiyoneldir ve üretimde ortam
 * değişkenleri süreç yöneticisinden de gelebilir.
 */
export function loadLocalEnvFile(path: string): void {
  try {
    if (!existsSync(path)) return
    const content = readFileSync(path, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex <= 0) continue
      const key = trimmed.slice(0, separatorIndex).trim()
      const rawValue = trimmed.slice(separatorIndex + 1).trim()
      // TANIMLI DEĞER EZİLMEZ — süreç yöneticisi dosyadan ÖNCELİKLİDİR.
      if (!key || process.env[key] != null) continue
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // `.env` opsiyoneldir; yoksa mevcut `process.env` kullanılmaya devam eder.
  }
}

/** Depo kökündeki `.env` — sunucunun yüklediği DOSYANIN AYNISI. */
export function loadRepositoryEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  loadLocalEnvFile(join(here, '..', '..', '.env'))
}
