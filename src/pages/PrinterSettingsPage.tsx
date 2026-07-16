import { Save } from 'lucide-react'
import { useState } from 'react'
import { ActionResult } from '../components/ActionResult'
import { PageHeader } from '../components/PageHeader'
import type { PrinterSettings, WorkflowResult } from '../types/cargoflow'

interface PrinterSettingsPageProps {
  settings: PrinterSettings
  result?: WorkflowResult
  onSave: (settings: PrinterSettings) => void
}

export function PrinterSettingsPage({
  settings,
  result,
  onSave,
}: PrinterSettingsPageProps) {
  const [form, setForm] = useState<PrinterSettings>(settings)

  return (
    <>
      <PageHeader
        title="Yazıcı Ayarları"
        description="Sürat BarcodeRaw ZPL indirme ve Windows RAW Zebra yazdırma ayarlarını yönet."
      />

      <ActionResult result={result} />

      <form
        className="panel settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          onSave(form)
        }}
      >
        <label>
          <span>Yazıcı adı</span>
          <input
            value={form.printerName}
            onChange={(event) =>
              setForm({ ...form, printerName: event.target.value })
            }
            placeholder="Zebra ZD220"
          />
        </label>
        <label>
          <span>Yazdırma modu</span>
          <select
            value={form.mode}
            onChange={(event) =>
              setForm({
                ...form,
                mode: event.target.value as PrinterSettings['mode'],
              })
            }
          >
            <option value="browser-print">
              Chrome temiz etiket önizlemesi
            </option>
            <option value="download">ZPL/PDF indir</option>
            <option value="local-agent">Windows RAW Zebra yazdırma</option>
          </select>
        </label>
        <label>
          <span>Etiket ölçüsü</span>
          <select
            value={form.labelSize}
            onChange={(event) =>
              setForm({
                ...form,
                labelSize: event.target.value as PrinterSettings['labelSize'],
              })
            }
          >
            <option value="100x100">100x100</option>
            <option value="100x150">100x150</option>
          </select>
        </label>
        <label>
          <span>Varsayılan format</span>
          <select
            value={form.defaultFormat}
            onChange={(event) =>
              setForm({
                ...form,
                defaultFormat: event.target
                  .value as PrinterSettings['defaultFormat'],
              })
            }
          >
            <option value="zpl">ZPL</option>
            <option value="pdf">PDF altyapısı hazır</option>
          </select>
        </label>

        <div className="form-footer">
          <button type="submit" className="primary-button">
            <Save size={18} />
            Yazıcı Ayarlarını Kaydet
          </button>
        </div>
      </form>
    </>
  )
}
