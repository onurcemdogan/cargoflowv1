import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// Sürat create iş sonucu (business result) regresyonu: HTTP 200 TEK BAŞINA SUCCESS
// değildir. Debug merkezi, UI ve label-ready AYNI iş sonucunu göstermeli.
// Çelişki: Debug "SUCCESS" ↔ UI "geçerli takip/barkod alınamadı" ↔ label-ready
// "doğrulanmış gönderi yok". Kök: business kararı lifecycleStatus + geçerli
// tracking/barkod varlığına bağlanmalı.

test('resolveSuratCreateBusinessResult: HTTP 200 tek başına SUCCESS değildir', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { resolveSuratCreateBusinessResult } = await vite.ssrLoadModule(
    '/src/utils/suratCreateResult.ts',
  )

  // (1) Doğrulanmış create: geçerli barkod/tracking + verified/printEnabled → businessOk.
  const verified = resolveSuratCreateBusinessResult({
    verifiedShipment: true,
    operationalBarcodeVerified: true,
    printEnabled: true,
    dispatchRegistrationConfirmed: true,
    labelStatus: 'READY',
    trackingNumber: '2512361562501',
    barcode: '0123990557601',
    lifecycleStatus: 'LABEL_READY',
  })
  assert.equal(verified.businessOk, true)
  assert.equal(verified.hasIdentifier, true)

  // Ön-atanmış (preassigned) hazır: printEnabled + aday kodlar → businessOk.
  const preassigned = resolveSuratCreateBusinessResult({
    printEnabled: true,
    labelStatus: 'READY',
    tNo: '2512361562501',
    barkodNo: '0123990557601',
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
  })
  assert.equal(preassigned.businessOk, true)

  // (2) HTTP 200 ama tracking/barkod YOK → businessOk=false (BUSINESS_ERROR).
  const noCodes = resolveSuratCreateBusinessResult({
    printEnabled: false,
    labelStatus: 'PENDING',
    lifecycleStatus: 'SURAT_CREATED_NO_TRACKING',
  })
  assert.equal(noCodes.businessOk, false)
  assert.equal(noCodes.hasIdentifier, false)

  // (3) Business-failure lifecycle (dispatch reddedildi / belirsiz) → businessOk=false
  // (aday kod olsa bile).
  for (const lc of ['SURAT_DISPATCH_REJECTED', 'SURAT_CREATE_UNCERTAIN', 'SURAT_BARCODE_FAILED']) {
    const failed = resolveSuratCreateBusinessResult({
      printEnabled: true,
      trackingNumber: '999',
      barcode: '888',
      lifecycleStatus: lc,
    })
    assert.equal(failed.businessOk, false, `${lc} → business failure`)
    assert.equal(failed.failedLifecycle, true)
  }

  // (4) labelStatus BLOCKED → businessOk=false.
  const blocked = resolveSuratCreateBusinessResult({
    printEnabled: true,
    trackingNumber: '999',
    barcode: '888',
    labelStatus: 'BLOCKED',
    lifecycleStatus: 'LABEL_READY',
  })
  assert.equal(blocked.businessOk, false)
  assert.equal(blocked.blocked, true)

  // (5) shipment yok/boş → businessOk=false (fabrike SUCCESS üretmez).
  assert.equal(resolveSuratCreateBusinessResult(undefined).businessOk, false)
  assert.equal(resolveSuratCreateBusinessResult({}).businessOk, false)
})
