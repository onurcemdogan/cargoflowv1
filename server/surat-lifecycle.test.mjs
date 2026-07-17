import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SURAT_LIFECYCLE_STATES,
  deriveSuratLifecycleState,
} from './surat-lifecycle.mjs'

test('create kabul edildi ama kayıt görünmüyor', () => {
  const result = deriveSuratLifecycleState({ createAccepted: true })
  assert.equal(
    result.state,
    SURAT_LIFECYCLE_STATES.CREATE_ACCEPTED_UNCONFIRMED,
  )
  assert.deepEqual(result.milestones, ['CREATE_ACCEPTED'])
  assert.equal(result.printable, false)
})

test('kayıt var, etiket var ama takip aktif değil', () => {
  const result = deriveSuratLifecycleState({
    createAccepted: true,
    shipmentRegistered: true,
    labelCreated: true,
  })
  assert.equal(
    result.state,
    SURAT_LIFECYCLE_STATES.SHIPMENT_REGISTERED_PENDING_TRACKING,
  )
  assert.deepEqual(result.milestones, [
    'CREATE_ACCEPTED',
    'SHIPMENT_REGISTERED',
    'LABEL_CREATED',
  ])
  assert.equal(result.printable, false)
})

test('kayıt var ama etiket yok', () => {
  const result = deriveSuratLifecycleState({
    createAccepted: true,
    shipmentRegistered: true,
  })
  assert.equal(
    result.state,
    SURAT_LIFECYCLE_STATES.SHIPMENT_REGISTERED_LABEL_REQUIRED,
  )
  assert.equal(result.printable, false)
})

test('etiket var ama kayıt yok ve doğrulama süresi doldu', () => {
  const result = deriveSuratLifecycleState({
    labelCreated: true,
    registrationGraceExpired: true,
  })
  assert.equal(
    result.state,
    SURAT_LIFECYCLE_STATES.LABEL_CREATED_NOT_REGISTERED,
  )
  assert.deepEqual(result.milestones, ['LABEL_CREATED'])
  assert.equal(result.printable, false)
})

test('kayıt ve etiket var, takip aktif', () => {
  const result = deriveSuratLifecycleState({
    createAccepted: true,
    shipmentRegistered: true,
    labelCreated: true,
    trackingActive: true,
  })
  assert.equal(result.state, SURAT_LIFECYCLE_STATES.TRACKING_ACTIVE)
  assert.equal(result.printable, false)
})

test('ön-atanmış kodlar varken kabul öncesi etiket yazdırılabilir', () => {
  const result = deriveSuratLifecycleState({
    createAccepted: true,
    labelCreated: true,
    preassignedCodesPresent: true,
  })
  assert.equal(result.state, SURAT_LIFECYCLE_STATES.LABEL_CREATED_UNVERIFIED)
  assert.equal(result.preassignedPrintAllowed, true)
  assert.equal(result.printable, true)
})

test('grace süresi dolsa bile ön-atanmış kodlarla baskı açık kalır', () => {
  const result = deriveSuratLifecycleState({
    createAccepted: true,
    labelCreated: true,
    registrationGraceExpired: true,
    preassignedCodesPresent: true,
  })
  assert.equal(
    result.state,
    SURAT_LIFECYCLE_STATES.LABEL_CREATED_NOT_REGISTERED,
  )
  assert.equal(result.preassignedPrintAllowed, true)
  assert.equal(result.printable, true)
})

test('ön-atanmış kod yoksa kabul öncesi baskı kapalı kalır', () => {
  const result = deriveSuratLifecycleState({
    createAccepted: true,
    labelCreated: true,
  })
  assert.equal(result.state, SURAT_LIFECYCLE_STATES.LABEL_CREATED_UNVERIFIED)
  assert.equal(result.preassignedPrintAllowed, false)
  assert.equal(result.printable, false)
})

test('Serendip aynı T.No ile doğrulanınca VERIFIED olur', () => {
  const result = deriveSuratLifecycleState({
    createAccepted: true,
    shipmentRegistered: true,
    labelCreated: true,
    trackingActive: true,
    serendipVerified: true,
  })
  assert.equal(result.state, SURAT_LIFECYCLE_STATES.VERIFIED)
  assert.deepEqual(result.milestones, [
    'CREATE_ACCEPTED',
    'SHIPMENT_REGISTERED',
    'LABEL_CREATED',
    'TRACKING_ACTIVE',
    'VERIFIED',
  ])
  assert.equal(result.printable, true)
})
