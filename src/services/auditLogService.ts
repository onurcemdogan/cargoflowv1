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
    const logs = [nextLog, ...this.load()].slice(0, 100)
    saveToStorage(STORAGE_KEY, logs)
    return logs
  }

  clear(): AuditLog[] {
    saveToStorage<AuditLog[]>(STORAGE_KEY, [])
    return []
  }
}
