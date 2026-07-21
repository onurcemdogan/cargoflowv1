// Auth middleware'leri. organizationId YALNIZ session'dan (req.auth) gelir;
// body/query/header içindeki organizationId değerlerine asla güvenilmez.
import type { NextFunction, Request, Response } from 'express'
import {
  findActiveSession,
  sessionCookieName,
  touchSession,
  type AuthDb,
} from './session.ts'
import { isAuthBypassEnabled, resolveBypassContext } from './devBypass.ts'

export interface AuthContext {
  userId: string
  organizationId: string
  username: string
}

export interface AuthedRequest extends Request {
  auth?: AuthContext
  authSessionToken?: string
}

function readSessionToken(request: AuthedRequest): string {
  return String(request.cookies?.[sessionCookieName()] ?? '').trim()
}

// Güvenli tanılama: yalnız AUTH_DEBUG=1 iken ve YALNIZ boolean/durum bilgisi
// loglanır. Ham cookie, token, hash veya credential ASLA loglanmaz.
function authDebug(message: string): void {
  if (process.env.AUTH_DEBUG === '1') {
    console.info(`[auth] ${message}`)
  }
}

async function resolveAuth(
  db: AuthDb,
  request: AuthedRequest,
): Promise<boolean> {
  const cookiePresent = Boolean(request.cookies)
  const token = readSessionToken(request)
  if (!token) {
    authDebug(`session yok: cookieParser=${cookiePresent} token=absent`)
    return false
  }
  const context = await findActiveSession(db, token)
  if (!context) {
    authDebug('session lookup: not_found_or_inactive (expired/revoked/user-disabled/org-suspended)')
    return false
  }
  authDebug('session lookup: found_active')
  request.auth = {
    userId: context.userId,
    organizationId: context.organizationId,
    username: context.username,
  }
  request.authSessionToken = token
  void touchSession(db, context.sessionId).catch(() => undefined)
  return true
}

export function requireAuth(db: AuthDb) {
  return async (
    request: AuthedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      // TEST modu (varsayılan KAPALI): CARGOFLOW_AUTH_BYPASS=true ise istek
      // gerçek bir organization kullanıcısına bağlanır. Auth mantığı aşağıda
      // olduğu gibi durur; bayrak kapatılınca normal davranış geri gelir.
      if (isAuthBypassEnabled()) {
        request.auth = await resolveBypassContext(db)
        next()
        return
      }
      if (await resolveAuth(db, request)) {
        next()
        return
      }
      response.status(401).json({ ok: false, message: 'Oturum gerekli.' })
    } catch {
      response.status(401).json({ ok: false, message: 'Oturum gerekli.' })
    }
  }
}

export function optionalAuth(db: AuthDb) {
  return async (
    request: AuthedRequest,
    _response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      await resolveAuth(db, request)
    } catch {
      // optionalAuth hiçbir zaman isteği engellemez.
    }
    next()
  }
}
