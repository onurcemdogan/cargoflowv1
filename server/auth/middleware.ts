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

type ResolveOutcome = 'ok' | 'none' | 'workspace_required'

async function resolveAuth(
  db: AuthDb,
  request: AuthedRequest,
): Promise<ResolveOutcome> {
  const cookiePresent = Boolean(request.cookies)
  const token = readSessionToken(request)
  if (!token) {
    authDebug(`session yok: cookieParser=${cookiePresent} token=absent`)
    return 'none'
  }
  const context = await findActiveSession(db, token)
  if (!context) {
    authDebug('session lookup: not_found_or_inactive (expired/revoked/user-disabled/org-suspended)')
    return 'none'
  }
  // Workspace'i olmayan oturum kiracı verisine ERİŞEMEZ: `request.auth`
  // hiç kurulmaz, böylece organizationId'ye dayanan HİÇBİR uç çalışmaz.
  if (!context.organizationId) {
    authDebug('session lookup: found_without_workspace')
    return 'workspace_required'
  }
  authDebug('session lookup: found_active')
  request.auth = {
    userId: context.userId,
    organizationId: context.organizationId,
    username: context.username,
  }
  request.authSessionToken = token
  void touchSession(db, context.sessionId).catch(() => undefined)
  return 'ok'
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
      const outcome = await resolveAuth(db, request)
      if (outcome === 'ok') {
        next()
        return
      }
      if (outcome === 'workspace_required') {
        response.status(403).json({
          ok: false,
          code: 'WORKSPACE_REQUIRED',
          message: 'Devam etmek için önce çalışma alanınızı oluşturun.',
        })
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
