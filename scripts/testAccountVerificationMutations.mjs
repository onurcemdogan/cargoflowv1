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
  { id: 'F', file: 'server/connectors/hepsiburada/hepsiburadaHttpHandlers.ts', pattern: 'AV-REVIEW-HB-BIND',
    before: /const bindingProven = page.ok && \(isHepsiburadaReadMerchantBound\(config\)[\s\S]*?config.merchantId\)\)\)/,
    after: 'const bindingProven = page.ok // MUTANT: response success alone verifies account' },
  { id: 'G', file: 'server/connectors/hepsiburada/hepsiburadaOrderSync.ts', pattern: 'AV-REVIEW-HB-SPLIT',
    before: /    const pending = \[window\][\s\S]*?(?=    completedThroughMs = window.endMs)/,
    after: `    let offset = 0
    for (let page = 0; page < maxRequests; page++) {
      const result = await fetchHepsiburadaPage(config, { family, offset, limit, startMs: window.startMs, endMs: window.endMs }, options)
      networkCalls += result.networkCalls
      if (!result.ok) return stop(result.errorClass, result.reasonCode)
      pagesFetched++
      for (const row of result.rows) {
        const key = recordKey(row)
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        rawRecords.push(row)
      }
      if (result.rows.length < limit) break
      offset += limit // MUTANT: unsafe offset walking
    }
` },
  { id: 'H-P', file: 'server/shipments/autoLabelProducer.ts', pattern: 'AV-REVIEW-SOURCE', replacements: [
    { before: 'const restrictedSources = orderSourcesWithoutFulfillment()', after: 'const restrictedSources: string[] = []' },
    { before: 'if (!orderSourceFulfillmentAllowed(row.marketplace))', after: 'if (false)' },
    { before: "        marketplace: String(row.marketplace ?? ''),", after: '// MUTANT: source omitted from eligibility' },
  ] },
  { id: 'H-C', file: 'server/shipments/autoLabelCatchup.ts', pattern: 'AV-REVIEW-SOURCE', replacements: [
    { before: 'if (!orderSourceFulfillmentAllowed(row.marketplace))', after: 'if (false)' },
    { before: "      marketplace: String(row.marketplace ?? ''),", after: '// MUTANT: source omitted from eligibility' },
  ] },
  { id: 'H-L', file: 'server/shipments/labelJobPreparation.ts', pattern: 'AV-REVIEW-SOURCE',
    before: '!orderSourceFulfillmentAllowed(order.marketplace)', after: 'false' },
]
const summary = []
for (const mutation of mutations) {
  const path = join(root, mutation.file)
  const original = readFileSync(path)
  const source = original.toString('utf8')
  let modified = source
  for (const replacement of mutation.replacements ?? [mutation]) {
    const next = modified.replace(replacement.before, replacement.after)
    assert.notEqual(next, modified, `Mutation ${mutation.id}: target absent`)
    modified = next
  }
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
