// DURUSOFT PARITY COMPOSER.
//
// Gerçek Sürat technicalZpl'inden, DuruSoft referansına eşlenik türetilmiş
// baskı ZPL'i üretir. Kaynak ZPL'e DOKUNULMAZ; composer yalnız türev üretir.
//
// ═══ SÖZLEŞME (composed mode) ══════════════════════════════════════════════
//
// A) SOURCE IMMUTABILITY — kayıtlı technicalZpl bayt bayt aynı kalır; composer
//    kendisine verilen dizgiyi asla değiştirmez, yalnız yeni dizgi döndürür.
//
// B) SEMANTIC INVARIANTS — çıktı TEKRAR parse edilir; T.No, Code128,
//    DataMatrix, sipariş referansı, rota ve aktarma merkezi gövdeleri kaynakla
//    BİREBİR aynı olmalıdır. QR varsa gövdesi doğrulanmış 727 değeridir.
//    Bir tanesi bile tutmazsa çıktı REDDEDİLİR ve fallback kullanılır.
//
// C) TRANSFORM WHITELIST — composed modda YALNIZ şunlara izin verilir:
//      1. ^BC yorum satırı bayrağı Y → N
//      2. aynı Code128 gövdesinin ayrı, küçük, ortalanmış metin alanı olarak
//         eklenmesi
//      3. mevcut adres satırlarından türetilmiş bold tekrar alanları
//      4. doğrulanmış 727 değerinden sağ-alt ^BQ QR (+ onu çevreleyen
//         geçici ^BY durum komutları)
//      5. aktarma merkezi metninin FONT GENİŞLİĞİNİN daraltılması — YALNIZ
//         sağ kolona QR sığdırmak için, YALNIZ gerektiği kadar ve yalnız
//         okunabilirlik tabanına kadar. GÖVDE (^FD) DEĞİŞMEZ, yükseklik
//         DEĞİŞMEZ, konum DEĞİŞMEZ.
//    Bunların dışında HİÇBİR taşıyıcı komutu değişmez: beklenmeyen mutasyon
//    veya silme sayısı 0 olmalıdır (`diffZplAgainstSource`).
//
// D) DETERMINISM — aynı girdi her zaman bayt bayt aynı çıktıyı verir.
//
// E) QR ZORUNLULUĞU — doğrulanmış 727 VARSA ve GEÇERLİYSE, QR composed modun
//    ZORUNLU parçasıdır. QR güvenli alana sığmıyorsa QR'sız KISMİ bir DuruSoft
//    etiketi ÜRETİLMEZ: composer tümüyle reddeder ve official_augmented
//    fallback'i kullanılır. (727 yok / geçersiz / kaynaklar çelişiyorsa mevcut
//    iş kuralı sürer: QR basılmaz, composed modun geri kalanı çalışır.)
//
// Augmentation-only mod (official_augmented) DEĞİŞMEDİ: orada kaynak ZPL
// çıktının bayt öneki olarak durmaya devam eder (RT-10A).

import {
  applyZplEdits,
  parseZplDocument,
  serializeZplDocument,
  zplCommands,
  type ZplCommand,
  type ZplDocument,
  type ZplEdit,
} from './zplCommandModel.ts'
import {
  BOLD_ADDRESS_BASELINES,
  BOLD_ADDRESS_X,
  extractSuratSemanticFields,
  resolveSuratSemanticModel,
  type SuratFieldExpectations,
  type SuratSemanticKey,
  type SuratSemanticModel,
} from './suratSemanticParser.ts'
import { resolveSuratQrPayload, type SuratQrRejection, type SuratQrSource } from './suratQrPayload.ts'

// ═══ ÖLÇÜLMÜŞ SABİTLER ════════════════════════════════════════════════════
//
// Tümü gerçek fixture'ın 799×799 zebrash render'ından ölçüldü.
// Ayrıntı ve zebrash sapmaları için: server/surat-composer-render-flow.test.mjs

/** Code128 insan-okunur metninin fontu (dahili satır h≈31, bu h≈15). */
const HUMAN_TEXT_HEIGHT = 20
const HUMAN_TEXT_WIDTH = 20
/** Barkod taban çizgisi ile metin hücresinin üstü arasındaki boşluk. */
const HUMAN_TEXT_GAP = 6
/** Alıcı kutusunun üst çizgisi — metin buraya DEĞEMEZ. */
const RECIPIENT_BOX_TOP = 336

/**
 * `^A0` (yerleşik ölçeklenebilir font) KARAKTER İLERLEME TABLOSU.
 *
 * Değerler genişlik parametresinin katıdır ve yerel renderer üzerinde
 * ölçülmüştür (10 tekrarlı ink kutusu / 10). Doğrulama: gerçek aktarma
 * merkezi adlarında tahmin ile ölçüm arasındaki fark ±2 dot.
 *
 * NEDEN TABLO: önceden tek bir üst sınır oranı (0.60) kullanılıyordu. Bu,
 * dar harfli adlarda genişliği ciddi biçimde ŞİŞİRİYOR ve QR'ı gereksiz yere
 * reddettiriyordu — üretimde "IKITELLI AKTARMA" gerçekte x=606'da bitiyor,
 * kaba tahmin ise 700 diyordu ve tüm composed çıktı düşüyordu.
 *
 * Tabloda olmayan karakter (küçük harf, Türkçe harfler, semboller) için EN
 * GENİŞ ölçülen değer kullanılır; böylece tahmin her zaman ÜST SINIR kalır.
 */
