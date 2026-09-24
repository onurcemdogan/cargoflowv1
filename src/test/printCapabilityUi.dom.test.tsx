import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { PrintPreviewModal } from '../components/PrintPreviewModal'
import {
  resolveRawPrintActionGate,
  findRawCapability,
  fetchPrintCapabilities,
  type PrintTransportCapability,
} from '../services/printCapabilityService'
import type { CargoOrder, PrinterSettings } from '../types/cargoflow'

// ═══ BASKI AKSİYONU YETENEK KAPISI ═══════════════════════════════════════
//
// ÖLÇÜLEN KUSUR: sunucu `/api/printing/capabilities` ile dürüst çalışma
// zamanı yeteneğini yayınlıyordu ama ARAYÜZ TÜKETMİYORDU. Kayıtlı bir yazıcı
// adı, Linux bir API çalışma zamanında bile "bağlı / Windows RAW baskı"
// gösterebiliyor ve kullanıcıya GÖNDEREMEYECEĞİ bir iş VAAT EDİLİYORDU.
//
// Buradaki kapı bir KOLAYLIKTIR; gerçek sınır sunucudadır (409). Kapının
// görevi sahte vaadi kesmektir.

const RAW_PRINTER: PrinterSettings = {
  printerName: 'Zebra ZD220',
  mode: 'local-agent',
  labelSize: '100x100',
  defaultFormat: 'zpl',
}

const capability = (
  overrides: Partial<PrintTransportCapability>,
): PrintTransportCapability => ({
  transport: 'SERVER_WINDOWS_RAW',
  supportsZpl: true,
  supportsRaster: false,
  supportsHtml: false,
  supportsMultiPage: true,
  available: false,
  reason: null,
  ...overrides,
})

const UNAVAILABLE = capability({ available: false, reason: 'RUNTIME_NOT_WINDOWS' })
const AVAILABLE = capability({ available: true, reason: null })

function buildOrder(): CargoOrder {
  return {
    id: 'order-1',
    orderNumber: 'ORD-1',
    marketplace: 'Trendyol',
    customerName: 'Ada Yılmaz',
    status: 'Etiket Hazır',
    labelStatus: 'READY',
    createdAt: '2026-09-01T10:00:00.000Z',
    orderDate: '2026-09-01T10:00:00.000Z',
    items: [],
    // BASIMA UYGUN fixture: kalıcı taşıyıcı etiketi VAR. Aksi hâlde onay
    // butonu YETENEKTEN BAĞIMSIZ olarak kapalı kalır ve test kapıyı
    // ölçemez (ilk yazımda bu tuzağa düşüldü).
    hasPrintableLabel: true,
    shipment: {
      tNo: '11415535074',
      kargoTakipNo: '11415535074',
      barkodNo: '11415535074',
      barcodeRaw: '^XA^FO50,50^BCN,100,Y,N,N^FD11415535074^FS^XZ',
      labelStatus: 'READY',
      printEnabled: true,
      zplReady: true,
      // Ön-atanmış T.No/barkod kabul ÖNCESİ baskıya izin verir
      // (`resolvePrintableLabel` → preassignedPrintReady).
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      desi: 2,
    },
  } as unknown as CargoOrder
}

