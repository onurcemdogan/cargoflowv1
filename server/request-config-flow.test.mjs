import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractSuratConfigCandidate,
  resolveSuratConnectionTestPassword,
} from './integrations/requestConfig.mjs'

test('legacy Sürat request shape remains supported', () => {
  const config = { kullaniciAdi: '1551267127', sifre: 'secret' }
  assert.equal(extractSuratConfigCandidate({ config }), config)
})

test('auth-mode full integration config resolves nested Sürat credentials', () => {
  const surat = {
    kullaniciAdi: '1551267127',
    sifre: 'secret',
    webPassword: 'web-secret',
  }
  assert.equal(
    extractSuratConfigCandidate({
      config: {
        trendyol: { sellerId: '696196' },
        surat,
      },
    }),
    surat,
  )
})

test('connection test prefers WebPassword and supports legacy single password', () => {
  assert.equal(
    resolveSuratConnectionTestPassword({
      sifre: 'shipment-secret',
      webPassword: 'web-secret',
    }),
    'web-secret',
  )
  assert.equal(
    resolveSuratConnectionTestPassword({ sifre: 'legacy-single-secret' }),
    'legacy-single-secret',
  )
  assert.equal(resolveSuratConnectionTestPassword({}), '')
})
