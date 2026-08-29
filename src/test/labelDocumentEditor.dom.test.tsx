import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LabelTemplateEditorPage } from '../pages/LabelTemplateEditorPage'
import { SYSTEM_LABEL_TEMPLATES, cloneDocument } from '../labels/labelSystemTemplates'
import { BASE_PX_PER_MM } from '../labels/labelGeometry'
import type { CargoOrder } from '../types/cargoflow'

// ═══ GÖRSEL ETİKET DÜZENLEYİCİSİ — GERÇEK ARAYÜZ ÜZERİNDEN ══════════════
//
// Bu paket kurgusal yardımcılar üzerinden DEĞİL, gerçek bileşen ağacı ve
// gerçek pointer olayları üzerinden sürülür: sürükleme, boyutlandırma,
// sayısal alan, geri al/yinele, taslak kaydetme ve yayınlama.
//
// HER testte ağ çağrıları sayılır. Düzenleyicinin HİÇBİR eylemi taşıyıcıya
// veya pazaryerine çıkmamalıdır (TEMPLATE_EDITOR_CARRIER_CALLS=0).

const ORDER: CargoOrder = {
  id: 'o1',
  orderNumber: '11543590246',
  packageId: '4108176742',
  marketplace: 'Trendyol',
  customerName: 'Şükrü Öztürk',
  customerFirstName: 'Şükrü',
  customerLastName: 'Öztürk',
  address: 'Yeşilbahçe Mah. Portakal Çiçeği Blv. No: 12/A',
  city: 'ANTALYA',
  district: 'MURATPAŞA',
  status: 'Picking',
  createdAt: '2026-08-26T09:15:00',
  orderDate: '2026-08-26T09:15:00',
  items: [
    { id: 'i1', productName: 'Ürün A', quantity: 2, sku: 'SKU-1', color: 'Siyah', size: 'M' },
  ],
} as unknown as CargoOrder

interface FetchCall {
  url: string
  method: string
  body: unknown
}

let calls: FetchCall[] = []
let templates: Array<{
  id: string
  name: string
  version: number
  updatedAt: string
  draft: unknown
  active: unknown
}> = []
let activeTemplateId: string | null = null

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response
}

