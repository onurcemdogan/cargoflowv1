// SUNUCU WINDOWS HAM TAŞIMASI.
//
// Taşıma YALNIZ hazırlanmış baytları alır. İçinde pazaryeri/taşıyıcı iş
// kuralı, ürün çözümleme, gönderi oluşturma ya da HTML üretimi YOKTUR.
//
// ═══ DOĞRU ANLAM SEVİYESİ ════════════════════════════════════════════════
//
// Başarı = "iş işletim sistemi/yazıcı kuyruğuna KABUL EDİLDİ".
// Başarı ≠ "kâğıt fiziksel olarak yazıcıdan çıktı". Bu ikisini eşitlemek,
// sistemin bilmediği bir şeyi iddia etmek olurdu.
//
// ═══ SESSİZ BAŞARI KAPATILDI ═════════════════════════════════════════════
//
// ÖLÇÜLDÜ: yazıcı adı geçersizken PowerShell stderr'e .NET istisnası
// yazıyor ama EXIT 0 dönüyordu; sunucu bunu başarı sayıp uydurma bir UUID'yi
// iş kimliği olarak döndürüyordu. Artık TEK geçerli başarı kanıtı sıfır
// çıkış kodu VE spooler'ın verdiği SAYISAL iş kimliğidir.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Kapalı sözlük — ham stderr operatöre TAŞINMAZ. */
export const RAW_PRINT_FAILURES = [
  'PRINTER_REJECTED',
  'PRINT_COMMAND_FAILED',
  'PRINT_COMMAND_TIMEOUT',
  'NO_PRINT_JOB_ID',
  'RUNTIME_NOT_SUPPORTED',
] as const
export type RawPrintFailure = (typeof RAW_PRINT_FAILURES)[number]

export interface RawPrintSubmission {
  readonly printerName: string
  readonly documentName: string
  /** SUNUCUDA ÇÖZÜLMÜŞ baytlar. İstemci metni BURAYA GİREMEZ. */
  readonly content: string
}

export type RawPrintOutcome =
  | { ok: true; printJobId: string }
  | { ok: false; failure: RawPrintFailure }

export type RawPrintExecutor = (
  submission: RawPrintSubmission,
) => Promise<RawPrintOutcome>

export interface WindowsRawExecutorDeps {
  scriptPath: string
  platform?: string
  timeoutMs?: number
  /** Test enjeksiyonu; üretimde `child_process.execFile`. */
  run?: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>
}

/**
 * Yürütücü.
 *
 * Süreç hatası KARARLI koda eşlenir; PowerShell'in ham metni (yol adları,
 * .NET yığın izi, yerel hata metni) operatöre AKTARILMAZ — yalnız sınıf.
 */
export function createWindowsRawExecutor(
  deps: WindowsRawExecutorDeps,
): RawPrintExecutor {
  const platform = deps.platform ?? process.platform
  const timeout = Math.max(1, Number(deps.timeoutMs ?? 30_000))
  const run =
    deps.run ??
    ((file, args, options) =>
      execFileAsync(file, args, options as never) as unknown as Promise<{
        stdout: string
        stderr: string
      }>)

  return async (submission) => {
    // ÇALIŞMA ZAMANI GERÇEĞİ: Windows değilse bu yol YOKTUR.
    if (platform !== 'win32') {
      return { ok: false, failure: 'RUNTIME_NOT_SUPPORTED' }
    }
    const printerName = String(submission.printerName ?? '').trim()
    if (printerName === '') return { ok: false, failure: 'PRINTER_REJECTED' }
    const content = String(submission.content ?? '')
    if (content.trim() === '') return { ok: false, failure: 'PRINT_COMMAND_FAILED' }

    let stdout: string
    try {
      const result = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          deps.scriptPath,
          '-PrinterName',
          printerName,
          '-ZplBase64',
          Buffer.from(content, 'utf8').toString('base64'),
          '-DocumentName',
          String(submission.documentName ?? 'CargoFlow'),
        ],
        { windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
      )
      stdout = String(result?.stdout ?? '')
    } catch (error) {
      const killed = Boolean((error as { killed?: boolean })?.killed)
      // Ham metin DIŞARI ÇIKMAZ; yalnız sınıf.
      return {
        ok: false,
        failure: killed ? 'PRINT_COMMAND_TIMEOUT' : 'PRINT_COMMAND_FAILED',
      }
    }

    // TEK GEÇERLİ BAŞARI KANITI: spooler'ın SAYISAL iş kimliği.
    const printJobId = stdout.trim()
    if (!/^\d+$/.test(printJobId)) {
      return { ok: false, failure: 'NO_PRINT_JOB_ID' }
    }
    return { ok: true, printJobId }
  }
}
