// ÜRETİM ÇALIŞMA ZAMANI İTHALAT GRAFİ — OTOMATİK KEŞİF.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
// Üretim `node server/index.mjs` ile çalışır. Node'un ESM çözücüsü uzantısız
// göreli import'u ÇÖZMEZ; Vite ve `tsx` çözer. Bu fark yüzünden tüm testler
// geçerken üretim `Cannot find module` ile patladı (paketler 4110965877,
// 4111047971, 4111052547, 4111054904, 4111086641).
//
// ELLE LİSTE YETMEZ: "bulduğumuz dosyaları düzelttik" bir sonraki eklenen
// dosyayı KAÇIRIR. Bu modül grafi `server/index.mjs`'ten başlayarak
// KENDİSİ keşfeder.
//
// Salt metin analizi yapar: dosya ÇALIŞTIRILMAZ, yan etki YOKTUR.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'

/** Node'un ESM'de göreli import için kabul ettiği uzantılar. */
const NODE_RESOLVABLE = ['.ts', '.mts', '.js', '.mjs', '.cjs', '.json', '.tsx']

const NEWLINE = String.fromCharCode(10)

/**
 * Çok satırlı `import { ... } from '...'` bloklarını TEK satıra indirger.
 *
 * İlk tarayıcı sürümü satır-içi regex kullanıyordu ve şu biçimi KAÇIRDI:
 *     import {
 *       markCarrierBoundaryEntered,
 *     } from './shipments/carrierBoundarySink.ts'
 * Kaçırılan her dosya DENETİMSİZ kalır; tarayıcının kör noktası, aramanın
 * kendisini değersizleştirir.
 */
function flattenImportStatements(source) {
  const statements = []
  let buffer = null
  for (const line of source.split(NEWLINE)) {
    const trimmed = line.trim()
    if (buffer !== null) {
      buffer += ' ' + trimmed
      if (/from\s*['"][^'"]+['"]/.test(buffer)) {
        statements.push(buffer)
        buffer = null
      }
      continue
    }
    if (/^(?:import|export)\b/.test(trimmed)) {
      if (/from\s*['"][^'"]+['"]/.test(trimmed) || /^import\s*['"]/.test(trimmed)) {
        statements.push(trimmed)
      } else {
        buffer = trimmed
      }
      continue
    }
    statements.push(line)
  }
  if (buffer !== null) statements.push(buffer)
  return statements.join(NEWLINE)
}

/**
 * Bir kaynak dosyadaki GÖRELİ import belirteçlerini çıkarır.
 *
 * `import type` satırları tip silme ile yok olur ve Node onları HİÇ
 * çözmez; bu yüzden kapsam dışıdır. `export ... from` dahildir çünkü
 * çalışma zamanında gerçekten çözülür.
 */
export function extractRelativeSpecifiers(source) {
  const flattened = flattenImportStatements(source)
  const specifiers = []
  const patterns = [
    // import ... from '...' / export ... from '...'  (tip-only HARİÇ)
    /(?:^|[\r\n])\s*(?:import|export)\s+(?!type[\s{])[^'"\r\n]*?from\s*['"](\.[^'"]+)['"]/g,
    // import '...'
    /(?:^|[\r\n])\s*import\s*['"](\.[^'"]+)['"]/g,
    // await import('...')
    /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(flattened)) !== null) specifiers.push(match[1])
  }
  return [...new Set(specifiers)]
}

/** Belirteci gerçek dosyaya çözer; Node'un YAPACAĞI gibi. */
function resolveAsNode(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  // Node uzantısız göreli belirteci ÇÖZMEZ; dosya birebir var olmalıdır.
  if (existsSync(base) && statSync(base).isFile()) {
    return { ok: true, file: base }
  }
  // Hangi uzantı EKLENSEYDİ çözülürdü? Tanı için.
  const candidate = NODE_RESOLVABLE.map((extension) => base + extension).find(
    (path) => existsSync(path) && statSync(path).isFile(),
  )
  const indexCandidate = NODE_RESOLVABLE.map((extension) =>
    join(base, `index${extension}`),
  ).find((path) => existsSync(path) && statSync(path).isFile())
  return {
    ok: false,
    file: candidate ?? indexCandidate ?? null,
    reason: candidate || indexCandidate ? 'EXTENSIONLESS' : 'MISSING',
  }
}

/**
 * `entry`'den başlayarak üretimde ÇÖZÜLEMEYECEK import'ları bulur.
 *
 * @returns {{visited: string[], violations: Array<{file: string, specifier: string, reason: string}>}}
 */
export function auditProductionImportGraph(entry) {
  const visited = new Set()
  const violations = []
  const queue = [resolve(entry)]

  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const specifier of extractRelativeSpecifiers(source)) {
      const resolved = resolveAsNode(file, specifier)
      if (resolved.ok) {
        queue.push(resolved.file)
        continue
      }
      violations.push({ file, specifier, reason: resolved.reason })
      // Uzantısız olsa da grafi taramaya DEVAM et: tek bir ihlal yüzünden
      // arkasındaki dosyalar denetimsiz kalmasın.
      if (resolved.file) queue.push(resolved.file)
    }
  }
  return { visited: [...visited], violations }
}