const A0_ADVANCE: Readonly<Record<string, number>> = {
  '0': 0.493, '1': 0.483, '2': 0.493, '3': 0.493, '4': 0.493, '5': 0.493,
  '6': 0.493, '7': 0.493, '8': 0.493, '9': 0.493,
  A: 0.553, B: 0.543, C: 0.543, D: 0.6, E: 0.49, F: 0.49, G: 0.6, H: 0.6,
  I: 0.267, J: 0.44, K: 0.547, L: 0.49, M: 0.767, N: 0.6, O: 0.6, P: 0.547,
  Q: 0.6, R: 0.6, S: 0.547, T: 0.5, U: 0.6, V: 0.55, W: 0.827, X: 0.553,
  Y: 0.553, Z: 0.493,
  a: 0.49, b: 0.487, c: 0.437, d: 0.487, e: 0.487, f: 0.273, g: 0.487,
  h: 0.487, i: 0.263, j: 0.27, k: 0.44, l: 0.263, m: 0.767, n: 0.487,
  o: 0.487, p: 0.487, q: 0.487, r: 0.327, s: 0.437, t: 0.277, u: 0.487,
  v: 0.443, w: 0.663, x: 0.443, y: 0.443, z: 0.383,
  '/': 0.283, '-': 0.773, '.': 0.313, ' ': 0.252, ':': 0.267, ',': 0.313,
  '(': 0.32, ')': 0.32,
}
/** Tabloda bulunmayan karakterler için ölçülen EN GENİŞ ilerleme. */
const A0_ADVANCE_FALLBACK = 0.827
/** Ölçüm hatasına karşı güvenlik payı (tahmin ÜST SINIR kalmalı). */
const A0_WIDTH_SAFETY = 1.03
const A0_WIDTH_PADDING = 4

/**
 * İndirilmiş TrueType (`^A@…TT0003M_`) için karakter ilerlemesinin üst sınırı.
 * zebrash yedek fontunda 11.96 dot ölçüldü; gerçek TT0003M_ metrikleri
 * bilinmediği için 13 dot ile temkinli sınır konur.
 */
const TRUETYPE_ADVANCE_DOTS = 13

/** Bold adres bloğunun sağ sınırı (alıcı kutusunun sağ dikey çizgisi 773). */
const BOLD_ADDRESS_RIGHT_LIMIT = 765

/**
 * ALT BÖLÜM ÜÇ KOLON: [DataMatrix] [rota + aktarma] [QR]
 *
 * Orta kolonun sağ sınırı QR'ın quiet-zone'undan ÖNCE bitmelidir. Aktarma
 * merkezi adı uzun olduğunda metin bu sınırı aşar ve QR'a yer kalmaz —
 * üretimde "DIYARBAKIR AKTARMA" tam olarak bunu yaşattı (sağ uç 709,
 * mag5 için gereken sol kenar 729 > 674).
 *
 * Çözüm: aktarma metninin FONT GENİŞLİĞİ, QR sığana kadar kademeli daraltılır.
 * Gövde, yükseklik ve konum DEĞİŞMEZ; yalnız `^A0` genişlik parametresi.
 * Taban değeri okunabilirlik için yerleştirilmiştir: 70 dot yükseklikte 40
 * genişlik hâlâ iri ve net bir başlıktır (referanstaki kısa adlar zaten
 * daraltmaya HİÇ girmez, yerel görünüm korunur).
 */
const TRANSFER_FONT_WIDTH_STEPS: readonly number[] = [46, 43, 40]

/**
 * QR ADAYLARI — deterministik arama sırası.
 *
 * Version 1 (21 modül) doğrulanmış 727 payload'ı için yeterlidir.
 * İlk GÜVENLİ aday seçilir; hiçbiri güvenli değilse composer REDDEDER
 * (QR'sız kısmi DuruSoft etiketi ÜRETİLMEZ).
 *
 *   A) mag 5 (105 dot), DuruSoft'un ideal sağ-alt konumu
 *   B) mag 4 (84 dot),  aynı bant — uzun aktarma adlarında sağa kayabilir
 *
 * YÜKSELTİLMİŞ BANT DEĞERLENDİRİLDİ VE REDDEDİLDİ: ödeme ayracı (y=539) ile
 * aktarma metninin tepesi (y=705−70=635) arasında yalnız ~96 dot vardır. mag 4
 * QR'ı (84 dot + renderer kayması) oraya sığdırmak quiet-zone'u yok eder, mag 3
 * ise modül boyutunu 0.375 mm'ye düşürür (termal okunabilirlik sınırının
 * altı). Bu yüzden aktarma adı gerçekten uzun olduğunda GÜVENLİ yerleşim
 * YOKTUR ve composer bilinçli olarak fallback'e düşer.
 */
