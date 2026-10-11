// KANONİK BASKI ARTEFAKTI — SAĞLAYICI-NÖTR SÖZLEŞME.
//
// ═══ ÜÇ KAVRAM AYRIDIR ═══════════════════════════════════════════════════
//
//   1) ARTEFAKT   : hangi DEĞİŞMEZ baytlar/sayfalar basılacak
//   2) TAŞIMA     : o sayfalar fiziksel/kullanıcı mekanizmasına NASIL gider
//   3) YÜRÜTME    : hangi işler GERÇEKTEN gönderildi
//
// Bu dosya YALNIZ (1)'i tanımlar. Taşıma bilgisi, yazıcı adı, HTTP durumu ya
// da pazaryeri/taşıyıcı iş kuralı BURAYA GİRMEZ.
//
// ═══ ARTEFAKT ≠ TAŞIMA ═══════════════════════════════════════════════════
//
// AYNI değişmez taşıyıcı ZPL'i tarayıcıda render edilmiş sayfa olarak da,
// ham ZPL olarak da, indirme olarak da taşınabilir. Hedef değişince etiket
// YENİDEN ÜRETİLMEZ ve MUTASYONA UĞRAMAZ.
//
// ═══ KÜRESEL 100×100 VARSAYIMI YOK ═══════════════════════════════════════
//
// Sürat resmî etiketi bugün 10 × 10 cm'dir. Bu, GELECEKTEKİ her sağlayıcının,
// her taşıyıcının ve her ek sayfanın 100 × 100 olduğu anlamına GELMEZ.
// Ölçü SAYFANIN KENDİ alanıdır; platformda tek bir küresel sabit YOKTUR.
// Kaynağa özgü ölçüler `printSourceGeometry` içinde, KAYNAK BAZINDA durur.

/**
 * Bugün GERÇEKTEN üretilebilen içerik türleri.
 *
 * PNG/HTML_DOCUMENT BİLEREK YOK: kanonik kalıcı artefakt ZPL'dir. Resmî
 * tarayıcı yolu PNG'yi render UCUNDAN türetir (kalıcı artefakt DEĞİLDİR) ve
 * CargoFlow HTML etiketi istemcide üretilir. Üretilemeyen bir türü sözleşmeye
 * yazmak, doldurulmayan ve zamanla yalan söyleyen bir alan üretirdi.
 */
export const PRINT_CONTENT_KINDS = ['ZPL'] as const
export type PrintContentKind = (typeof PRINT_CONTENT_KINDS)[number]

/**
 * ARTEFAKT SAHİPLİĞİ.
 *
 * `SERVER_AUTHORITATIVE`: baytlar sunucuda kalıcıdır ve istemci onları
 * DEĞİŞTİREMEZ/YERİNE KOYAMAZ. Taşıyıcı `printZpl` budur.
 *
 * `CLIENT_RENDERED`: CargoFlow HTML etiketi gibi istemcide üretilen belge.
 * Simetri UĞRUNA sunucuya taşınMAZ; kabul edilmiş mimari budur.
 */
export const PRINT_ARTIFACT_OWNERSHIPS = [
  'SERVER_AUTHORITATIVE',
  'CLIENT_RENDERED',
] as const
export type PrintArtifactOwnership = (typeof PRINT_ARTIFACT_OWNERSHIPS)[number]

/** Sayfanın mantıksal rolü. Sıra bu alandan DEĞİL, `index`ten gelir. */
export const PRINT_PAGE_KINDS = ['carrier', 'product_detail'] as const
export type PrintPageKind = (typeof PRINT_PAGE_KINDS)[number]

/** Fiziksel sayfa ölçüsü — SAYFANIN KENDİ alanı. */
export interface PrintPageGeometry {
  readonly widthMm: number
  readonly heightMm: number
  /** Anlamlı olduğu yerde nokta çözünürlüğü; ham ZPL için 203. */
  readonly dpi: number
}

export interface CanonicalPrintPage {
  /** 0'dan başlayan KESİN sıra. Taşıma bunu DEĞİŞTİREMEZ. */
  readonly index: number
  readonly kind: PrintPageKind
  readonly contentKind: PrintContentKind
  readonly content: string
  /** Kalıcı içerik özeti (varsa). */
  readonly sha256: string | null
  readonly geometry: PrintPageGeometry
}

export interface CanonicalPrintArtifact {
  readonly organizationId: string
  readonly shipmentId: string
  /** Sağlayıcı paket kimliği (pazaryeri tarafı). */
  readonly packageId: string
  readonly marketplace: string
  readonly carrier: string
  readonly ownership: PrintArtifactOwnership
  /** Artefaktın KAYNAĞI — kimin baytları (ör. kalıcı taşıyıcı paketi). */
  readonly source: string
  /** Kalıcı taşıyıcı artefaktının kimlik zinciri. */
  readonly printZplSha256: string
  readonly printZplSourceSha256: string
  readonly pages: readonly CanonicalPrintPage[]
}

/** Toplam fiziksel sayfa sayısı. */
export function pageCountOf(artifact: CanonicalPrintArtifact): number {
  return artifact.pages.length
}

/**
 * SIRA DEĞİŞMEZLİĞİ DENETİMİ.
 *
 * Taşıma sayfaları YENİDEN SIRALAYAMAZ, DÜŞÜREMEZ, ÇOĞALTAMAZ ya da
 * BİRLEŞTİREMEZ. Bu fonksiyon sunum sırasının kalıcı sıra ile birebir aynı
 * olduğunu doğrular; sapma SESSİZCE düzeltilmez, AÇIKÇA bildirilir.
 */
export function isCanonicalPageOrder(
  pages: readonly CanonicalPrintPage[],
): boolean {
  if (pages.length === 0) return false
  // Taşıyıcı sayfa HER ZAMAN ilktir.
  if (pages[0]?.kind !== 'carrier') return false
  for (const [position, page] of pages.entries()) {
    if (page.index !== position) return false
    // Taşıyıcı sayfa YALNIZ bir kez ve YALNIZ başta.
    if (position > 0 && page.kind === 'carrier') return false
  }
  return true
}
