// Terminalde gizli (echo'suz) parola prompt'u. Parola argüman olarak verilmek
// zorunda değildir; stdin'den maskeli okunur ve ASLA loglanmaz.
import { createInterface } from 'node:readline'

export async function promptHiddenPassword(question: string): Promise<string> {
  const input = process.stdin
  const output = process.stdout
  const rl = createInterface({ input, output, terminal: true })
  // readline çıktısını sustur: satır boyunca yalnız soru yazılır, tuşlar gizlenir.
  const rlAny = rl as unknown as { _writeToOutput: (text: string) => void }
  let asked = false
  rlAny._writeToOutput = (text: string) => {
    if (!asked) {
      output.write(text)
      asked = true
      return
    }
    // Soru satırı dışındaki her şeyi (girilen karakterler) yazma.
    if (text.includes('\n')) output.write('\n')
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}