interface SuratQrCandidate {
  readonly magnification: number
  readonly size: number
  readonly y: number
}
const QR_CANDIDATES: readonly SuratQrCandidate[] = [
  { magnification: 5, size: 105, y: 596 },
  { magnification: 4, size: 84, y: 596 },
]
/**
 * ZEBRASH SAPMASI: yerel renderer `^BQ`'yu `^FO y + yürürlükteki ^BY yüksekliği`
 * konumuna koyar (ölçüldü: ^BY yokken +10, `^BY4,3,143` yürürlükteyken +143).
 * ZPL II'de `^BY` yüksekliği 1B barkodlara aittir ve QR'ı kaydırmaz; gerçek
 * yazıcıda QR `^FO` y'sinde başlar.
 *
 * Bu yüzden QR'dan hemen önce KÜÇÜK ve BİLİNEN bir `^BY` yazılır: böylece iki
 * yorum arasındaki fark 10 dot ile sınırlanır ve QR her iki modelde de aynı
 * güvenli banda (QR_Y .. QR_Y + 10 + QR_SIZE) düşer.
 */
/**
 * DİKEY "ALICI" BAŞLIĞI — kaldırılacak TEK etiket metni.
 *
 * FİZİKSEL GEREKÇE: alıcı kutusunun sol kenarındaki dikey başlık, uzun
 * ad/adres kombinasyonlarında gereksiz alan tüketiyor ve sıkışma yaratıyor.
 * Kaldırılan YALNIZ bu literal başlıktır; alıcı adı, adres, telefon ve
 * il/ilçe alanlarına DOKUNULMAZ.
 *
 * KİMLİK: koordinat + font imzası (metin DEĞİL). Metinle eşleştirmek
 * maskeli fixture'da ve farklı yazımlarda kırılırdı; şablon zaten
 * fingerprint ile sabitlenmiş durumda.
 */
const RECIPIENT_HEADING = {
  x: 54,
  y: 430,
  orientation: 'B' as const,
  height: 23,
  width: 24,
}

const QR_SCOPE_BY = '^BY2,3,10'
const QR_RENDER_Y_OFFSET = 10
/**
 * ORTAK YERLEŞİM RAYLARI — taşıyıcının KENDİ `^GB` çizgilerinden türetilmiştir,
 * uydurulmamıştır. Composer'ın EKLEDİĞİ alanlar bu raylara bağlanır; taşıyıcının
 * kendi alanları ASLA taşınmaz (semantic invariant).
 *
 *   üst kutu      : sol 48  · sağ 766   (^FO48,84 / ^FO766,84)
 *   alıcı kutusu  : sol 59  · sağ 773   (^FO59,337 / ^FO773,337)
 *   yatay çizgiler: 84 · 154 · 336 · 476 · 539
 *
 * Dış sol referans DataMatrix'in sol kenarıdır (x=59, alıcı kutusu rayıyla
 * aynı). Simetri kuralı: QR'ın DIŞ SAĞ marjı, DataMatrix'in DIŞ SOL marjına
 * eşit olmalıdır.
 */
export const SURAT_GRID = {
  contentLeft: 48,
  contentRight: 775,
  boxLeft: 59,
  boxRight: 773,
  labelEdge: 799,
} as const

/**
 * QR'ın tercih edilen sol kenarı, DIŞ MARJ SİMETRİSİNDEN türetilir:
 * QR sağ kenarı = labelEdge − (DataMatrix dış sol marjı).
 * Böylece alt bölüm [DataMatrix] [orta blok] [QR] kompozisyonunda iki
 * makine-okunur kodun dış boşlukları eşitlenir.
 *
 * Güvenlik parity'den ÖNCE gelir: yerleşim çözücü bu tercihi yalnız BAŞLANGIÇ
 * noktası olarak kullanır, komşu metinler gerektirirse QR sağa kaydırılır.
 */
function preferredQrLeft(size: number, dataMatrixLeft: number): number {
  return SURAT_GRID.labelEdge - dataMatrixLeft - size
}
/**
 * QR sessiz bölgesi MODÜL cinsindendir (QR spesifikasyonu: 4 modül).
 * Sabit dot yerine magnification ile ölçeklenir: mag 5 → 20 dot, mag 4 → 16.
 */
const QR_QUIET_MODULES = 4
const LABEL_EDGE = 799

export type SuratComposeMode =
  | 'durusoft_composed'
  | 'fallback_unknown_template'
  | 'fallback_semantic_failure'
  | 'fallback_geometry_failure'
  | 'fallback_invariant_failure'
  | 'fallback_whitelist_violation'

/** Composed çıktıda korunması ZORUNLU makine-okunur alanlar. */
export const INVARIANT_KEYS: readonly SuratSemanticKey[] = [
  'tNo',
  'code128Payload',
  'dataMatrixPayload',
  'orderReference',
  'routeCode',
  'transferCenter',
]

export interface SuratComposeInput {
  /** order.cargoTrackingNumber — QR adayı. */
  readonly cargoTrackingNumber?: unknown
  /** shipment.ozelKargoTakipNo — QR adayı. */
  readonly ozelKargoTakipNo?: unknown
}

