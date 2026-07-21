// Platform admin middleware. Yetki YALNIZ geçerli admin session cookie'sinden
// gelir; body/query/header/organization user/frontend flag'inden ASLA alınmaz.
// Organization requireAuth ile karıştırılmaz (ayrı cookie, ayrı tablo).
import type { NextFunction, Request, Response } from 'express'
import {
  adminSessionCookieName,
  findActiveAdminSession,
  touchAdminSession,
  type AdminDb,
} from './adminSession.ts'
import { isAuthBypassEnabled } from '../auth/devBypass.ts'

// Bypass modunda gerçek bir platform_admins kaydı yoktur; audit log adminId
// alanı nullable olduğundan null kullanılır (uuid cast hatası oluşmaz).
const BYPASS_ADMIN_ID = null

export interface PlatformAdminContext {
  // Bypass modunda null olabilir (gerçek admin kaydı yok).
  adminId: string | null
  username: string
}

export interface AdminRequest extends Request {
  platformAdmin?: PlatformAdminContext
  adminSessionToken?: string
}

function readAdminToken(request: AdminRequest): string {
  return String(request.cookies?.[adminSessionCookieName()] ?? '').trim()
}

async function resolveAdmin(db: AdminDb, request: AdminRequest): Promise<boolean> {
  const token = readAdminToken(request)
  if (!token) return false
  const context = await findActiveAdminSession(db, token)
  if (!context) return false
  request.platformAdmin = {
    adminId: context.adminId,
    username: context.username,
  }
  request.adminSessionToken = token
  void touchAdminSession(db, context.sessionId).catch(() => undefined)
  return true
}

export function requirePlatformAdmin(db: AdminDb) {
  return async (
    request: AdminRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      // TEST modu (varsayılan KAPALI): CARGOFLOW_AUTH_BYPASS=true iken admin
      // paneli parolasız açılır; böylece gerçek organization/kullanıcı
      // hesaplarını oluşturup ardından bypass'ı kapatabilirsiniz.
      if (isAuthBypassEnabled()) {
        request.platformAdmin = { adminId: BYPASS_ADMIN_ID, username: 'bypass-admin' }
        next()
        return
      }
      if (await resolveAdmin(db, request)) {
        next()
        return
      }
      response
        .status(401)
        .json({ ok: false, message: 'Platform yönetici oturumu gerekli.' })
    } catch {
      response
        .status(401)
        .json({ ok: false, message: 'Platform yönetici oturumu gerekli.' })
    }
  }
}
