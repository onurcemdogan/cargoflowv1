// Node ESM çözümleyici kancası: `src/` altındaki frontend modülleri Vite
// (bundler) çözümlemesi kullandığı için uzantısız import eder
// (`./orderStatus`). Node bunu çözemez. Bu kanca YALNIZ çözümleme başarısız
// olduğunda `.ts` / `.tsx` / `/index.ts` uzantılarını dener.
//
// Ölçüm aracıdır: ürün davranışını DEĞİŞTİRMEZ, çalışma zamanında yüklenmez.
const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx']

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error
    for (const extension of CANDIDATES) {
      try {
        return await nextResolve(`${specifier}${extension}`, context)
      } catch {
        // sıradaki adayı dene
      }
    }
    throw error
  }
}