export interface SuratComposeDiagnostics {
  readonly fingerprint: string
  /** Code128 gövdesi DEĞİL, yalnız hane sayısı. */
  readonly code128Digits: number
  readonly barcodeModules: number
  readonly barcodeWidth: number
  readonly humanTextTop: number
  readonly humanTextBlockWidth: number
  readonly boldAddressLines: number
  readonly qrSource: SuratQrSource | null
  readonly qrRejection: SuratQrRejection | 'geometry_conflict' | null
  /** ZPL origin kutusu. Renderer'da y + qrRenderYOffset konumunda görünür. */
  readonly qrBox: { x: number; y: number; size: number } | null
  readonly qrRenderYOffset: number
  /** Seçilen adayın magnification'ı ve aday listesindeki sırası. */
  readonly qrMagnification: number | null
  readonly qrCandidateIndex: number | null
  /** Aktarma metninin uygulanan font genişliği ve özgün değeri. */
  readonly transferFontWidth: number
  readonly transferFontWidthNative: number
  /**
   * Kaynağa göre fark raporu. Beklenen değerler:
   *   deletions            = 0 (taşıyıcı komutu ASLA silinmez)
   *   allowedMutations     = 1 (yalnız ^BC yorum bayrağı Y→N)
   *   unexpectedMutations  = 0
   *   insertions           = barkod insan metni + bold adres vuruşları +
   *                          QR durum/QR komutları (+ ürün footer'ı ayrı
   *                          katmanda eklenir)
   */
  readonly diff: {
    readonly mutations: number
    readonly allowedMutations: number
    readonly unexpectedMutations: number
    readonly deletions: number
    readonly insertions: number
  }
}

export interface SuratComposedLabel {
  readonly composed: boolean
  readonly mode: SuratComposeMode
  /** Güvenli teknik sebep — müşteri verisi İÇERMEZ. */
  readonly reason: string | null
  /** composed ise türev ZPL, aksi halde kaynak ZPL AYNEN. */
  readonly zpl: string
  readonly diagnostics: SuratComposeDiagnostics | null
}

// ═══ YARDIMCILAR ══════════════════════════════════════════════════════════

/** `^A0N,h,w` ile yazılmış metnin genişlik ÜST SINIRI (dot). */
export function estimateA0Width(text: string, fontWidth: number): number {
  let ratio = 0
  for (const character of text) {
    ratio += A0_ADVANCE[character] ?? A0_ADVANCE_FALLBACK
  }
  return Math.ceil(ratio * fontWidth * A0_WIDTH_SAFETY) + A0_WIDTH_PADDING
}

/**
 * Code128 modül sayısı — GERÇEK ZEBRA (ZPL II) davranışına göre.
 *
 * `>:` öneki subset C başlatır: haneler İKİŞER kodlanır. Tek sayıda hane
 * kalırsa yazıcı subset B'ye geçer (1 geçiş sembolü + 1 karakter sembolü).
 * Önek yoksa subset B: her karakter 1 sembol.
 *
 * DİKKAT: yerel renderer (zebrash) `>:` önekini UYGULAMAZ ve her zaman
 * subset B kodlar. Bu yüzden barkodun render'daki genişliği gerçek yazıcıdan
 * FARKLIDIR; ortalama hesabı bilinçli olarak ZPL spesifikasyonunu esas alır.
 */
export function code128ModuleCount(rawFieldData: string): {
  digits: string
  modules: number
} | null {
  const subsetC = rawFieldData.startsWith('>:')
  const digits = subsetC ? rawFieldData.slice(2) : rawFieldData
  if (digits === '' || !/^[0-9]+$/.test(digits)) return null
  const n = digits.length
  // start + veri sembolleri + kontrol + stop(13)
  const dataSymbols = subsetC
    ? n % 2 === 0
      ? n / 2
      : (n - 1) / 2 + 2 // subset B'ye geçiş + son hane
    : n
  return { digits, modules: 11 + 11 * dataSymbols + 11 + 13 }
}

export interface ZplDiff {
  readonly mutations: readonly { name: string; from: string; to: string }[]
  readonly removed: readonly string[]
  readonly inserted: number
}

/**
 * Çıktıyı kaynağa göre karşılaştırır: kaynak komut dizisi çıktıda SIRAYLA
 * aranır. Bulunamayan ama adı eşleşen komut = mutasyon, hiç bulunamayan =
 * silme, aradaki fazlalıklar = ekleme.
 */
export function diffZplAgainstSource(
  source: ZplDocument,
  output: ZplDocument,
): ZplDiff {
  const mutations: { name: string; from: string; to: string }[] = []
  const removed: string[] = []
  let inserted = 0
  let cursor = 0
  for (const command of source.commands) {
    let exact = -1
    for (let index = cursor; index < output.commands.length; index += 1) {
      const candidate = output.commands[index]
      if (candidate.name === command.name && candidate.args === command.args) {
        exact = index
        break
      }
    }
    if (exact >= 0) {
      inserted += exact - cursor
      cursor = exact + 1
      continue
    }
    let sameName = -1
    for (let index = cursor; index < output.commands.length; index += 1) {
      if (output.commands[index].name === command.name) {
        sameName = index
        break
      }
    }
    if (sameName >= 0) {
      mutations.push({
        name: command.name,
        from: command.args,
        to: output.commands[sameName].args,
      })
      inserted += sameName - cursor
      cursor = sameName + 1
    } else {
      removed.push(command.name)
    }
  }
  inserted += output.commands.length - cursor
  return { mutations, removed, inserted }
}

