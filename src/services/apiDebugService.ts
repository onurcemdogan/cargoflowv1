import type { ApiDebugLog } from '../types/cargoflow'
import { createId } from '../utils/ids'
import { loadFromStorage, saveToStorage } from '../utils/storage'

const STORAGE_KEY = 'cargoflow.apiDebugLogs.v1'

/**
 * TANI KAYDI İŞ AKIŞINI ASLA KESMEZ.
 *
 * ÜRETİM HATASI (kanıtlandı): `printLabels` içinde tanı kaydı
 * `persistLabelPrinted`ten ÖNCE yazılıyor. Depolama kotası dolduğunda
 * `localStorage.setItem` QuotaExceededError fırlatıyor, bu hata
 * `printLabels`'ı terk ettiriyor ve POST /api/orders/:id/label-printed
 * HİÇ GÖNDERİLMİYORDU — fiziksel etiket basılmasına rağmen sipariş
 * "Etiket Hazır"da kalıyordu.
 *
 * İki katmanlı koruma:
 *   1) SINIRLI SAKLAMA: kayıt sayısı VE serileştirilmiş boyut bütçesi.
 *      Eski kayıtlar FIFO olarak düşer (yeni kayıt en başta durur).
 *   2) FAIL-SAFE YAZIM: kota yine de dolarsa yazım küçültülerek yeniden
 *      denenir; hiçbir durumda DIŞARI HATA SIZMAZ.
 *
 * YALNIZ kendi anahtarı yönetilir. `localStorage.clear()` ÇAĞRILMAZ,
 * başka uygulama anahtarlarına DOKUNULMAZ.
 */
const MAX_ENTRIES = 300
/** ~0,5 MB. Tipik 5 MB kotayı diğer anahtarlarla paylaşırız. */
const MAX_SERIALIZED_CHARS = 512_000

export class ApiDebugService {
  load(): ApiDebugLog[] {
    return loadFromStorage<ApiDebugLog[]>(STORAGE_KEY, [])
  }

  append(input: Omit<ApiDebugLog, 'id' | 'timestamp'>): ApiDebugLog[] {
    const log: ApiDebugLog = {
      ...input,
      id: createId('api'),
      timestamp: new Date().toISOString(),
      requestHeaders: redact(input.requestHeaders),
      requestBody: redact(input.requestBody),
      responseBody: redact(input.responseBody),
      rawResponse: redact(input.rawResponse),
      fields: redact(input.fields) as Record<string, unknown> | undefined,
    }
    return this.persist([log, ...this.load()])
  }

  clear(): ApiDebugLog[] {
    return this.persist([])
  }

  /**
   * Sınırlar içinde yazar ve ASLA fırlatmaz. Dönen liste GERÇEKTEN
   * saklanan listedir (çağıran bellekte gerçekle uyumlu kalır).
   */
  private persist(input: ApiDebugLog[]): ApiDebugLog[] {
    // 1) Kayıt sayısı sınırı — en yeniler başta.
    let logs = input.slice(0, MAX_ENTRIES)
    // 2) Boyut bütçesi — sığana kadar EN ESKİLER düşer.
    while (
      logs.length > 0 &&
      JSON.stringify(logs).length > MAX_SERIALIZED_CHARS
    ) {
      logs = logs.slice(0, Math.max(1, Math.ceil(logs.length / 2)))
      if (logs.length === 1) break
    }
    // 3) Yine de kota dolarsa küçülterek yeniden dene; hata SIZMAZ.
    for (;;) {
      try {
        saveToStorage(STORAGE_KEY, logs)
        return logs
      } catch {
        if (logs.length === 0) return []
        logs = logs.slice(0, Math.floor(logs.length / 2))
      }
    }
  }
}

export const apiDebugService = new ApiDebugService()

function redact<T>(value: T): T {
  if (value == null) return value
  if (typeof value === 'string') {
    return value
      .replace(
        /<(Sifre|WebPassword|ApiSecret)>[\s\S]*?<\/\1>/gi,
        '<$1>***</$1>',
      )
      .replace(
        /"(sifre|password|apiSecret|apiKey)"\s*:\s*"[^"]*"/gi,
        '"$1":"***"',
      ) as T
  }
  if (Array.isArray(value)) return value.map((item) => redact(item)) as T
  if (typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /sifre|secret|password|authorization|apikey/i.test(key)
        ? '***'
        : redact(item),
    ]),
  ) as T
}
