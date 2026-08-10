// CLI: sipariş retention DURUM KONTROLÜ. VARSAYILAN SALT OKUNUR — DB'YE
// HİÇBİR YAZMA YAPMAZ. Production'a ilk deploy sonrası, otomatik yazma
// açılmadan ÖNCE sayıları görmek içindir.
//
//   npm run orders:retention:check
//
// Çıktı PII TAŞIMAZ: yalnız sayımlar ve yaş (gün) bilgisi.
// Aynı uygunluk helper'ları otomatik housekeeping tarafından da kullanılır
// (iki ayrı iş kuralı implementasyonu YOK).
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { inspectRetention, resolveRetentionPolicy } from './orderRetention.ts'

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error(
      'DATABASE_URL tanımlı değil. Retention kontrolü DB gerektirir.',
    )
    process.exitCode = 1
    return
  }
  const policy = resolveRetentionPolicy()
  const now = new Date()
  const db = getDb()
  const counts = await inspectRetention(db as never, policy, now)

  const report = {
    mode: 'read-only',
    timestamp: now.toISOString(),
    policy: {
      archiveAfterDays: policy.archiveAfterDays,
      purgeAfterDays: policy.purgeAfterDays,
      archiveBatchSize: policy.archiveBatchSize,
      purgeBatchSize: policy.purgeBatchSize,
      baselineBatchSize: policy.baselineBatchSize,
      // Otomatik yazma etkin mi? Bu komut bayraktan BAĞIMSIZ, salt okunurdur.
      housekeepingEnabled: policy.housekeepingEnabled,
      intervalMs: policy.intervalMs,
    },
    scanned: counts.scanned,
    // Retention saati OLMAYAN tarihsel etiket-aşamalı kayıtlar: ilk yazma
    // turunda bunlara baseline (şimdi) yazılacak, 4 gün SONRA arşiv adayı
    // olacaklar. Eski tarih UYDURULMAZ.
    baselineEligible: counts.baselineEligible,
    archiveEligible: counts.archiveEligible,
    purgeEligible: counts.purgeEligible,
    // Aktivite damgası olmayan etiket-aşamalı ESKİ kayıtlar. Bunlar otomatik
    // arşive GİRMEZ; kör "eski olmalı" çıkarımı YAPILMAZ.
    nullActivityBacklog: counts.nullActivityBacklog,
    oldestArchiveCandidateAgeDays: counts.oldestArchiveCandidateAgeDays,
    oldestPurgeCandidateAgeDays: counts.oldestPurgeCandidateAgeDays,
  }
  console.log(JSON.stringify(report, null, 2))
}

main()
  .catch((error) => {
    console.error('retention kontrolü başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