/** DataMatrix işgal kutusu için ölçülmüş üst sınırlar (x59..159, ~216 yükseklik). */
const DATA_MATRIX_MAX_WIDTH = 140
const DATA_MATRIX_MAX_HEIGHT = 230

interface QrOccupancyBox {
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export interface SuratQrPlacement {
  readonly x: number
  readonly y: number
  readonly size: number
  readonly magnification: number
  readonly candidateIndex: number
}

/**
 * İlk GÜVENLİ QR adayını seçer.
 *
 * Bir işgal kutusu YALNIZ QR'ın dikey bandıyla KESİŞİYORSA sol sınırı
 * kısıtlar — QR'ın çok altında/üstünde kalan bir metin yerleşimi engellemez.
 * Dikey bant, renderer'ın `^BY` kaynaklı kaymasını da KAPSAR.
 */
export function resolveQrPlacement(
  occupancy: readonly QrOccupancyBox[],
  dataMatrixLeft: number = SURAT_GRID.boxLeft,
): SuratQrPlacement | null {
  for (const [candidateIndex, candidate] of QR_CANDIDATES.entries()) {
    const quietZone = QR_QUIET_MODULES * candidate.magnification
    const bandTop = candidate.y
    const bandBottom = candidate.y + QR_RENDER_Y_OFFSET + candidate.size
    if (bandBottom + quietZone > LABEL_EDGE) continue
    let requiredLeft = preferredQrLeft(candidate.size, dataMatrixLeft)
    for (const boxEntry of occupancy) {
      const intersectsVertically =
        boxEntry.top <= bandBottom && bandTop <= boxEntry.bottom
      if (!intersectsVertically) continue
      requiredLeft = Math.max(requiredLeft, boxEntry.right + quietZone)
    }
    const maxLeft = LABEL_EDGE - quietZone - candidate.size
    if (requiredLeft > maxLeft) continue
    return {
      x: requiredLeft,
      y: candidate.y,
      size: candidate.size,
      magnification: candidate.magnification,
      candidateIndex,
    }
  }
  return null
}

function fallback(
  mode: SuratComposeMode,
  reason: string,
  sourceZpl: string,
): SuratComposedLabel {
  return { composed: false, mode, reason, zpl: sourceZpl, diagnostics: null }
}

/** Bir alanın komutlarını, konumu değiştirilmiş kopyayla klonlar. */
function cloneFieldAt(
  commands: readonly ZplCommand[],
  x: number,
  y: number,
): ZplCommand[] {
  // Her komut YENİ nesne olarak kopyalanır: eklenen alanlar kaynak belgedeki
  // komut kimlikleriyle karışmaz (düzenlemeler kimlik üzerinden çalışıyor).
  return commands.map((command, index) => ({
    name: command.name,
    args: index === 0 ? `${x},${y}` : command.args,
  }))
}

// ═══ COMPOSER ═════════════════════════════════════════════════════════════

export function composeSuratDurusoftLabel(
  rawSourceZpl: unknown,
  input: SuratComposeInput = {},
): SuratComposedLabel {
  const sourceZpl = String(rawSourceZpl ?? '')
  if (!sourceZpl.trim()) {
    return fallback('fallback_unknown_template', 'kaynak ZPL boş', sourceZpl)
  }

  const semantic = resolveSuratSemanticModel(sourceZpl)
  if (!semantic.supported) {
    return fallback(
      'fallback_unknown_template',
      semantic.reason ?? 'şablon tanınmadı',
      sourceZpl,
    )
  }

  const fields = semantic.fields
  const code128 = fields.code128Payload
  const transfer = fields.transferCenter
  const route = fields.routeCode
  if (!code128 || !transfer || !route) {
    return fallback('fallback_semantic_failure', 'kritik alan çözülemedi', sourceZpl)
  }

  // ── 1) Code128 yorum satırı bayrağı: Y → N ───────────────────────────
  const codeCommand = code128.field.codeCommand
  if (!codeCommand || !codeCommand.args.startsWith('N,,Y,N')) {
    return fallback(
      'fallback_semantic_failure',
      'Code128 yorum satırı bayrağı beklenen biçimde değil',
      sourceZpl,
    )
  }
  const byCommand = code128.field.byCommand
  const moduleWidth = Number.parseInt((byCommand?.args ?? '').split(',')[0] ?? '', 10)
  if (!Number.isFinite(moduleWidth) || moduleWidth <= 0) {
    return fallback('fallback_semantic_failure', '^BY modül genişliği okunamadı', sourceZpl)
  }

  const counted = code128ModuleCount(code128.raw)
  if (!counted) {
    return fallback(
      'fallback_semantic_failure',
      'Code128 gövdesi yalnız rakamlardan oluşmuyor',
      sourceZpl,
    )
  }
  const barcodeWidth = counted.modules * moduleWidth
  const barcodeLeft = code128.field.x
  const humanTextTop = code128.field.y + HUMAN_TEXT_GAP
  const humanTextWidth = estimateA0Width(counted.digits, HUMAN_TEXT_WIDTH)

  // Metin barkodun yatay bandına SIĞMALI ve alıcı kutusuna DEĞMEMELİ.
  if (humanTextWidth > barcodeWidth) {
    return fallback(
      'fallback_geometry_failure',
      'insan-okunur metin barkod bandından geniş',
      sourceZpl,
    )
  }
  if (barcodeLeft + barcodeWidth > LABEL_EDGE) {
    return fallback('fallback_geometry_failure', 'barkod bandı etiket dışına taşıyor', sourceZpl)
  }
  if (humanTextTop + HUMAN_TEXT_HEIGHT >= RECIPIENT_BOX_TOP) {
    return fallback('fallback_geometry_failure', 'metin alıcı kutusuna değiyor', sourceZpl)
  }

  // ── 2) Bold adres: taşıyıcının KENDİ satırları, KENDİ baytları ────────
  const addressLines = semantic.addressLines
  if (addressLines.length === 0 || addressLines.length > BOLD_ADDRESS_BASELINES.length) {
    return fallback(
      'fallback_semantic_failure',
      `bold adres için uygun satır sayısı yok (${addressLines.length})`,
      sourceZpl,
    )
  }
  for (const line of addressLines) {
    // Kaynak satır aynı font ve aynı x ile ZATEN sığmış durumda; yine de
    // temkinli bir üst sınır uygulanır (+1 dot çift vuruş dahil).
    const width = line.raw.length * TRUETYPE_ADVANCE_DOTS
    if (BOLD_ADDRESS_X + width + 1 > BOLD_ADDRESS_RIGHT_LIMIT) {
      return fallback(
        'fallback_geometry_failure',
        `bold adres satırı ayrılmış bölgeye sığmıyor (${line.raw.length} karakter)`,
        sourceZpl,
      )
    }
  }

  // ── 3) QR: doğrulanmış 727 + gerçek boşluk ────────────────────────────
  const qr = resolveSuratQrPayload({
    cargoTrackingNumber: input.cargoTrackingNumber,
    ozelKargoTakipNo: input.ozelKargoTakipNo,
    forbiddenValues: INVARIANT_KEYS.map((key) => fields[key]?.text).concat(
      counted.digits,
      fields.branch?.text,
      fields.recipientPhone?.text,
    ),
  })

  // Komşu alanların İŞGAL KUTULARI, semantic geometriden türetilir.
  // Karakter sayısına bağlı sabit eşik YOKTUR: her kutu kendi metni, kendi
  // font genişliği ve kendi `^FT` taban çizgisinden hesaplanır.
  const transferNativeWidth = transfer.field.font?.width ?? 0
  const buildOccupancy = (transferWidth: number) => {
    const boxes = [route, transfer, fields.deliveryType, fields.parcelCount]
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => {
        const font = entry.field.font
        const height = font?.height ?? 0
        const width =
          entry === transfer ? transferWidth : (font?.width ?? 0)
        return {
          right: entry.field.x + estimateA0Width(entry.text, width),
          top: entry.field.y - height,
          bottom: entry.field.y,
        }
      })
    // DataMatrix sol alt köşededir; sağ-alt QR ile yarışmaz ama sözleşme
    // gereği işgal listesine DAHİL EDİLİR.
    if (fields.dataMatrixPayload) {
      boxes.push({
        right: fields.dataMatrixPayload.field.x + DATA_MATRIX_MAX_WIDTH,
        top: fields.dataMatrixPayload.field.y - DATA_MATRIX_MAX_HEIGHT,
        bottom: fields.dataMatrixPayload.field.y,
      })
    }
    return boxes
  }

