export const SURAT_LIFECYCLE_STATES = Object.freeze({
  CREATE_FAILED: 'CREATE_FAILED',
  CREATE_ACCEPTED_UNCONFIRMED: 'CREATE_ACCEPTED_UNCONFIRMED',
  LABEL_CREATED_UNVERIFIED: 'LABEL_CREATED_UNVERIFIED',
  LABEL_CREATED_NOT_REGISTERED: 'LABEL_CREATED_NOT_REGISTERED',
  SHIPMENT_REGISTERED_LABEL_REQUIRED: 'SHIPMENT_REGISTERED_LABEL_REQUIRED',
  SHIPMENT_REGISTERED_PENDING_TRACKING:
    'SHIPMENT_REGISTERED_PENDING_TRACKING',
  TRACKING_ACTIVE: 'TRACKING_ACTIVE',
  VERIFIED: 'VERIFIED',
})

export function deriveSuratLifecycleState(evidence = {}) {
  const createAccepted = evidence.createAccepted === true
  const shipmentRegistered = evidence.shipmentRegistered === true
  const labelCreated = evidence.labelCreated === true
  const trackingActive = evidence.trackingActive === true
  const serendipVerified = evidence.serendipVerified === true
  const registrationGraceExpired =
    evidence.registrationGraceExpired === true
  const preassignedCodesPresent = evidence.preassignedCodesPresent === true

  const milestones = []
  if (createAccepted) milestones.push('CREATE_ACCEPTED')
  if (shipmentRegistered) milestones.push('SHIPMENT_REGISTERED')
  if (labelCreated) milestones.push('LABEL_CREATED')
  if (trackingActive) milestones.push('TRACKING_ACTIVE')
  if (serendipVerified) milestones.push('VERIFIED')

  let state = SURAT_LIFECYCLE_STATES.CREATE_FAILED
  if (
    serendipVerified &&
    shipmentRegistered &&
    trackingActive &&
    labelCreated
  ) {
    state = SURAT_LIFECYCLE_STATES.VERIFIED
  } else if (shipmentRegistered && !labelCreated) {
    state = SURAT_LIFECYCLE_STATES.SHIPMENT_REGISTERED_LABEL_REQUIRED
  } else if (trackingActive && shipmentRegistered) {
    state = SURAT_LIFECYCLE_STATES.TRACKING_ACTIVE
  } else if (shipmentRegistered) {
    state = SURAT_LIFECYCLE_STATES.SHIPMENT_REGISTERED_PENDING_TRACKING
  } else if (labelCreated && registrationGraceExpired) {
    state = SURAT_LIFECYCLE_STATES.LABEL_CREATED_NOT_REGISTERED
  } else if (labelCreated) {
    state = SURAT_LIFECYCLE_STATES.LABEL_CREATED_UNVERIFIED
  } else if (createAccepted) {
    state = SURAT_LIFECYCLE_STATES.CREATE_ACCEPTED_UNCONFIRMED
  }

  // Kanıt (17.07.2026): create/label yanıtındaki T.No/barkod tesellümde aynen
  // korunuyor; kabul öncesi etiket bu ön-atanmış kodlarla yazdırılabilir.
  const preassignedPrintAllowed =
    labelCreated &&
    preassignedCodesPresent &&
    [
      SURAT_LIFECYCLE_STATES.LABEL_CREATED_UNVERIFIED,
      SURAT_LIFECYCLE_STATES.LABEL_CREATED_NOT_REGISTERED,
    ].includes(state)

  return {
    state,
    milestones,
    createAccepted,
    shipmentRegistered,
    labelCreated,
    trackingActive,
    serendipVerified,
    registrationGraceExpired,
    preassignedCodesPresent,
    preassignedPrintAllowed,
    printable:
      state === SURAT_LIFECYCLE_STATES.VERIFIED || preassignedPrintAllowed,
  }
}
