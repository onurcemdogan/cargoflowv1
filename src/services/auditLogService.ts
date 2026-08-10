import type { AuditAction, AuditLevel, AuditLog } from '../types/cargoflow'
import { createId } from '../utils/ids'
import { loadFromStorage, saveToStorage } from '../utils/storage'

const STORAGE_KEY = 'cargoflow.auditLogs'

export class AuditLogService {
  load(): AuditLog[] {
    return loadFromStorage<AuditLog[]>(STORAGE_KEY, [])
  }

  append(input: {
    action: AuditAction
    level?: AuditLevel
    details: string
    orderNumber?: string
  }): AuditLog[] {
    const nextLog: AuditLog = {
      id: createId('log'),
      action: input.action,
      level: input.level ?? 'info',
      details: input.details,
      orderNumber: input.orderNumber,
      createdAt: new Date().toISOString(),
    }
    let logs = [nextLog, ...this.load()].slice(0, 100)
    // TANI/DENETİM KAYDI İŞ AKIŞINI KESMEZ: depolama kotası dolarsa yazım
    // küçültülerek yeniden denenir ve hata DIŞARI SIZMAZ. Yalnız bu
    // anahtar yönetilir (bkz. apiDebugService'teki aynı sözleşme).
    for (;;) {
      try {
        saveToStorage(STORAGE_KEY, logs)
        break
      } catch {
        if (logs.length === 0) break
        logs = logs.slice(0, Math.floor(logs.length / 2))
      }
    }
    return logs
  }

  clear(): AuditLog[] {
    try {
      saveToStorage<AuditLog[]>(STORAGE_KEY, [])
    } catch {
      // temizleme de iş akışını kesmez
    }
    return []
  }
}