  // Önce ÖZGÜN tipografiyle dene; yalnız QR sığmıyorsa aktarma metnini
  // kademeli daralt. Kısa adlarda hiç daraltma OLMAZ.
  const dataMatrixLeft = fields.dataMatrixPayload?.field.x ?? SURAT_GRID.boxLeft
  const widthSteps = [
    transferNativeWidth,
    ...TRANSFER_FONT_WIDTH_STEPS.filter((step) => step < transferNativeWidth),
  ]
  let placement: SuratQrPlacement | null = null
  let transferWidth = transferNativeWidth
  for (const candidateWidth of widthSteps) {
    placement = resolveQrPlacement(buildOccupancy(candidateWidth), dataMatrixLeft)
    if (placement) {
      transferWidth = candidateWidth
      break
    }
  }

  // E) DOĞRULANMIŞ 727 VARSA QR ZORUNLUDUR. Hiçbir aday güvenli değilse
  //    QR'sız kısmi DuruSoft etiketi üretmek YERİNE composer tümüyle reddeder.
  if (qr.payload !== null && !placement) {
    return fallback(
      'fallback_geometry_failure',
      'hiçbir QR adayı güvenli değil (qrRejection=geometry_conflict)',
      sourceZpl,
    )
  }
  const qrFits = qr.payload !== null && placement !== null
  // Kutu ZPL ORIGIN'ini taşır; renderer'da +QR_RENDER_Y_OFFSET kadar aşağıda
  // görünür. Güvenlik kontrolleri iki yorumu da kapsayan bandı kullanır.
  const qrBox =
    qrFits && placement
      ? { x: placement.x, y: placement.y, size: placement.size }
      : null

