const STORAGE_KEYS = [
  'cargoflow.integrationConfig',
  'cargoflow.printerSettings',
  'cargoflow.labelTemplate',
]

export async function migrateAlternateLoopbackStorage(): Promise<boolean> {
  const currentHost = window.location.hostname.toLocaleLowerCase('en-US')
  if (!['127.0.0.1', 'localhost'].includes(currentHost)) return false

  const alternateOrigin =
    currentHost === '127.0.0.1'
      ? 'http://localhost:5173'
      : 'http://127.0.0.1:5173'

  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.hidden = true
    iframe.src = `${alternateOrigin}/storage-bridge.html`
    let settled = false

    const finish = (migrated: boolean) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', handleMessage)
      iframe.remove()
      resolve(migrated)
    }

    const handleMessage = (event: MessageEvent) => {
      if (
        event.origin !== alternateOrigin ||
        event.data?.type !== 'CARGOFLOW_STORAGE_RESPONSE'
      ) {
        return
      }
      const values = event.data.values as Record<string, string | null>
      let migrated = false
      for (const key of STORAGE_KEYS) {
        if (!window.localStorage.getItem(key) && values?.[key]) {
          window.localStorage.setItem(key, values[key])
          migrated = true
        }
      }
      finish(migrated)
    }

    window.addEventListener('message', handleMessage)
    iframe.addEventListener('load', () => {
      iframe.contentWindow?.postMessage(
        { type: 'CARGOFLOW_STORAGE_REQUEST' },
        alternateOrigin,
      )
    })
    iframe.addEventListener('error', () => finish(false))
    document.body.appendChild(iframe)
    window.setTimeout(() => finish(false), 1500)
  })
}
