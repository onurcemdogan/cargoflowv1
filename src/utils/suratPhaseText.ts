// Tek-buton akışının AŞAMA METNİ (yalnız sunum).
// Yüzde UYDURULMAZ: orchestrator'dan gelen gerçek completed/total kullanılır.
export interface SuratCreatePrintProgress {
  phase: 'preflight' | 'create' | 'prepare' | 'print' | 'done'
  completed: number
  total: number
}

export function resolveSuratPhaseText(
  running: boolean,
  progress?: SuratCreatePrintProgress,
): string {
  if (!running) return ''
  if (!progress) return 'Ön kontrol yapılıyor…'
  if (progress.phase === 'preflight') return 'Ön kontrol yapılıyor…'
  if (progress.phase === 'create')
    return `Kargo etiketleri oluşturuluyor: ${progress.completed}/${progress.total}`
  if (progress.phase === 'prepare')
    return `Etiketler hazırlanıyor: ${progress.completed}/${progress.total}`
  if (progress.phase === 'print') return 'Yazdırma bekleniyor…'
  return 'Sonuçlar işleniyor…'
}
