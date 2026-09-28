import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = join(here, '..')

export function loadSuratSuiteListed() {
  return new Set(
    JSON.parse(readFileSync(join(here, 'suratSuiteFiles.json'), 'utf8')),
  )
}

export function loadSuratSuiteExclusions() {
  return new Set(
    JSON.parse(readFileSync(join(here, 'suratSuiteExclusions.json'), 'utf8')),
  )
}

/** `server/*.test.mjs` files that must be listed in test:surat or explicitly excluded. */
export function listOrphanSuratSuiteTests() {
  const listed = loadSuratSuiteListed()
  const exclusions = loadSuratSuiteExclusions()
  return readdirSync(serverDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `server/${name}`)
    .filter((path) => !listed.has(path) && !exclusions.has(path))
}
