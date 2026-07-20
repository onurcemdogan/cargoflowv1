// Platform admin denetim günlüğü. Parola/credential/müşteri verisi/secret
// KAYDEDİLMEZ — yalnız aksiyon, hedef kimlik (id) ve güvenli metadata (durum
// geçişi gibi). Kayıt best-effort'tur; asıl işlemi bloke etmez.
import { platformAdminAuditLogs } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type AdminAuditAction =
  | 'organization_created'
  | 'organization_suspended'
  | 'organization_activated'
  | 'user_disabled'
  | 'user_enabled'
  | 'password_reset'
  | 'sessions_revoked'

export async function recordAdminAudit(
  db: Db,
  entry: {
    adminId: string | null
    action: AdminAuditAction
    targetOrganizationId?: string | null
    targetUserId?: string | null
    metadata?: Record<string, unknown> | null
  },
): Promise<void> {
  try {
    await db.insert(platformAdminAuditLogs).values({
      adminId: entry.adminId,
      action: entry.action,
      targetOrganizationId: entry.targetOrganizationId ?? null,
      targetUserId: entry.targetUserId ?? null,
      // Güvenli metadata yalnızca: durum geçişi, sayaçlar vb. Secret/PII yok.
      metadataJson: entry.metadata ?? null,
    })
  } catch {
    // audit best-effort; asıl admin işlemini bozmaz
  }
}
