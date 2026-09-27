// ARAS ETİKET ARTEFAKTI — KALICI DEPO KATMANI (ağ YOK, yalnız DB).
//
// KAYNAK: `aras_label_artifacts` (organization_id, integration_code) UNIQUE.
// Şifreleme Sürat'ın `shipments.carrier_payload_encrypted` yolundaki AYNI
// zarfı (`shipmentEncryption.ts`, AES-256-GCM) kullanır — ikinci bir
// kriptografi YAZILMAZ.
//
// ═══ İLK YAZIM KAZANIR — SESSİZ ÜZERİNE YAZMA YOK ═══════════════════════
// Bir integrationCode için artefakt bir kez yazılınca KİLİTLENİR. İkinci bir
// `persist` çağrısı (ör. eşzamanlı retry) mevcut kaydı DEĞİŞTİRMEZ; yalnızca
// zaten kalıcı olduğunu bildirir. Bu, reprint'in her zaman İLK GERÇEK
// GetBarcode yanıtını döndürmesini garanti eder.
import { and, eq } from 'drizzle-orm'
import { arasLabelArtifacts } from '../../db/schema.ts'
import {
  decryptShipmentPayload,
  encryptShipmentPayload,
} from '../../shipments/shipmentEncryption.ts'
import {
  ARAS_LABEL_ARTIFACT_TYPES,
  type ArasLabelArtifact,
  type ArasLabelArtifactType,
} from './arasLabelArtifact.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface ArasLabelArtifactStore {
  /** Kayıt zaten varsa DOKUNMAZ; yalnız İLK çağrı gerçekten yazar. */
  persist(
    organizationId: string,
    integrationCode: string,
    artifact: ArasLabelArtifact,
  ): Promise<boolean>
  /** Taşıyıcıya GİTMEDEN yalnız kalıcı kayıttan okur; yoksa null. */
  load(
    organizationId: string,
    integrationCode: string,
  ): Promise<ArasLabelArtifact | null>
}

function isArtifactType(value: unknown): value is ArasLabelArtifactType {
  return (ARAS_LABEL_ARTIFACT_TYPES as readonly string[]).includes(
    value as string,
  )
}

function decodeArtifact(raw: string | null): ArasLabelArtifact | null {
  const payload = (decryptShipmentPayload(raw) ?? {}) as Record<
    string,
    unknown
  >
  const content = payload.content
  const type = payload.type
  const encoding = payload.encoding
  if (typeof content !== 'string' || !content.trim()) return null
  if (!isArtifactType(type)) return null
  if (encoding !== 'text' && encoding !== 'base64') return null
  return { type, content, encoding }
}

async function loadRow(db: Db, organizationId: string, integrationCode: string) {
  const rows = await db
    .select()
    .from(arasLabelArtifacts)
    .where(
      and(
        eq(arasLabelArtifacts.organizationId, organizationId),
        eq(arasLabelArtifacts.integrationCode, integrationCode),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

/** Gerçek, kalıcı (Postgres) uygulama — üretim yolu budur. */
export function createDbArasLabelArtifactStore(db: Db): ArasLabelArtifactStore {
  return {
    async persist(organizationId, integrationCode, artifact) {
      const existing = await loadRow(db, organizationId, integrationCode)
      if (existing) return false
      const artifactEncrypted = encryptShipmentPayload({ ...artifact })
      // Eşzamanlı ikinci yazım UNIQUE ihlaliyle reddedilir (ilk kazanır).
      try {
        const result = await db
          .insert(arasLabelArtifacts)
          .values({ organizationId, integrationCode, artifactEncrypted })
          .onConflictDoNothing({
            target: [
              arasLabelArtifacts.organizationId,
              arasLabelArtifacts.integrationCode,
            ],
          })
          .returning({ id: arasLabelArtifacts.id })
        return Array.isArray(result) ? result.length > 0 : false
      } catch {
        return false
      }
    },
    async load(organizationId, integrationCode) {
      const row = await loadRow(db, organizationId, integrationCode)
      if (!row) return null
      return decodeArtifact((row.artifactEncrypted ?? null) as string | null)
    },
  }
}

export const __testing = { decodeArtifact }
