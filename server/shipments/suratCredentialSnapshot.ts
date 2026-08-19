// SÜRAT KİMLİK ANLIK GÖRÜNTÜSÜ — TEK OTORİTE, DEĞİŞMEZ.
//
// ═══ ÖLÇÜLEN ÜRETİM KUSURU ═══════════════════════════════════════════════
//
// Kanonik create adaptörü kimliği İKİ kez çözüyordu:
//   `resolveSuratCredentialContext({ config: params.config })`   (satır 328)
//   `resolveCanonicalTenantSuratAccount(params.config, ...)`     (satır 445)
//
// ve `params.config` şuydu:
//   config: request.body?.config?.surat ?? request.body?.config ?? {}
//
// yani **İSTEMCİNİN GÖNDERDİĞİ GÖVDE**. Adaptör kiracının SAKLANMIŞ
// kimliğini HİÇ okumuyordu (`loadOrganizationIntegrationConfig` çağrısı YOK).
//
// Sonuç ölçüldü:
//   canary/dry-run (kiracı deposundan)  → LEN10:****2622
//   canlı create   (istek gövdesinden)  → LEN10:****0944
//
// Parite kapısı bu ayrışmayı GÖREMEZ: aynı istemci gövdesinin İKİ ayrı
// çözümlemesini karşılaştırıyordu, bu yüzden `resolverAccountFingerprint ==
// wireAccountFingerprint` çıkıyor ve kapı GEÇİYORDU.
//
// GÜVENLİK SONUCU: istemci, gönderinin HANGİ CARİYE yazılacağını
// belirleyebiliyordu. Yanlış cariye yazılan gönderi geri alınamaz.
//
// ═══ SÖZLEŞME ════════════════════════════════════════════════════════════
// Bir denemede TEK otoriter kimlik anlık görüntüsü vardır. Kaynağı YALNIZ
// kiracı deposudur. İstek gövdesi, ortam değişkeni ve legacy config kimlik
// ALANI KATKISI YAPAMAZ. Anlık görüntü alındıktan SONRA yeniden çözümleme
// YOKTUR.

import { accountFingerprint } from './suratRoutingModel.ts'
import { deriveCanonicalPrimaryAccount } from './suratCanonicalServiceMode.mjs'

/**
 * OTORİTER KİRACI DEPOSU — TEK NORMALİZASYON YOLU.
 *
 * ═══ ÖLÇÜLEN İKİNCİ KUSUR (CF-4088678590) ═══════════════════════════════
 *
 * `loadOrganizationIntegrationConfig` ŞİFRESİ ÇÖZÜLMÜŞ **HAM** kaydı döner.
 * `canonicalPrimary*` alanları o kayıtta YOKTUR — onlar türetmede DOĞAR
 * (`deriveCanonicalPrimaryAccount`: canonicalPrimary → live → kullaniciAdi
 * → cariKodu).
 *
 * Canlı create yolu ham kaydı doğrudan anlık görüntüye veriyordu, bu yüzden
 * `canonicalPrimaryKullaniciAdi` bulunamıyor ve kimlik ÇÖZÜLEMEDİ sayılıyordu:
 *   credentialResolved=false · PRIMARY_CREDENTIAL_NOT_CONFIGURED
 *   carrierCalled=false · NETWORK_CALLS=0
 * Oysa canary AYNI kiracıda `LEN10:****2622` çözüyordu — çünkü canary
 * türetmeyi UYGULUYORDU.
 *
 * Canary'nin kendi yorumu bunu zaten öngörmüştü: "Ön kontrol normalizasyonu
 * atlarsa kanonik hesabı ASLA göremez ve YANLIŞ BLOCKED üretir."
 *
 * Bu fonksiyon TEK normalizasyon yoludur: canary, dry-run ve canlı create
 * AYNI türevi kullanır, böylece üçü YAPISAL OLARAK ayrışamaz.
 */
export function normalizeAuthoritativeSuratStore(
  stored?: Record<string, unknown> | null,
): Record<string, unknown> {
  const base = stored ?? {}
  return { ...base, ...deriveCanonicalPrimaryAccount(base) }
}