  // ── DÜZENLEMELER ──────────────────────────────────────────────────────
  const document = semantic.document
  const edits: ZplEdit[] = []

  // (whitelist 1) yorum satırı bayrağı Y → N — TEK carrier mutasyonu.
  edits.push({
    type: 'replace',
    target: codeCommand,
    commands: [{ name: 'BC', args: `N,,N,N${codeCommand.args.slice('N,,Y,N'.length)}` }],
  })

  // (whitelist 6) dikey "ALICI" başlığı GÖRÜNMEZ kılınır.
  //
  // SİLME DEĞİL BOŞALTMA: `^FD` gövdesi boşaltılır, komut yapısı YERİNDE
  // kalır. Böylece "taşıyıcı komutu ASLA silinmez" invariant'ı (deletions=0)
  // olduğu gibi korunur ve düzenleme tek bir mutasyona indirgenir.
  const headingField = semantic.zplFields.find(
    (field) =>
      field.x === RECIPIENT_HEADING.x &&
      field.y === RECIPIENT_HEADING.y &&
      field.font?.orientation === RECIPIENT_HEADING.orientation &&
      field.font?.height === RECIPIENT_HEADING.height &&
      field.font?.width === RECIPIENT_HEADING.width &&
      field.dataCommand !== null,
  )
  const headingData = headingField?.data ?? null
  if (headingField?.dataCommand && headingData) {
    edits.push({
      type: 'replace',
      target: headingField.dataCommand,
      commands: [{ name: 'FD', args: '' }],
    })
  }

  const tail: ZplCommand[] = []
  // (whitelist 2) Code128 insan-okunur metni — barkod bandında ortalanmış.
  tail.push(
    ...zplCommands(
      `^FO${barcodeLeft},${humanTextTop}` +
        `^A0N,${HUMAN_TEXT_HEIGHT},${HUMAN_TEXT_WIDTH}` +
        `^FB${barcodeWidth},1,0,C` +
        `^FD${counted.digits}^FS`,
    ),
  )
  // (whitelist 3) bold adres: aynı bayt, aynı font, +1 dot çift vuruş.
  addressLines.forEach((line, index) => {
    const baseline = BOLD_ADDRESS_BASELINES[index]
    for (const offset of [0, 1]) {
      tail.push(
        ...cloneFieldAt(line.field.commands, BOLD_ADDRESS_X + offset, baseline),
        { name: 'CI', args: '0' },
      )
    }
  })
  // (whitelist 4) doğrulanmış 727 QR.
  if (qrFits && qr.payload && placement) {
    // ^BY DURUM İZOLASYONU. `^BY` stateful'dur ve yerel renderer `^BQ`'nun
    // dikey konumunu yürürlükteki ^BY YÜKSEKLİĞİ kadar kaydırır. Bu yüzden QR
    // ZPL VARSAYILANINA (2,3,10) sabitlenir, ardından yürürlükteki ÖNCEKİ
    // durum GERİ YÜKLENİR. Önceki değer kör hard-code EDİLMEZ: komut
    // modelinden, ekleme noktasından önceki SON `^BY` okunur.
    const priorBy = [...document.commands]
      .reverse()
      .find((command) => command.name === 'BY')
    tail.push(
      ...zplCommands(
        `${QR_SCOPE_BY}^FO${placement.x},${placement.y}` +
          `^BQN,2,${placement.magnification}^FDLA,${qr.payload}^FS`,
      ),
    )
    if (priorBy) {
      // Geri yükleme: durum QR ÖNCESİYLE birebir aynı bırakılır, böylece
      // sonradan eklenen hiçbir katman (ürün footer'ı vb.) etkilenmez.
      tail.push({ name: 'BY', args: priorBy.args })
    }
  }

  // (whitelist 5) Aktarma metninin font GENİŞLİĞİ daraltıldıysa uygula.
  // Yükseklik, konum ve gövde DEĞİŞMEZ.
  const transferFontCommand = transfer.field.fontCommand
  if (
    qrFits &&
    transferWidth !== transferNativeWidth &&
    transferFontCommand &&
    transfer.field.font
  ) {
    const { orientation, height } = transfer.field.font
    edits.push({
      type: 'replace',
      target: transferFontCommand,
      commands: [
        {
          name: transferFontCommand.name,
          args: `${orientation ?? 'N'},${height},${transferWidth}`,
        },
      ],
    })
  }

  const pq = document.commands.find((command) => command.name === 'PQ')
  const xz = document.commands.find((command) => command.name === 'XZ')
  const anchor = pq ?? xz
  if (!anchor) {
    return fallback('fallback_semantic_failure', 'etiket sonu bulunamadı', sourceZpl)
  }
  edits.push({ type: 'insertBefore', target: anchor, commands: tail })

  const outputZpl = serializeZplDocument(applyZplEdits(document, edits))

