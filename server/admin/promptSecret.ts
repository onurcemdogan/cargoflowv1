// CLI parola girişi. Parola ASLA argv'ye (shell geçmişine) yazılmaz ve
// loglanmaz. İki yol desteklenir:
//   1) Etkileşimli terminal → gizli (echo'suz) prompt
//   2) --password-stdin      → parola stdin'den okunur (etkileşimsiz ortam)
// TTY yoksa komut SESSİZCE ASILI KALMAZ; açık hata verir.
import { createInterface } from 'node:readline'

export function isInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export async function promptHiddenPassword(question: string): Promise<string> {
  if (!isInteractiveTty()) {
    throw new Error(
      'Gizli parola istemi için etkileşimli terminal (TTY) gerekli. ' +
        'Etkileşimsiz ortamda şunu kullanın: ... -- --username "<ad>" --password-stdin',
    )
  }
  // Soru DOĞRUDAN yazılır (readline echo hilesine güvenilmez).
  process.stdout.write(question)
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  // Girilen karakterler ekrana YAZILMAZ.
  ;(rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput =
    () => {}
  return new Promise((resolve, reject) => {
    rl.once('error', reject)
    rl.question('', (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

// --password-stdin: parola stdin'den okunur. Örn:
//   printf '%s' 'parola' | npm run platform-admin:create -- --username admin --password-stdin
export async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

// CLI ortak parola çözümü: --password-stdin varsa stdin, yoksa gizli prompt
// (iki kez sorup eşleşme doğrulanır).
export async function resolveCliPassword(options: {
  question: string
  confirmQuestion: string
}): Promise<string> {
  if (process.argv.includes('--password-stdin')) {
    const password = await readPasswordFromStdin()
    if (!password) {
      throw new Error('--password-stdin ile parola okunamadı (boş girdi).')
    }
    return password
  }
  const password = await promptHiddenPassword(options.question)
  const confirm = await promptHiddenPassword(options.confirmQuestion)
  if (password !== confirm) throw new Error('Parolalar eşleşmiyor.')
  return password
}