/**
 * Kaynak etiketi ROLE ÖZELDİR — mevcut iz sözleşmesi böyle (`tenant.surat.primary`).
 * Etiket düzleştirilmedi: hangi rolün deposundan geldiği görünür kalmalı.
 */
export const CREDENTIAL_SNAPSHOT_SOURCE_BY_ROLE = {
  PRIMARY_MARKETPLACE: 'tenant.surat.primary',
  SELLER_PAYS: 'tenant.surat.sellerPays',
  COD: 'tenant.surat.cod',
} as const

export type SuratCredentialRoleKey =
  | 'PRIMARY_MARKETPLACE'
  | 'SELLER_PAYS'
  | 'COD'

export interface SuratCredentialSnapshot {
  /** DEĞİŞMEZ: bir deneme boyunca yeniden çözümlenmez. */
  readonly role: SuratCredentialRoleKey
  readonly source: string
  readonly kullaniciAdi: string
  readonly sifre: string
  readonly accountFingerprint: string
  readonly resolved: boolean
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/** Rol → kiracı deposundaki hesap alan adları. */
// ═══ TABAN `kullaniciAdi`/`sifre` ALANLARI BİLEREK YOK ══════════════════
//
// Bu iki alan ORTAM DEĞİŞKENİYLE EZİLEBİLİR ve kanonik yol onları OKUMAMALIDIR
// (mevcut sözleşme: `WIRE-6B` bunu kilitler). Buraya fallback olarak
// eklenirlerse ENV zehirli hesap sessizce tele çıkardı.
const ROLE_FIELDS: Record<SuratCredentialRoleKey, { user: string[]; pass: string[] }> = {
  PRIMARY_MARKETPLACE: {
    user: ['canonicalPrimaryKullaniciAdi', 'liveKullaniciAdi'],
    pass: ['canonicalPrimarySifre', 'liveSifre'],
  },
  SELLER_PAYS: {
    user: ['canonicalSellerPaysKullaniciAdi', 'sellerPaysKullaniciAdi'],
    pass: ['canonicalSellerPaysSifre', 'sellerPaysSifre'],
  },
  COD: {
    user: ['canonicalCodKullaniciAdi', 'codKullaniciAdi'],
    pass: ['canonicalCodSifre', 'codSifre'],
  },
}

const pick = (store: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = str(store[key])
    if (value) return value
  }
  return ''
}

/**
 * OTORİTER anlık görüntü — YALNIZ kiracı deposundan.
 *
 * `storedSuratConfig` çağıran tarafından `loadOrganizationIntegrationConfig`
 * ile getirilir. Bu fonksiyon başka HİÇBİR kaynağa bakmaz: istek gövdesi,
 * ortam değişkeni ve legacy config buraya GİREMEZ.
 */
export function buildSuratCredentialSnapshot(params: {
  storedSuratConfig?: Record<string, unknown> | null
  role: SuratCredentialRoleKey
  /**
   * KAYNAK ETİKETİ — yalnız depo GERÇEKTEN kiracı deposu DEĞİLSE verilir.
   *
   * Tek kullanıcılı yerel kurulumda kiracı deposu YOKTUR; kimlik yerel
   * yapılandırmadan gelir. O durumda etiketin `tenant.surat.*` demesi
   * okuyucuya YANLIŞ bilgi verirdi.
   */
  sourceLabel?: string
}): SuratCredentialSnapshot {
  const store = params.storedSuratConfig ?? {}
  const fields = ROLE_FIELDS[params.role] ?? ROLE_FIELDS.PRIMARY_MARKETPLACE
  const kullaniciAdi = pick(store, fields.user)
  const sifre = pick(store, fields.pass)
  const resolved = Boolean(kullaniciAdi && sifre)
  return Object.freeze({
    role: params.role,
    source: params.sourceLabel
      ?? CREDENTIAL_SNAPSHOT_SOURCE_BY_ROLE[params.role]
      ?? CREDENTIAL_SNAPSHOT_SOURCE_BY_ROLE.PRIMARY_MARKETPLACE,
    kullaniciAdi,
    sifre,
    accountFingerprint: accountFingerprint(kullaniciAdi),
    resolved,
  })
}

