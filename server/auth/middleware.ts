// Auth middleware'leri. organizationId YALNIZ session'dan (req.auth) gelir;
// body/query/header içindeki organizationId değerlerine asla güvenilmez.
import type { NextFunction, Request, Response } from 'express'
import {
  findActiveSession,
  sessionCookieName,
  touchSession,
  type AuthDb,
} from './session.ts'

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

async function resolveAuth(
  db: AuthDb,
  request: AuthedRequest,
): Promise<boolean> {
  const token = readSessionToken(request)
  if (!token) return false
  const context = await findActiveSession(db, token)
  if (!context) return false
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
