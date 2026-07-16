import type { ApiDebugLog } from '../types/cargoflow'
import { createId } from '../utils/ids'
import { loadFromStorage, saveToStorage } from '../utils/storage'

const STORAGE_KEY = 'cargoflow.apiDebugLogs.v1'

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
    const logs = [log, ...this.load()].slice(0, 300)
    saveToStorage(STORAGE_KEY, logs)
    return logs
  }

  clear(): ApiDebugLog[] {
    saveToStorage<ApiDebugLog[]>(STORAGE_KEY, [])
    return []
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
