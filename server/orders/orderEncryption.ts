// Order domaini için versioned envelope encryption (AES-256-GCM). Ayrı
// ORDER_DATA_ENCRYPTION_KEY tercih edilir; yoksa ortak CREDENTIAL_ENCRYPTION_KEY.
// PII (adres) ve raw payload şifreli tutulur; secret/PII loglanmaz.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const CURRENT_KEY_VERSION = 1

function decodeKey(raw: string): Buffer | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const candidates: Buffer[] = []
  if (/^[0-9a-fA-F]{64}$/.test(value)) candidates.push(Buffer.from(value, 'hex'))
  try {
    candidates.push(Buffer.from(value, 'base64'))
  } catch {
    // yok say
  }
  return candidates.find((buffer) => buffer.length === 32) ?? null
}

function getOrderKey(): Buffer {
  const key =
    decodeKey(process.env.ORDER_DATA_ENCRYPTION_KEY ?? '') ??
    decodeKey(process.env.CREDENTIAL_ENCRYPTION_KEY ?? '')
  if (!key) {
    throw new Error(
      'ORDER_DATA_ENCRYPTION_KEY (veya CREDENTIAL_ENCRYPTION_KEY) 32 byte olmalı (base64/hex).',
    )
  }
  return key
}

export function isOrderEncryptionConfigured(): boolean {
  try {
    getOrderKey()
    return true
  } catch {
    return false
  }
}

interface Envelope {
  v: number
  iv: string
  tag: string
  data: string
}

export function encryptOrderPayload(
  payload: unknown | null | undefined,
): string | null {
  if (payload == null) return null
  const key = getOrderKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ])
  const envelope: Envelope = {
    v: CURRENT_KEY_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  }
  return JSON.stringify(envelope)
}

export function decryptOrderPayload(
  encrypted: string | null | undefined,
): unknown {
  if (!encrypted) return null
  const key = getOrderKey()
  const envelope = JSON.parse(encrypted) as Envelope
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8'))
}