// ═══ İSTEMCİ KİMLİK ALANLARI — ASLA KABUL EDİLMEZ ════════════════════════

/** İstek gövdesinde bulunması kimlik katkısı sayılacak alanlar. */
export const CLIENT_CREDENTIAL_FIELDS = [
  'kullaniciAdi', 'sifre',
  'canonicalPrimaryKullaniciAdi', 'canonicalPrimarySifre',
  'canonicalSellerPaysKullaniciAdi', 'canonicalSellerPaysSifre',
  'canonicalCodKullaniciAdi', 'canonicalCodSifre',
  'liveKullaniciAdi', 'liveSifre',
  'firmaId', 'cariKod', 'customerCode',
] as const

export interface ClientCredentialScan {
  /** İstemci kimlik alanı GÖNDERDİ mi? */
  present: boolean
  /** Hangi alanlar — DEĞERLER ASLA taşınmaz. */
  fields: string[]
}

/**
 * İstek gövdesinde kimlik alanı var mı?
 *
 * Değerler OKUNMAZ/TAŞINMAZ; yalnız hangi alan adlarının geldiği raporlanır.
 * Bu bir kabul mekanizması DEĞİL, bir REDDETME kanıtıdır.
 */
export function scanClientCredentialFields(
  requestConfig?: Record<string, unknown> | null,
): ClientCredentialScan {
  const config = requestConfig ?? {}
  const fields = (CLIENT_CREDENTIAL_FIELDS as readonly string[]).filter(
    (field) => str(config[field]).length > 0,
  )
  return { present: fields.length > 0, fields }
}

// ═══ AĞ SINIRI PARİTE KAPISI ═════════════════════════════════════════════

export interface WireParityResult {
  ok: boolean
  snapshotFingerprint: string
  wireFingerprint: string
  errorCode: 'SURAT_CREDENTIAL_WIRE_MISMATCH' | 'SURAT_ACCOUNT_NOT_CONFIGURED' | null
  reason: string | null
  /** Kapı DÜŞTÜĞÜNDE bunlar DAİMA böyledir. */
  carrierCreateCalled: false
  networkCallCount: 0
}

/**
 * AĞ ÇAĞRISINDAN HEMEN ÖNCE çalışır.
 *
 * Karşılaştırma OTORİTER anlık görüntü ile **gerçekten serileştirilecek**
 * kullanıcı adı arasındadır. Önceki kapı iki kez çözülmüş AYNI istemci
 * gövdesini karşılaştırdığı için bu sınıf ayrışmayı göremiyordu.
 */
export function assertSuratWireCredentialParity(params: {
  snapshot: SuratCredentialSnapshot
  /** Telde GERÇEKTEN gidecek kullanıcı adı. */
  wireKullaniciAdi?: unknown
}): WireParityResult {
  const base = { carrierCreateCalled: false as const, networkCallCount: 0 as const }
  const snapshotFingerprint = params.snapshot.accountFingerprint
  const wireFingerprint = accountFingerprint(str(params.wireKullaniciAdi))

  if (!params.snapshot.resolved) {
    return {
      ...base, ok: false, snapshotFingerprint, wireFingerprint,
      errorCode: 'SURAT_ACCOUNT_NOT_CONFIGURED',
      reason: 'Kiracı deposunda bu rol için kimlik yok; ağa ÇIKILMAZ.',
    }
  }
  if (!wireFingerprint || wireFingerprint !== snapshotFingerprint) {
    return {
      ...base, ok: false, snapshotFingerprint, wireFingerprint,
      errorCode: 'SURAT_CREDENTIAL_WIRE_MISMATCH',
      reason:
        'Telde gidecek hesap, otoriter anlık görüntüyle AYNI DEĞİL; '
        + 'yanlış cariye yazma riski nedeniyle ağ çağrısı YAPILMADI.',
    }
  }
  return {
    carrierCreateCalled: false, networkCallCount: 0,
    ok: true, snapshotFingerprint, wireFingerprint,
    errorCode: null, reason: null,
  }
}
