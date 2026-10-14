import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// Run sequentially with no other tests/editors modifying these files.
// Every changed file is restored byte-exact in finally, including on a failed proof.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = resolve(process.argv[2] ?? join(root, 'work', 'account-verification-mutations'))
mkdirSync(outputDir, { recursive: true })
const guard = "if (account.verificationStatus !== 'verified') return blocked('ACCOUNT_NOT_VERIFIED')"
const mutations = [
  { id: 'A', file: 'server/connectors/accountOrdersReadGate.ts', pattern: 'AV-1/7/11', before: guard, after: "// MUTANT: credentials alone are proof." },
  { id: 'B', file: 'server/connectors/accountOrdersReadGate.ts', pattern: 'AV-1/7/11', before: guard,
    after: "if (account.verificationStatus !== 'verified' && !(await db.select().from(marketplaceAccounts).where(and(eq(marketplaceAccounts.organizationId, scope.organizationId), eq(marketplaceAccounts.marketplace, providerKey), eq(marketplaceAccounts.verificationStatus, 'verified'))).limit(1)).length) return blocked('ACCOUNT_NOT_VERIFIED')" },
  { id: 'C', file: 'server/carriers/carrierAccounts.ts', pattern: 'AV-6:',
    before: "credentialFingerprint: fingerprint, verificationStatus: 'unverified', lastVerifiedAt: null, lastVerificationAttemptAt: null, updatedAt: new Date()",
    after: 'credentialFingerprint: fingerprint, updatedAt: new Date()' },
  { id: 'D', file: 'server/connectors/liveWriteGate.ts', pattern: 'AV-10/12/13',
    before: /(?<=export function canTriggerFulfillmentSideEffects[\s\S]*?)if \(!stageAffectsLiveBehavior\(stage\)\)/,
    after: 'if (false)' },
  { id: 'E', file: 'server/connectors/n11/n11ConnectionService.ts', pattern: 'AV-8:',
    before: 'eq(marketplaceAccounts.organizationId, organizationId),', after: '// MUTANT: tenant ownership omitted.' },
]
const summary = []
for (const mutation of mutations) {
  const path = join(root, mutation.file)
  const original = readFileSync(path)
  const source = original.toString('utf8')
  const modified = source.replace(mutation.before, mutation.after)
  assert.notEqual(modified, source, `Mutation ${mutation.id}: target absent`)
  try {
    writeFileSync(path, modified)
    const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=${mutation.pattern}`, 'server/account-level-verification-flow.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 120_000 })
    const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    writeFileSync(join(outputDir, `mutation-${mutation.id}.log`), log)
    assert.equal(run.error, undefined, `Mutation ${mutation.id}: test execution error`)
    assert.notEqual(run.status, 0, `Mutation ${mutation.id}: SURVIVED`)
    assert.match(log, /ERR_ASSERTION|AssertionError/, `Mutation ${mutation.id}: must fail an assertion`)
    summary.push({ id: mutation.id, killed: true, testPattern: mutation.pattern })
    console.log(`Mutation ${mutation.id}: killed by assertion`)
  } finally {
    writeFileSync(path, original)
    assert.ok(readFileSync(path).equals(original), `Mutation ${mutation.id}: byte-exact restoration failed`)
    console.log(`Mutation ${mutation.id}: restored ${createHash('sha256').update(original).digest('hex')}`)
  }
}
writeFileSync(join(outputDir, 'summary.json'), JSON.stringify({ mutations: summary, byteExactRestored: true }, null, 2) + '\n')
