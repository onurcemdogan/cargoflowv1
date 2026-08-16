// Node icin bundler-tarzi uzantisiz import cozumleyicisi (YALNIZ TEST).
//
// `src/` altindaki modüller Vite'in cozdugu uzantisiz yollari kullanir
// (`../utils/storage`). Node bunlari cozemez. Bu kanca, gercek frontend
// modullerini sunucu testlerinden CALISTIRARAK dogrulayabilmek icindir;
// uretim davranisini DEGISTIRMEZ.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL) throw error
    const base = dirname(fileURLToPath(context.parentURL))
    const target = resolvePath(base, specifier)
    for (const extension of EXTENSIONS) {
      const candidate = `${target}${extension}`
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
    for (const extension of EXTENSIONS) {
      const candidate = resolvePath(target, `index${extension}`)
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
    throw error
  }
}
