import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LabelTemplatesPage } from '../pages/LabelTemplatesPage'
import { IDENTITY_LOCKED_LABEL_FIELDS } from '../types/cargoflow'
import type { CargoOrder, LabelTemplate } from '../types/cargoflow'

// ═══ KODSUZ ETİKET DÜZENLEYİCİ — MÜŞTERİ HİKÂYELERİ ══════════════════════
//
// Bu paketin amacı tek cümle: aşağıdaki istekler KAYNAK KODU DEĞİŞTİRMEDEN
// karşılanabiliyor mu? Her hikâye gerçek düzenleyici arayüzü üzerinden
// sürülür — kurgusal bir yardımcı üzerinden DEĞİL.
//
// Taşıyıcı kimliği (barkod/QR/takip no) DEĞERİ hiçbir kontrolle
// değiştirilemez; yalnız sunumu ayarlanır.

const template: LabelTemplate = {
  id: 'custom', name: 'Özel Şablon',
  widthMm: 100, heightMm: 100, widthDots: 799, heightDots: 799,
  barcodeX: 48, barcodeY: 300, barcodeModuleWidth: 2, barcodeHeight: 90,
  fontSize: 20, lineGap: 6, fieldStartX: 40, fieldStartY: 60,
  fields: [], updatedAt: '2026-08-26T00:00:00.000Z',
}

// Sipariş tarihi YEREL biçimde verilir (sondaki `Z` YOK): saat çıktısı
// çalıştıran makinenin saat diliminden BAĞIMSIZ olsun.
const ORDERED_AT = '2026-08-26T09:15:00'

const orders: CargoOrder[] = [{
  id: 'o1', orderNumber: '11543590246', packageId: '4108176742',
  marketplace: 'Trendyol',
  customerName: 'Alici Adsoyad',
  customerFirstName: 'Alici', customerLastName: 'Adsoyad',
  status: 'Picking', createdAt: ORDERED_AT, orderDate: ORDERED_AT,
  items: [{
    id: 'i1', productName: 'Ürün A', quantity: 2,
    sku: 'SKU-1', color: 'Siyah', size: 'M',
  }],
} as unknown as CargoOrder]

function renderEditor(stored: LabelTemplate = template) {
  const onSave = vi.fn()
  const view = render(
    <LabelTemplatesPage template={stored} orders={orders} onSave={onSave} />,
  )
  return { onSave, view }
}

/** Şablonu kaydeden birincil düğme. */
const save = () =>
  fireEvent.click(screen.getByRole('button', { name: /Özel Şablonu Kullan/i }))

/** Son kaydedilen şablon. */
const savedTemplate = (onSave: ReturnType<typeof vi.fn>) =>
  onSave.mock.calls.at(-1)?.[0] as LabelTemplate

/** Bir blok satırını Türkçe etiketinden bulur. */
function fieldRow(label: string): HTMLElement {
  const checkbox = screen.getByLabelText(label, { exact: true })
  const row = checkbox.closest('.template-field-row')
  if (!row) throw new Error(`blok satiri bulunamadi: ${label}`)
  return row as HTMLElement
}

/** Önizlemede basılan kiracı bloğu (baskı ZPL'iyle AYNI çözümleyici). */
const previewBlock = (key: string) =>
  document.querySelector(`.surat-tenant-block[data-block="${key}"]`)

/** Son kaydedilen şablondaki blok yapılandırması. */
const savedField = (onSave: ReturnType<typeof vi.fn>, key: string) =>
  savedTemplate(onSave)?.fields?.find((field) => field.key === key)