  // ── C) TRANSFORM WHITELIST DOĞRULAMASI ────────────────────────────────
  const outputDocument = parseZplDocument(outputZpl)
  const diff = diffZplAgainstSource(document, outputDocument)
  if (diff.removed.length > 0) {
    return fallback(
      'fallback_whitelist_violation',
      `taşıyıcı komutu silinmiş (${diff.removed.length})`,
      sourceZpl,
    )
  }
  const allowedTransferFont =
    transferWidth !== transferNativeWidth && transfer.field.font
      ? {
          from: `${transfer.field.font.orientation ?? 'N'},${transfer.field.font.height},${transferNativeWidth}`,
          to: `${transfer.field.font.orientation ?? 'N'},${transfer.field.font.height},${transferWidth}`,
        }
      : null
  const unexpected = diff.mutations.filter((mutation) => {
    // (1) Code128 yorum satırı bayrağı Y → N
    if (
      mutation.name === 'BC' &&
      mutation.from.startsWith('N,,Y,N') &&
      mutation.to.startsWith('N,,N,N') &&
      mutation.from.slice('N,,Y,N'.length) === mutation.to.slice('N,,N,N'.length)
    ) {
      return false
    }
    // (6) Dikey "ALICI" başlığı: YALNIZ o alanın gövdesi boşaltılır.
    if (
      mutation.name === 'FD' &&
      headingData !== null &&
      mutation.from === headingData &&
      mutation.to === ''
    ) {
      return false
    }
    // (5) Aktarma metninin font GENİŞLİĞİ — yalnız DARALMA, aynı yükseklik.
    if (
      allowedTransferFont &&
      mutation.name === transferFontCommand?.name &&
      mutation.from === allowedTransferFont.from &&
      mutation.to === allowedTransferFont.to
    ) {
      return false
    }
    return true
  })
  if (unexpected.length > 0) {
    return fallback(
      'fallback_whitelist_violation',
      `beklenmeyen taşıyıcı mutasyonu (^${unexpected[0].name})`,
      sourceZpl,
    )
  }

  // ── B) SEMANTIC INVARIANT DOĞRULAMASI ─────────────────────────────────
  const verdict = verifySuratOutputInvariants(semantic, outputZpl, qr.payload, {
    transferFontWidth: transferWidth,
  })
  if (!verdict.ok) {
    return fallback('fallback_invariant_failure', verdict.reason, sourceZpl)
  }

  return {
    composed: true,
    mode: 'durusoft_composed',
    reason: null,
    zpl: outputZpl,
    diagnostics: {
      fingerprint: semantic.fingerprint,
      code128Digits: counted.digits.length,
      barcodeModules: counted.modules,
      barcodeWidth,
      humanTextTop,
      humanTextBlockWidth: barcodeWidth,
      boldAddressLines: addressLines.length,
      qrSource: qrFits ? qr.source : null,
      qrRejection: qr.payload === null ? qr.rejection : null,
      qrBox,
      qrRenderYOffset: QR_RENDER_Y_OFFSET,
      qrMagnification: qrFits && placement ? placement.magnification : null,
      qrCandidateIndex: qrFits && placement ? placement.candidateIndex : null,
      transferFontWidth: qrFits ? transferWidth : transferNativeWidth,
      transferFontWidthNative: transferNativeWidth,
      diff: {
        mutations: diff.mutations.length,
        allowedMutations: diff.mutations.length,
        unexpectedMutations: 0,
        deletions: diff.removed.length,
        insertions: diff.inserted,
      },
    },
  }
}

export interface SuratInvariantVerdict {
  readonly ok: boolean
  readonly reason: string
}

/**
 * Composed çıktının makine-okunur alanlarını kaynakla karşılaştırır.
 * Bir tanesi bile tutmazsa çıktı REDDEDİLİR.
 */
export function verifySuratOutputInvariants(
  source: SuratSemanticModel,
  outputZpl: string,
  expectedQrPayload: string | null = null,
  expectations: SuratFieldExpectations = {},
): SuratInvariantVerdict {
  const extraction = extractSuratSemanticFields(outputZpl, expectations)
  if (extraction.errors.length > 0) {
    return { ok: false, reason: `çıktıda alan çözülemedi: ${extraction.errors[0]}` }
  }
  for (const key of INVARIANT_KEYS) {
    const before = source.fields[key]
    const after = extraction.fields[key]
    if (!before || !after) return { ok: false, reason: `invariant alanı yok: ${key}` }
    if (before.raw !== after.raw) {
      return { ok: false, reason: `invariant BOZULDU: ${key}` }
    }
  }
  // QR beklendiği gibi mi? (gövde EXACT doğrulanmış değer olmalı)
  const document = parseZplDocument(outputZpl)
  const qrCommands = document.commands.filter((command) => command.name === 'BQ')
  if (expectedQrPayload === null) {
    if (qrCommands.length > 0) {
      return { ok: false, reason: 'beklenmeyen QR üretildi' }
    }
    return { ok: true, reason: '' }
  }
  if (qrCommands.length > 1) {
    return { ok: false, reason: `birden çok QR (${qrCommands.length})` }
  }
  if (qrCommands.length === 1) {
    const index = document.commands.indexOf(qrCommands[0])
    const data = document.commands
      .slice(index + 1)
      .find((command) => command.name === 'FD')
    if (!data || data.args !== `LA,${expectedQrPayload}`) {
      return { ok: false, reason: 'QR gövdesi doğrulanmış değere eşit değil' }
    }
  }
  return { ok: true, reason: '' }
}
