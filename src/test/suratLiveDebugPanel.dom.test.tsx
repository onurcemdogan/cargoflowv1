import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { SuratLiveDebugPanel } from '../components/SuratLiveDebugPanel'

const trace = (id: string, createdAt: string) => ({
  traceId: id, schemaVersion: 2, createdAt,
  stages: [
    { stage: 'PRE_FLIGHT', at: 'x', section: 'BILLING', data: {
      billingParty: 'TRENDYOL_PAYS', expectedSuratWhoPays: '3',
      odemeTipi: '1', codEnabled: false,
      preflightValid: true, preflightFailures: [] } },
    { stage: 'ROUTING', at: 'x', section: 'CREDENTIAL_ROUTING', data: {
      credentialRole: 'PRIMARY_MARKETPLACE', maskedAccount: '49****56',
      sifre: 'COK_GIZLI' } },
    { stage: 'REQUEST_READY', at: 'x', section: 'REQUEST', data: {
      wireWhoPaysPresent: false,
      wireWhoPaysReason: 'CONTRACT_HAS_NO_WHO_PAYS_FIELD' } },
    { stage: 'CARRIER_CALL', at: 'x', section: 'SERVICE_ROUTING', data: {} },
    { stage: 'CARRIER_RESPONSE', at: 'x', section: 'RESPONSE', data: {
      businessCode: '016', businessMessage: `yanit-${id}` } },
    { stage: 'VERIFICATION', at: 'x', section: 'VERIFICATION', data: {
      trackingPresent: true, barcodePresent: true } },
    { stage: 'FINAL', at: 'x', section: 'FINAL_RESULT', data: {
      carrierCreateStatus: 'SUCCESS', carrierCalled: true } },
  ],
})

const LEGACY = { traceId: 'v1-eski', createdAt: '2099-01-01T00:00:00.000Z' }

test('Canlı Debug bes sekmeyi Trace V2 uzerinden gosterir', async () => {
  render(<SuratLiveDebugPanel traces={[trace('CF-A', '2026-08-18T10:00:00.000Z')]} />)
  for (const name of ['Son Deneme', 'Karar / Mapping', 'Request', 'Response', 'Geçmiş']) {
    expect(screen.getByRole('tab', { name })).toBeTruthy()
  }
  expect(screen.getByText('CF-A')).toBeTruthy()
})

test('beklenen ile tel AYRI gosterilir ve hata gibi sunulmaz', () => {
  render(<SuratLiveDebugPanel traces={[trace('CF-A', '2026-08-18T10:00:00.000Z')]} />)
  expect(screen.getByText('GÖNDERİLMEDİ')).toBeTruthy()
  // Sebep hem ozet satirinda hem de tel dokumunde gorunur.
  expect(screen.getAllByText(/CONTRACT_HAS_NO_WHO_PAYS_FIELD/).length)
    .toBeGreaterThan(0)
})

test('sir GOSTERILMEZ, maskeli cari gosterilir', async () => {
  render(<SuratLiveDebugPanel traces={[trace('CF-A', '2026-08-18T10:00:00.000Z')]} />)
  await userEvent.click(screen.getByRole('tab', { name: 'Karar / Mapping' }))
  expect(screen.getByText('49****56')).toBeTruthy()
  expect(screen.getByText('PRIMARY_MARKETPLACE')).toBeTruthy()
  expect(document.body.textContent).not.toContain('COK_GIZLI')
})

test('eski v1 kaydi SON DENEME olarak secilmez', () => {
  render(<SuratLiveDebugPanel
    traces={[LEGACY, trace('CF-A', '2026-08-18T10:00:00.000Z')]} />)
  expect(screen.getByText('CF-A')).toBeTruthy()
  expect(document.body.textContent).not.toContain('v1-eski')
})

test('Son Deneme EN YENI izi secer ve gecmisten baskasina gecilebilir', async () => {
  render(<SuratLiveDebugPanel traces={[
    trace('CF-OLD', '2026-08-18T09:00:00.000Z'),
    trace('CF-NEW', '2026-08-18T11:00:00.000Z'),
  ]} />)
  expect(screen.getByText('CF-NEW')).toBeTruthy()
  await userEvent.click(screen.getByRole('tab', { name: 'Response' }))
  // Yanit SECILI izin kendi yaniti olmali.
  expect(screen.getByText('yanit-CF-NEW')).toBeTruthy()
  expect(document.body.textContent).not.toContain('yanit-CF-OLD')
})

test('iz yoksa bos durum gosterilir', () => {
  render(<SuratLiveDebugPanel traces={[]} />)
  expect(screen.getByText(/Henüz bir Sürat gönderi denemesi/)).toBeTruthy()
})
