import assert from 'node:assert/strict'
import test from 'node:test'

// PHASE2-E — YEREL MOD SIR POLİTİKASI (birim): maskeleme ve birleştirme.
const policy = await import('./integrations/localSecretPolicy.ts')

const STORED = {
  trendyol: { sellerId: '1', apiKey: 'KAYITLI-KEY', apiSecret: 'KAYITLI-SECRET' },
  surat: { kullaniciAdi: 'cari', sifre: 'KAYITLI-SIFRE', webPassword: '', codSifre: 'KAYITLI-COD', liveSifre: 'KAYITLI-LIVE', restBasicPassword: 'KAYITLI-REST' },
}

test('LSP-1: maskeleme — kayıtlı sır yer tutucu olur, boş sır boş kalır, gizli olmayan alan aynen', () => {
  const masked = policy.maskLocalSecrets(STORED)
  assert.equal(masked.trendyol.apiKey, policy.LOCAL_SAVED_SECRET_PLACEHOLDER)
  assert.equal(masked.surat.webPassword, '')
  assert.equal(masked.surat.kullaniciAdi, 'cari')
  assert.doesNotMatch(JSON.stringify(masked), /KAYITLI/)
  assert.equal(policy.maskLocalSecrets(null), null)
})

test('LSP-2: birleştirme — boş/maskeli sır KORUNUR, gerçek yeni sır yazılır', () => {
  const merged = policy.mergeLocalSecrets(
    {
      trendyol: { sellerId: '2', apiKey: policy.LOCAL_SAVED_SECRET_PLACEHOLDER, apiSecret: 'YENI-SECRET' },
      surat: { kullaniciAdi: 'cari', sifre: '', codSifre: '••••COD' },
    },
    STORED,
  )
  assert.equal(merged.trendyol.sellerId, '2')
  assert.equal(merged.trendyol.apiKey, 'KAYITLI-KEY')
  assert.equal(merged.trendyol.apiSecret, 'YENI-SECRET')
  assert.equal(merged.surat.sifre, 'KAYITLI-SIFRE')
  assert.equal(merged.surat.codSifre, 'KAYITLI-COD')
  // Kayıt yoksa maskeli değer SIR SAYILMAZ (boş kalır).
  const fresh = policy.mergeLocalSecrets({ trendyol: { apiKey: policy.LOCAL_SAVED_SECRET_PLACEHOLDER } }, null)
  assert.equal(fresh.trendyol.apiKey, '')
})