function renderModal(rawPrintCapability: PrintTransportCapability | null) {
  const onConfirm = vi.fn()
  render(
    <PrintPreviewModal
      orders={[buildOrder()]}
      mode="print"
      template={{ id: 't', name: 't' } as never}
      mappingConfig={{} as never}
      printerSettings={RAW_PRINTER}
      rawPrintCapability={rawPrintCapability}
      busy={false}
      onClose={() => {}}
      onConfirm={onConfirm}
      onDesiChange={() => {}}
    />,
  )
  return { onConfirm }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

/* ─────────────────────────────────────────────────────────────────────── */

test('PRINT-CAP-UI-2: RUNTIME_NOT_WINDOWS → aksiyon kapalı, sebep görünür', () => {
  const gate = resolveRawPrintActionGate(RAW_PRINTER, UNAVAILABLE)
  expect(gate.blocked).toBe(true)
  expect(gate.reason).toMatch(/Windows değil/)

  renderModal(UNAVAILABLE)

  // SEBEP GÖRÜNÜR.
  const notice = screen.getByTestId('raw-print-unavailable')
  expect(notice.textContent).toMatch(/kullanılamıyor/)
  expect(notice.textContent).toMatch(/Windows değil/)

  // AKSİYON KAPALI: kullanıcı gönderim BAŞLATAMAZ.
  const confirm = screen
    .getAllByRole('button')
    .find((button) => /Yazdırmayı Başlat|Tekrar Yazdır/.test(button.textContent ?? ''))
  expect(confirm).toBeTruthy()
  expect((confirm as HTMLButtonElement).disabled).toBe(true)

  // RAW GÖNDERİM VAADİ YAPILMAZ.
  expect(document.body.textContent).not.toMatch(/RAW ZPL olarak gönderecek/)
})

test('PRINT-CAP-UI-2b: kapalıyken /api/printing/jobs ÇAĞRILMAZ', async () => {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url))
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
    }),
  )
  const { onConfirm } = renderModal(UNAVAILABLE)
  const confirm = screen
    .getAllByRole('button')
    .find((button) => /Yazdırmayı Başlat|Tekrar Yazdır/.test(button.textContent ?? ''))
  // Devre dışı buton tıklansa bile onConfirm TETİKLENMEZ.
  ;(confirm as HTMLButtonElement).click()
  expect(onConfirm).not.toHaveBeenCalled()
  expect(calls.filter((url) => url.includes('/api/printing/jobs'))).toHaveLength(0)
})

test('PRINT-CAP-UI-3: yetenek UYGUNSA aksiyon AÇIK kalır', () => {
  const gate = resolveRawPrintActionGate(RAW_PRINTER, AVAILABLE)
  expect(gate.blocked).toBe(false)

  renderModal(AVAILABLE)
  expect(screen.queryByTestId('raw-print-unavailable')).toBeNull()
  const confirm = screen
    .getAllByRole('button')
    .find((button) => /Yazdırmayı Başlat|Tekrar Yazdır/.test(button.textContent ?? ''))
  expect((confirm as HTMLButtonElement).disabled).toBe(false)
  // MEVCUT metin KORUNUR.
  expect(document.body.textContent).toMatch(/RAW ZPL olarak gönderecek/)
})

test('PRINT-CAP-UI-4: yetenek okunamadıysa da RAW aksiyonu AÇILMAZ', () => {
  expect(resolveRawPrintActionGate(RAW_PRINTER, null).blocked).toBe(true)
  // "Bilmiyorum" ASLA "kullanılabilir" sayılmaz.
  renderModal(null)
  expect(screen.getByTestId('raw-print-unavailable')).toBeTruthy()
})

test('PRINT-CAP-UI-5/6: tarayıcı baskısı ve indirme ETKİLENMEZ', () => {
  // Sunucu ham yolu kullanılamaz DESE BİLE bu hedefler açıktır: onlar
  // sunucu çalışma zamanına BAĞLI DEĞİLDİR.
  for (const mode of ['browser-print', 'download'] as const) {
    const settings = { ...RAW_PRINTER, mode }
    expect(resolveRawPrintActionGate(settings, UNAVAILABLE).blocked).toBe(false)
    expect(resolveRawPrintActionGate(settings, null).blocked).toBe(false)
  }
})

test('PRINT-CAP-UI-FETCH: yetenek okunamazsa "bağlı" ÜRETİLMEZ', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('ağ yok')
    }),
  )
  const snapshot = await fetchPrintCapabilities('Zebra ZD220')
  expect(snapshot.loaded).toBe(false)
  expect(findRawCapability(snapshot)).toBeNull()
  expect(resolveRawPrintActionGate(RAW_PRINTER, findRawCapability(snapshot)).blocked).toBe(
    true,
  )
})