beforeEach(() => {
  calls = []
  templates = []
  activeTemplateId = null
  // jsdom pointer capture desteklemez; sürükleme testleri icin gerekli.
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
    Element.prototype.releasePointerCapture = () => {}
  }
  // requestAnimationFrame senkron calistirilir: surukleme guncellemesi
  // testte beklemeden gorunur.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = String(init?.method ?? 'GET').toUpperCase()
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })

      if (url === '/api/labels/documents' && method === 'GET') {
        return jsonResponse({ ok: true, system: SYSTEM_LABEL_TEMPLATES, templates, activeTemplateId })
      }
      if (url === '/api/labels/documents' && method === 'POST') {
        const source =
          (body as { fromSystemId?: string; fromTemplateId?: string }).fromSystemId
            ? SYSTEM_LABEL_TEMPLATES.find(
                (item) => item.id === (body as { fromSystemId: string }).fromSystemId,
              )
            : templates.find(
                (item) => item.id === (body as { fromTemplateId: string }).fromTemplateId,
              )?.draft
        const id = `tpl_${templates.length + 1}`
        const record = {
          id,
          name: String((body as { name: string }).name),
          version: 1,
          updatedAt: 'now',
          draft: cloneDocument(source as never, { id, name: String((body as { name: string }).name) }),
          active: null,
        }
        templates = [...templates, record]
        return jsonResponse({ ok: true, template: record })
      }
      const draftMatch = url.match(/^\/api\/labels\/documents\/([^/]+)\/draft$/)
      if (draftMatch && method === 'PUT') {
        const id = decodeURIComponent(draftMatch[1])
        const payload = body as { document: unknown; baseVersion: number }
        templates = templates.map((item) =>
          item.id === id
            ? { ...item, version: item.version + 1, draft: payload.document }
            : item,
        )
        return jsonResponse({
          ok: true,
          template: templates.find((item) => item.id === id),
          activated: false,
        })
      }
      const activateMatch = url.match(/^\/api\/labels\/documents\/([^/]+)\/activate$/)
      if (activateMatch && method === 'POST') {
        const id = decodeURIComponent(activateMatch[1])
        templates = templates.map((item) =>
          item.id === id
            ? { ...item, version: item.version + 1, active: item.draft }
            : item,
        )
        activeTemplateId = id
        return jsonResponse({
          ok: true,
          template: templates.find((item) => item.id === id),
          activated: true,
        })
      }
      const patchMatch = url.match(/^\/api\/labels\/documents\/([^/]+)$/)
      if (patchMatch && method === 'PATCH') {
        const id = decodeURIComponent(patchMatch[1])
        templates = templates.map((item) =>
          item.id === id
            ? { ...item, version: item.version + 1, name: String((body as { name: string }).name) }
            : item,
        )
        return jsonResponse({ ok: true, template: templates.find((item) => item.id === id) })
      }
      throw new Error(`beklenmeyen istek: ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function renderEditor() {
  const view = render(<LabelTemplateEditorPage orders={[ORDER]} products={[]} />)
  await screen.findByTestId('system-template-list')
  return view
}

async function createTemplateFromSystem(id = 'surat-classic-100x100') {
  await renderEditor()
  await act(async () => {
    fireEvent.click(screen.getByTestId(`system-template-${id}`))
  })
  return screen.findByTestId('label-canvas')
}

/**
 * Izgara/hizalama yakalamasını aç-kapat.
 *
 * Saf hareket testlerinde KAPATILIR: yakalama açıkken beklenen konum
 * komşu öğelerin kenarlarına bağlı olur ve test, ölçtüğü şeyi (sürükleme
 * matematiği) değil, fixture yerleşimini ölçer. Yakalamanın KENDİSİ ayrı
 * bir testte doğrulanır.
 */
async function setSnap(enabled: boolean) {
  const toggle = screen.getByTestId('editor-snap') as HTMLInputElement
  if (toggle.checked !== enabled) {
    await act(async () => {
      fireEvent.click(toggle)
    })
  }
}

function elementRect(elementId: string) {
  const node = screen.getByTestId(`label-element-${elementId}`)
  return {
    x: Number(node.getAttribute('data-x-mm')),
    y: Number(node.getAttribute('data-y-mm')),
    width: Number(node.getAttribute('data-width-mm')),
    height: Number(node.getAttribute('data-height-mm')),
  }
}

/** mm cinsinden hareketi, %100 yakınlaştırmadaki piksel karşılığına çevirir. */
function pxForMm(mm: number): number {
  return mm * BASE_PX_PER_MM
}

async function drag(elementId: string, dxMm: number, dyMm: number) {
  const node = screen.getByTestId(`label-element-${elementId}`)
  await act(async () => {
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 0, clientY: 0 })
  })
  await act(async () => {
    fireEvent.pointerMove(screen.getByTestId('label-canvas'), {
      pointerId: 1,
      clientX: pxForMm(dxMm),
      clientY: pxForMm(dyMm),
    })
  })
  await act(async () => {
    fireEvent.pointerUp(screen.getByTestId('label-canvas'), { pointerId: 1 })
  })
}

describe('görsel etiket şablonu düzenleyicisi', () => {
  it('EDITOR-DOM-01: üç bölge (tarayıcı / tuval / özellikler) görünür', async () => {
    await createTemplateFromSystem()
    expect(screen.getByTestId('system-template-list')).toBeTruthy()
    expect(screen.getByTestId('label-canvas')).toBeTruthy()
    expect(screen.getByLabelText('Öğe özellikleri')).toBeTruthy()
  })

  it('EDITOR-DOM-02: tuval GERÇEK 10×10 cm ölçüsünü taşır', async () => {
    const canvas = await createTemplateFromSystem()
    expect(canvas.getAttribute('data-width-mm')).toBe('100')
    expect(canvas.getAttribute('data-height-mm')).toBe('100')
  })

  it('EDITOR-DOM-03: sistem şablonu KOPYALANARAK özel şablon oluşur', async () => {
    await createTemplateFromSystem()
    const created = calls.filter(
      (call) => call.url === '/api/labels/documents' && call.method === 'POST',
    )
    expect(created).toHaveLength(1)
    expect(screen.getByTestId('custom-template-tpl_1')).toBeTruthy()
    // Kopyalamak YAYINLAMAZ.
    expect(calls.some((call) => call.url.includes('/activate'))).toBe(false)
  })

  it('EDITOR-DOM-04: öğe seçilince denetçi o öğeyi gösterir', async () => {
    await createTemplateFromSystem()
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('label-element-address'), {
        pointerId: 1, clientX: 0, clientY: 0,
      })
      fireEvent.pointerUp(screen.getByTestId('label-canvas'), { pointerId: 1 })
    })
    expect(screen.getByTestId('inspector-title').textContent).toBe('Adres')
  })

  it('EDITOR-DOM-05: SÜRÜKLEME öğeyi taşır (mm cinsinden, doğru yönde)', async () => {
    await createTemplateFromSystem()
    await setSnap(false)
    const before = elementRect('order-no')
    await drag('order-no', 10, 6)
    const after = elementRect('order-no')
    expect(after.x).toBe(before.x + 10)
    expect(after.y).toBe(before.y + 6)
    // Boyut DEĞİŞMEZ.
    expect(after.width).toBe(before.width)
    expect(after.height).toBe(before.height)
  })

  it('EDITOR-DOM-05b: IZGARA/HİZALAMA yakalaması açıkken kenarlar hizalanır', async () => {
    await createTemplateFromSystem()
    await setSnap(true)
    // QR x=78; diğer blokların sol kenarı x=4. Oraya YAKIN (0.4 mm sapmayla)
    // bırakıldığında yakalama tam hizaya oturtmalıdır (0.8 mm tolerans).
    await drag('qr', -73.6, 0)
    expect(elementRect('qr').x).toBe(4)
  })

  it('EDITOR-DOM-06: sürükleme TUVAL DIŞINA çıkamaz', async () => {
    await createTemplateFromSystem()
    await drag('address', -500, -500)
    const after = elementRect('address')
    expect(after.x).toBe(0)
    expect(after.y).toBe(0)
    expect(after.width).toBeGreaterThan(0)
  })

  it('EDITOR-DOM-07: BOYUTLANDIRMA tutamacı genişlik/yükseklik değiştirir', async () => {
    await createTemplateFromSystem()
    // Önce seç (tutamaçlar yalnız seçili öğede görünür).
    await drag('products', 0, 0)
    const before = elementRect('products')
    const handle = screen.getByTestId('label-handle-products-se')
    await act(async () => {
      fireEvent.pointerDown(handle, { pointerId: 2, clientX: 0, clientY: 0 })
    })
    await act(async () => {
      fireEvent.pointerMove(screen.getByTestId('label-canvas'), {
        pointerId: 2, clientX: pxForMm(-8), clientY: pxForMm(-4),
      })
    })
    await act(async () => {
      fireEvent.pointerUp(screen.getByTestId('label-canvas'), { pointerId: 2 })
    })
    const after = elementRect('products')
    expect(after.width).toBe(before.width - 8)
    expect(after.height).toBe(before.height - 4)
    // Sol üst köşe SABİT kalır (sıçrama yok).
    expect(after.x).toBe(before.x)
    expect(after.y).toBe(before.y)
  })

  it('EDITOR-DOM-08: BARKOD okunabilir asgari ölçünün altına indirilemez', async () => {
    await createTemplateFromSystem()
    await drag('barcode', 0, 0)
    const handle = screen.getByTestId('label-handle-barcode-se')
    await act(async () => {
      fireEvent.pointerDown(handle, { pointerId: 3, clientX: 0, clientY: 0 })
    })
    await act(async () => {
      fireEvent.pointerMove(screen.getByTestId('label-canvas'), {
        pointerId: 3, clientX: pxForMm(-200), clientY: pxForMm(-200),
      })
    })
    await act(async () => {
      fireEvent.pointerUp(screen.getByTestId('label-canvas'), { pointerId: 3 })
    })
    const after = elementRect('barcode')
    expect(after.width).toBeGreaterThanOrEqual(25)
    expect(after.height).toBeGreaterThanOrEqual(8)
  })

  it('EDITOR-DOM-09: sayısal X/Y alanı tuvalle SENKRON', async () => {
    await createTemplateFromSystem()
    await drag('address', 0, 0)
    await act(async () => {
      fireEvent.change(screen.getByTestId('inspector-x'), { target: { value: '20' } })
    })
    expect(elementRect('address').x).toBe(20)
    await act(async () => {
      fireEvent.change(screen.getByTestId('inspector-y'), { target: { value: '30' } })
    })
    expect(elementRect('address').y).toBe(30)
  })

  it('EDITOR-DOM-10: punto ve kalın değişikliği ilkellere yansır', async () => {
    await createTemplateFromSystem()
    await drag('address', 0, 0)
    await act(async () => {
      fireEvent.change(screen.getByTestId('inspector-font-size'), {
        target: { value: '12' },
      })
    })
    const primitive = document.querySelector('[data-element-id="address"].label-primitive-text')
    expect(primitive?.getAttribute('data-font-pt')).toBe('12')

    await act(async () => {
      fireEvent.click(screen.getByTestId('inspector-bold'))
    })
    const bolded = document.querySelector(
      '[data-element-id="address"].label-primitive-text',
    ) as HTMLElement
    expect(bolded.style.fontWeight).toBe('700')
  })

  it('EDITOR-DOM-11: KİMLİK KİLİDİ görünür ve barkoda serbest metin alanı YOK', async () => {
    await createTemplateFromSystem()
    await drag('barcode', 0, 0)
    expect(screen.getByTestId('inspector-identity-lock')).toBeTruthy()
    expect(screen.queryByTestId('inspector-text')).toBeNull()
  })

  it('EDITOR-DOM-12: GERİ AL sürüklemenin TAMAMINI tek adımda geri alır', async () => {
    await createTemplateFromSystem()
    await setSnap(false)
    const before = elementRect('order-no')
    await drag('order-no', 12, 8)
    expect(elementRect('order-no').x).toBe(before.x + 12)
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-undo'))
    })
    expect(elementRect('order-no').x).toBe(before.x)
    expect(elementRect('order-no').y).toBe(before.y)
  })

  it('EDITOR-DOM-13: YİNELE geri alınan değişikliği geri getirir', async () => {
    await createTemplateFromSystem()
    await setSnap(false)
    const before = elementRect('order-no')
    await drag('order-no', 12, 0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-undo'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-redo'))
    })
    expect(elementRect('order-no').x).toBe(before.x + 12)
  })

  it('EDITOR-DOM-14: TASLAK KAYDI yayınlamaz', async () => {
    await createTemplateFromSystem()
    await drag('address', 5, 0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-draft'))
    })
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/draft'))).toBe(true),
    )
    expect(calls.some((call) => call.url.endsWith('/activate'))).toBe(false)
    expect(screen.getByTestId('label-editor-notice').textContent).toMatch(
      /Üretimdeki etiket DEĞİŞMEDİ/,
    )
  })

  it('EDITOR-DOM-15: YAYINLA açık bir eylemdir ve aktif rozeti gösterir', async () => {
    await createTemplateFromSystem()
    await drag('address', 5, 0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-activate'))
    })
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/activate'))).toBe(true),
    )
    expect(await screen.findByTestId('badge-active-tpl_1')).toBeTruthy()
  })

  it('EDITOR-DOM-16: kaydedilmemiş değişiklik ŞABLON DEĞİŞTİRİNCE korunur', async () => {
    await createTemplateFromSystem()
    // İkinci bir şablon oluştur.
    await act(async () => {
      fireEvent.click(screen.getByTestId('system-template-minimal-ecommerce'))
    })
    await screen.findByTestId('custom-template-tpl_2')

    // İlk şablona dön ve düzenle.
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-template-tpl_1'))
    })
    await setSnap(false)
    const before = elementRect('order-no')
    await drag('order-no', 9, 0)
    expect(screen.getByTestId('editor-dirty')).toBeTruthy()

    // Diğerine geç, sonra geri dön: KAYDEDİLMEMİŞ değişiklik DURMALI.
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-template-tpl_2'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-template-tpl_1'))
    })
    expect(elementRect('order-no').x).toBe(before.x + 9)
    expect(screen.getByTestId('badge-dirty-tpl_1')).toBeTruthy()
  })

  it('EDITOR-DOM-17: gerçek sipariş verisi kullanılır (demo DEĞİL)', async () => {
    await createTemplateFromSystem()
    expect(screen.getByTestId('editor-preview-source').textContent).toMatch(
      /Gerçek sipariş: 11543590246/,
    )
    const recipient = document.querySelector('[data-element-id="recipient"]')
    expect(recipient?.textContent).toContain('Şükrü')
  })

  it('EDITOR-DOM-18: TAŞMA senaryosu muhafızları AÇIKÇA gösterir', async () => {
    await createTemplateFromSystem()
    await act(async () => {
      fireEvent.change(screen.getByTestId('editor-preview-mode'), {
        target: { value: 'stress' },
      })
    })
    // Adres kutusunu daralt: uzun adres artık SIĞMAZ.
    await drag('address', 0, 0)
    await act(async () => {
      fireEvent.change(screen.getByTestId('inspector-max-lines'), {
        target: { value: '1' },
      })
    })
    const violations = screen.getByTestId('guard-violations')
    expect(violations.textContent).toMatch(/LONG_ADDRESS_OVERFLOW_GUARD/)
  })

  it('EDITOR-DOM-19: temiz yerleşimde muhafızlar SESSİZ (gürültü yok)', async () => {
    await createTemplateFromSystem()
    expect(screen.getByTestId('guards-clean')).toBeTruthy()
  })

  it('EDITOR-DOM-20: TÜM eylemler boyunca TAŞIYICI/PAZARYERİ çağrısı = 0', async () => {
    await createTemplateFromSystem()
    await drag('address', 6, 4)
    await act(async () => {
      fireEvent.change(screen.getByTestId('inspector-font-size'), {
        target: { value: '11' },
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-save-draft'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-activate'))
    })
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/activate'))).toBe(true),
    )
    // HER çağrı yalnız şablon ucuna gitmelidir.
    for (const call of calls) {
      expect(call.url.startsWith('/api/labels/documents')).toBe(true)
    }
    expect(
      calls.some((call) =>
        /surat|shipments|orders\/sync|trendyol/i.test(call.url),
      ),
    ).toBe(false)
  })

  it('EDITOR-DOM-21: klavye ile ince ayar (ok tuşları) çalışır', async () => {
    await createTemplateFromSystem()
    const node = screen.getByTestId('label-element-address')
    const before = elementRect('address')
    await act(async () => {
      fireEvent.keyDown(node, { key: 'ArrowRight' })
    })
    expect(elementRect('address').x).toBe(before.x + 0.5)
    await act(async () => {
      fireEvent.keyDown(node, { key: 'ArrowDown', shiftKey: true })
    })
    expect(elementRect('address').y).toBe(before.y + 5)
  })

  it('EDITOR-DOM-22: yakınlaştırma FİZİKSEL geometriyi değiştirmez', async () => {
    await createTemplateFromSystem()
    const before = elementRect('address')
    await act(async () => {
      fireEvent.change(screen.getByTestId('editor-zoom'), { target: { value: '2' } })
    })
    const after = elementRect('address')
    expect(after).toEqual(before)
    expect(screen.getByTestId('label-canvas').getAttribute('data-zoom')).toBe('2')
  })
})