describe('Etiket Şablonları — kodsuz düzenleyici', () => {
  it('HIKAYE-1: sipariş saati kod degisikligi OLMADAN acilir', () => {
    const { onSave } = renderEditor()
    const row = fieldRow('Sipariş Saati')
    const visible = within(row).getByLabelText('Sipariş Saati')
    expect((visible as HTMLInputElement).checked).toBe(false)
    expect(previewBlock('orderTime')).toBeNull()
    fireEvent.click(visible)
    // ÖNİZLEME kaydetmeden GÜNCELLENİR ve saat DOĞRU biçimde görünür.
    expect(previewBlock('orderTime')?.textContent).toBe('09:15')
    save()
    expect(savedField(onSave, 'orderTime')?.visible).toBe(true)
  })

  it('HIKAYE-2: satin alan adi ALTTA ve BUYUK yapilandirilir', () => {
    const { onSave } = renderEditor()
    const row = fieldRow('Satın Alan Adı')
    fireEvent.click(within(row).getByLabelText('Satın Alan Adı'))
    fireEvent.change(within(row).getByRole('spinbutton'), {
      target: { value: '48' },
    })
    fireEvent.click(within(row).getByLabelText('Kalın'))
    fireEvent.change(within(row).getByRole('combobox'), {
      target: { value: 'bottom' },
    })
    // ÖNİZLEME: satın alan ALTTA, BÜYÜK ve KALIN görünür.
    const rendered = previewBlock('buyerName') as HTMLElement
    expect(rendered?.textContent).toBe('Alici Adsoyad')
    expect(rendered.className).toContain('surat-tenant-bottom')
    expect(rendered.style.fontWeight).toBe('700')
    // ÖNİZLEME ÖLÇEĞİ BASKIYLA TUTARLI: etiket 799 dot'u 500 px'e yerleştirir,
    // yani 48 dot ≈ 30 px. Kestirme bir 0,5 oranı blokları baskıdakinden
    // ~%20 küçük gösterir ve operatör puntoyu gözüyle yanlış ayarlardı.
    expect(Number.parseInt(rendered.style.fontSize, 10)).toBe(
      Math.round(48 * (500 / 799)),
    )
    save()

    const saved = savedField(onSave, 'buyerName')
    expect(saved?.visible).toBe(true)
    expect(saved?.fontSize).toBe(48)
    expect(saved?.bold).toBe(true)
    expect(saved?.placement).toBe('bottom')
  })

  it('HIKAYE-3: SKU gizlenir, varyant ve adet urun satirinda KALIR', () => {
    const { onSave } = renderEditor()
    const productLine = () =>
      document.querySelector('.surat-product-section')?.textContent ?? ''

    // Baslangicta ürün satiri bugünkü biçimindedir.
    expect(productLine()).toContain('2 x Ürün A')
    expect(productLine()).toContain('(Renk: Siyah, Beden: M)')
    expect(productLine()).toContain('[SKU-1]')

    // Operatör YALNIZ SKU'yu kapatir.
    fireEvent.click(within(fieldRow('SKU')).getByLabelText('SKU'))

    // ÖNIZLEME: SKU gitti, varyant ve adet DURUYOR. Sarkan "[]" YOK.
    expect(productLine()).not.toContain('[SKU-1]')
    expect(productLine()).not.toContain('[]')
    expect(productLine()).toContain('(Renk: Siyah, Beden: M)')
    expect(productLine()).toContain('2 x Ürün A')

    save()
    expect(savedField(onSave, 'sku')?.visible).toBe(false)
    expect(savedField(onSave, 'variant')?.visible).toBe(true)
    expect(savedField(onSave, 'quantity')?.visible).toBe(true)
  })

  it('HIKAYE-3b: adet kapatilinca "2 x" oneki DUSER', () => {
    renderEditor()
    const productLine = () =>
      document.querySelector('.surat-product-section')?.textContent ?? ''
    fireEvent.click(within(fieldRow('Adet')).getByLabelText('Adet'))
    expect(productLine()).not.toContain('2 x')
    expect(productLine()).toContain('Ürün A')
  })

  it('HIKAYE-4: adres TASIYICININ metnidir — sahte punto dugmesi SUNULMAZ', () => {
    // DÜRÜSTLÜK KURALI: Sürat etiketinde adresi TAŞIYICI basar. Puntosunu
    // değiştiremeyiz; oraya çalışmayan bir düğme koymak operatöre yalan
    // bir yetki gösterirdi. Bunun yerine satır açıkça işaretlenir.
    renderEditor()
    const row = fieldRow('Adres')
    expect(within(row).queryByRole('spinbutton')).toBeNull()
    expect(within(row).getByText(/taşıyıcı basar/i)).toBeTruthy()
    // Operatörün etikete GERÇEKTEN yazdırabildiği bloklarda punto vardır.
    expect(
      within(fieldRow('Satın Alan Adı')).getByRole('spinbutton'),
    ).toBeTruthy()
  })

  it('KAPASITE: sigmayacak sablon URETIME ALINMADAN once uyarilir', () => {
    renderEditor()
    expect(screen.queryByRole('status')).toBeNull()
    for (const label of ['Satın Alan Adı', 'Sipariş Tarihi', 'Sipariş Saati']) {
      const row = fieldRow(label)
      fireEvent.click(within(row).getByLabelText(label))
      fireEvent.change(within(row).getByRole('spinbutton'), {
        target: { value: '40' },
      })
    }
    expect(screen.getByRole('status').textContent).toMatch(/BASILMAZ/)
  })

  it('KILIT: tasiyici kimlik bloklarinin DEGERI de SUNUMU da duzenlenemez', () => {
    renderEditor()
    for (const label of ['Barkod', 'QR', 'Takip No']) {
      const row = fieldRow(label)
      // Serbest METIN girisi YOK: barkod degeri packageId/orderNumber/
      // rastgele bir jetona cevrilemez.
      expect(within(row).queryAllByRole('textbox')).toHaveLength(0)
      // Sunum kontrolu de YOK: bu metinleri biz basmiyoruz.
      expect(within(row).queryByRole('spinbutton')).toBeNull()
      expect(within(row).queryByRole('combobox')).toBeNull()
      expect(within(row).getByText(/değeri kilitli/i)).toBeTruthy()
    }
    expect(IDENTITY_LOCKED_LABEL_FIELDS).toContain('shipmentCode')
  })

  it('KALICILIK: kaydedilen sunum ayarlari yeniden yuklemede KORUNUR', () => {
    const { onSave } = renderEditor()
    const row = fieldRow('Satın Alan Adı')
    fireEvent.click(within(row).getByLabelText('Satın Alan Adı'))
    fireEvent.change(within(row).getByRole('spinbutton'), {
      target: { value: '48' },
    })
    fireEvent.click(within(row).getByLabelText('Kalın'))
    fireEvent.change(within(row).getByRole('combobox'), {
      target: { value: 'bottom' },
    })
    save()

    // Kaydedilen sablon geri yuklendiginde ayarlar DUZENLEYICIDE durur —
    // aksi halde musteri her acilista bastan ayar yapmak zorunda kalir.
    const persisted = savedTemplate(onSave)
    cleanup()
    renderEditor(persisted)
    const reloaded = fieldRow('Satın Alan Adı')
    expect(
      (within(reloaded).getByLabelText('Satın Alan Adı') as HTMLInputElement)
        .checked,
    ).toBe(true)
    expect((within(reloaded).getByRole('spinbutton') as HTMLInputElement).value)
      .toBe('48')
    expect((within(reloaded).getByLabelText('Kalın') as HTMLInputElement).checked)
      .toBe(true)
    expect((within(reloaded).getByRole('combobox') as HTMLSelectElement).value)
      .toBe('bottom')
  })

  it('ONIZLEME: duzenleme sirasinda tasiyici/pazaryeri cagrisi YOK', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { onSave } = renderEditor()
    fireEvent.click(within(fieldRow('Sipariş Saati')).getByLabelText('Sipariş Saati'))
    fireEvent.click(screen.getAllByRole('button', { name: /Önizleme/i })[0])
    // Onizleme ve duzenleme YEREL: gonderi olusmaz, tasiyiciya gidilmez.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

// ═══ CIHAZLAR ARASI: SUNUCU OTORITER ═══════════════════════════════════
//
// KUSUR: `defaultLabelTemplate.fields` eski 11 blogu tasir. Sunucudan gelen
// ayarlar YALNIZ yerel listeyle KESISTIRILSEYDI, A cihazinda ayarlanan
// "Satin Alan Adi" B cihazinda (localStorage bos) SESSIZCE duserdi — sunucu
// ve baski o blogu bilirken duzenleyici bilmezdi.
describe('Sablon senkronu — sunucu otoriter', () => {
  it('yerel katalogda OLMAYAN sunucu bloklari da YUKLENIR', async () => {
    const { IntegrationConfigService } = await import(
      '../services/integrationConfigService'
    )
    const service = new IntegrationConfigService() as unknown as {
      isAuthMode: () => boolean
      fetchLabelTemplate: () => Promise<LabelTemplate | null>
    }
    const authSpy = vi.spyOn(service, 'isAuthMode').mockReturnValue(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        template: {
          version: 3,
          updatedAt: '2026-08-27T10:00:00.000Z',
          fields: [
            {
              key: 'buyerName', label: 'Satın Alan Adı', visible: true,
              order: 1, fontSize: 44, bold: true, placement: 'bottom',
            },
          ],
        },
      }),
    } as unknown as Response)

    const merged = await service.fetchLabelTemplate()
    const buyer = merged?.fields?.find((field) => field.key === 'buyerName')
    expect(buyer).toBeTruthy()
    expect(buyer?.visible).toBe(true)
    expect(buyer?.fontSize).toBe(44)
    expect(buyer?.bold).toBe(true)
    expect(buyer?.placement).toBe('bottom')

    authSpy.mockRestore()
    fetchSpy.mockRestore()
  })
})
