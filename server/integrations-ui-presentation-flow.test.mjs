import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('INTEGRATIONS-UI: shared shell has no IO or capability logic; provider decisions stay outside it', () => {
  const source = readFileSync('src/integrations/IntegrationConnection.tsx', 'utf8')
  assert.doesNotMatch(source, /fetch\(|authenticatedApiRequest|useEffect|useState|localStorage|verificationStatus|ordersActive/)
  assert.match(source, /ui-card integration-connection/)
})

test('INTEGRATIONS-UI: responsive connection/settings styles use existing theme tokens without fixed colors/overflow', () => {
  const css = readFileSync('src/index.css', 'utf8')
  const start = css.indexOf('.integration-connection {')
  const styles = css.slice(start, css.indexOf('.integration-commerce-sites,', start))
  assert.ok(start > 0)
  for (const token of ['surface', 'text', 'border', 'radius']) assert.match(styles, new RegExp(`var\\(--${token}`))
  assert.match(styles, /max-width: 640px/)
  assert.match(styles, /overflow-wrap: anywhere/)
  assert.match(styles, /flex-wrap: wrap/)
  assert.match(styles, /\.integrations-workspace \.integration-category-tabs \{ flex-wrap: wrap; overflow-x: visible; \}/)
  assert.doesNotMatch(styles, /#[\da-f]{3,8}\b|rgba?\(|overflow-x:\s*(scroll|auto)|min-width:\s*[3-9]\d\dpx/i)
})
