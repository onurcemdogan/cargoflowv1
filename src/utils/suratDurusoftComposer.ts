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
  type ZplField,
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
import { fieldTextBox } from './zplTextGeometry.ts'
import {
  resolveSuratQrPayload,
  type SuratQrRejection, type SuratQrResolution, type SuratQrSource,
} from './suratQrPayload.ts'

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
   * TAŞIYICININ KENDİ QR'ı büyütüldüyse uygulanan geometri; büyütme
   * güvenli değilse null (kaynak AYNEN korunmuştur).
   */
  readonly carrierQr: {
    readonly x: number
    readonly y: number
    readonly size: number
    readonly magnification: number
    /**
     * Yazıcının DÜZELTMEDEN ÖNCE gerçekten uyguladığı büyütme. Bozuk
     * token'da niyet edilen değerden farklıdır — düzeltmenin ne kadar
     * kazandırdığı ancak bu değerle okunur.
     */
    readonly effectiveMagnification: number
  } | null
  /** Dikey sipariş referansı güvenli kenara kaydırıldıysa; aksi halde null. */
  readonly orderReferenceShift: {
    readonly fromX: number
    readonly x: number
    readonly fromInkLeft: number
    readonly inkLeft: number
  } | null
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


/**
 * TAŞIYICININ KENDİ QR'ını OKUNABİLİR HALE GETİRME.
 *
 * ═══ KÖK NEDEN — ÖLÇÜLDÜ ═════════════════════════════════════════════════
 * Taşıyıcı şablonu QR'ı şu komutla basar (bayt bayt, sondaki BOŞLUK dahil):
 *
 *     ^FT690,650^BQN,4,4 ^FDQA,7270034422363739^FS
 *
 * Üçüncü parametre (magnification) `"4 "` biçimindedir. Bu SAYI DEĞİLDİR:
 * ayrıştırıcı parametreyi geçersiz sayar ve VARSAYILAN büyütmeye (1) düşer.
 * 799×799 gerçek render ile ölçüldü:
 *
 *     ^BQN,4,4   (sonda boşluk)  →  21×21 dot  (büyütme 1 — 2.6 mm)
 *     ^BQN,2,4                   →  84×84 dot  (büyütme 4)
 *     ^BQN,2,5                   → 105×105 dot (büyütme 5)
 *     ^BQN,4,5                   → 105×105 dot (model alanı ETKİSİZ)
 *
 * Yani sahadaki "QR çok küçük" şikâyeti bir tercih değil, BOZUK BİR
 * PARAMETRE TOKEN'ının sonucudur: etiket 21 modülü 21 dota basıyor, modül
 * kenarı 0.125 mm oluyor ve hiçbir el terminali okuyamıyor.
 *
 * ═══ DÜZELTME ════════════════════════════════════════════════════════════
 * Token normalize edilir ve büyütme, GEOMETRİNİN İZİN VERDİĞİ EN BÜYÜK
 * değere çıkarılır. Yük, model, yönelim ve konum bandı DEĞİŞMEZ; okunan
 * veri birebir aynıdır.
 *
 * ═══ GÜVENLİK ════════════════════════════════════════════════════════════
 * Büyütme YALNIZ geometri KANITLANDIĞINDA uygulanır: büyümüş kare, sessiz
 * bölgesiyle birlikte etiket kenarına ve dikey bandıyla kesişen HİÇBİR
 * komşunun işgal kutusuna değmeyecekse. Aksi halde kaynak AYNEN korunur.
 */
const CARRIER_QR_MODULES = 21
/** Version-1 QR (ECC Q) sayısal kapasitesi. Üstünde modül sayısı ARTAR. */
const CARRIER_QR_MAX_NUMERIC_V1 = 27
/** Geçersiz parametrede ayrıştırıcının düştüğü büyütme (ölçüldü). */
const QR_DEFAULT_MAGNIFICATION = 1
/** Büyükten küçüğe denenir; ilk GÜVENLİ olan uygulanır. */
const CARRIER_QR_MAGNIFICATION_CANDIDATES: readonly number[] = [6, 5]
/**
 * `^FT` ile konumlanan `^BQ`'nun render'da kutunun ÜSTÜNE eklediği pay
 * (büyütme başına 7 dot — ölçüldü). Band hesabı iki yorumu da KAPSAR.
 */
const QR_FT_LIFT_PER_MAGNIFICATION = 7

export interface CarrierQrEnlargement {
  readonly x: number
  readonly y: number
  readonly magnification: number
  readonly size: number
  /** Kaynak token bozuk olduğu için yazıcının GERÇEKTEN kullandığı değer. */
  readonly effectiveMagnification: number
}

/** `^BQ` argümanlarındaki magnification TOKEN'ı (3. parametre), ham haliyle. */
function qrMagnificationToken(args: string): string {
  return String(args ?? '').split(',')[2] ?? ''
}

/**
 * Yazıcının GERÇEKTEN uygulayacağı büyütme.
 *
 * Token temiz bir tamsayı DEĞİLSE (örn. `"4 "`) parametre geçersizdir ve
 * varsayılan büyütme yürürlüğe girer. Niyet edilen değeri okumak burada
 * YANLIŞ olurdu: sorunun ta kendisi, niyet ile uygulananın ayrışmasıdır.
 */
function effectiveQrMagnification(args: string): number {
  const token = qrMagnificationToken(args)
  if (!/^\d+$/.test(token)) return QR_DEFAULT_MAGNIFICATION
  const parsed = Number.parseInt(token, 10)
  return parsed > 0 ? parsed : QR_DEFAULT_MAGNIFICATION
}

/** `^BQ` argümanlarında YALNIZ büyütmeyi değiştirir; diğerleri AYNEN. */
function withQrMagnification(args: string, magnification: number): string {
  const parts = String(args ?? '').split(',')
  while (parts.length < 3) parts.push('')
  parts[2] = String(magnification)
  return parts.join(',')
}

export function resolveCarrierQrEnlargement(
  qrField: ZplField | undefined,
  occupancy: readonly QrOccupancyBox[],
): CarrierQrEnlargement | null {
  if (!qrField?.codeCommand || qrField.positionType !== 'FT') return null
  const effective = effectiveQrMagnification(qrField.codeCommand.args)

  // MODÜL SAYISI VARSAYIMI KANITLANIR: yalnız Version-1'e sığdığı KESİN olan
  // kısa sayısal yükte büyütülür. Daha uzun yük daha çok modül demektir ve
  // 21 modül varsayımı sessizce yanlış olurdu.
  const payload = String(qrField.data ?? '')
  const digits = payload.replace(/^[A-Za-z]{1,2},/, '')
  if (!/^\d+$/.test(digits) || digits.length > CARRIER_QR_MAX_NUMERIC_V1) {
    return null
  }

  for (const magnification of CARRIER_QR_MAGNIFICATION_CANDIDATES) {
    if (magnification <= effective) continue
    const size = CARRIER_QR_MODULES * magnification
    const quietZone = QR_QUIET_MODULES * magnification
    // ^FT yorumu belirsizdir (kutu tabanı mı, tabandan 7×m yukarısı mı);
    // band İKİSİNİ DE kapsar, böylece hangi yorum geçerli olursa olsun
    // çakışma kontrolü GEÇERLİDİR.
    const bandTop = qrField.y - size - QR_FT_LIFT_PER_MAGNIFICATION * magnification
    const bandBottom = qrField.y
    if (bandTop - quietZone < 0) continue
    if (bandBottom + quietZone > LABEL_EDGE) continue

    const maxLeft = LABEL_EDGE - quietZone - size
    let requiredLeft = 0
    for (const box of occupancy) {
      const intersectsVertically = box.top <= bandBottom && bandTop <= box.bottom
      if (!intersectsVertically) continue
      requiredLeft = Math.max(requiredLeft, box.right + quietZone)
    }
    if (requiredLeft > maxLeft) continue
    // Mevcut yerinden GÖRSEL olarak kaymaması için EN SAĞ güvenli konum
    // tercih edilir; QR yalnız BÜYÜR.
    const x = Math.min(Math.max(qrField.x, requiredLeft), maxLeft)
    if (x < requiredLeft) continue

    return {
      x,
      y: qrField.y,
      magnification,
      size,
      effectiveMagnification: effective,
    }
  }
  return null
}

/**
 * SOL DİKEY REFERANS ALANININ GÜVENLİ x KONUMU.
 *
 * ═══ SORUN ═══════════════════════════════════════════════════════════════
 * Taşıyıcı, dikey sipariş referansını (`Siparis No: 727...`) `^FT25,706`
 * `^A0B` ile basar. Döndürülmüş `^FT` alanı taban çizgisinin SOLUNA uzadığı
 * için (bkz. zplTextGeometry ölçümleri) gerçek sütun x≈5..28'dedir —
 * ETİKETİN EN SOLDAKİ MÜREKKEBİ budur; taşıyıcının kendi dikey "SURAT KARGO"
 * rayı bile 4 dot daha içeridedir. Medya birkaç mm kaydığında ilk kırpılan
 * alan bu olur; "bazen çıkmıyor" şikâyetinin fiziksel karşılığı budur.
 *
 * ═══ ÇÖZÜM ═══════════════════════════════════════════════════════════════
 * Sütun, taşıyıcının KENDİ yerleşiminin izin verdiği KADAR sağa alınır:
 * sağdaki ilk engelin (dikey kural / DataMatrix / metin) soluna sabit bir
 * boşluk bırakan konuma. Engeller ZPL geometrisinden türetilir; sabit
 * koordinat YOKTUR. Kaydırma bir dot bile kazandırmıyorsa alan AYNEN kalır.
 *
 * ═══ NEDEN "MÜMKÜN OLAN EN SAĞ" ══════════════════════════════════════════
 * Kırpılma etiketin KENARINDA olur; alanlar arası göreli boşluklar medya
 * kaymasından etkilenmez. Bu yüzden doğru hedef "kenardan olabildiğince
 * uzak, komşusundan sabit boşlukta" konumdur.
 */

/** Döndürülmüş glifin hücre sınırını aşan mürekkebi (ölçüldü: ≤4 dot). */
const GLYPH_OVERSHOOT_DOTS = 4
/** Kaydırılan sütun ile sağındaki ilk engel arasındaki en az boşluk (1 mm). */
const RAIL_MIN_GAP_DOTS = 8
/** Kaydırmanın anlamlı sayılması için gereken en az kazanç. */
const MIN_SHIFT_GAIN_DOTS = 2
/**
 * HEDEF SOL MÜREKKEP MARJI — 24 dot = 3.0 mm (203 dpi).
 *
 * Termal transfer yazıcılarda medya hizası ±1.5 mm oynayabilir; 3 mm içerik
 * marjı bu oynamayı kırpılma olmadan karşılar ve etiket baskısında yerleşik
 * güvenli alan ölçüsüdür. Hedefe ULAŞILAMIYORSA komşunun izin verdiği EN
 * SAĞ konum kullanılır — hiç kaydırmamak yerine kazanılabilecek kadarı
 * kazanılır; kaydırma hiç kazandırmıyorsa alan AYNEN kalır.
 */
const TARGET_INK_MARGIN_DOTS = 24
/** Döndürülmüş glifin hücrenin SOLUNDA bıraktığı boşluk (ölçüldü). */
const GLYPH_INK_INSET_DOTS = 5

interface BlockingBox {
  readonly left: number
  readonly top: number
  readonly bottom: number
}

/**
 * Bir alanın SOL sınırı ve dikey uzanımı.
 *
 * MODELLENEMEYEN alan ENGEL SAYILIR (tüm dikey aralık): tanımadığımız bir
 * komut yüzünden kaydırma yapmak, bilmediğimiz bir şeyin üstüne basmaktır.
 */
function blockingBox(field: ZplField): BlockingBox | null {
  if (field.kind === 'text') {
    const box = fieldTextBox(field)
    // Gövdesi BOŞ metin basılmaz; engel değildir.
    if (!box) return null
    return { left: box.x, top: box.y, bottom: box.y + box.height }
  }
  if (field.kind === 'graphic') {
    const args = (field.codeCommand?.args ?? '').split(',')
    const width = Number.parseInt(args[0] ?? '', 10)
    const height = Number.parseInt(args[1] ?? '', 10)
    const thickness = Number.parseInt(args[2] ?? '', 10)
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null
    const stroke = Number.isFinite(thickness) ? Math.max(thickness, 1) : 1
    const span = Math.max(height, stroke)
    // Gerçek şablonda `^GB` daima `^FO` (sol üst) ile konumlanır. `^FT` ile
    // konumlanmış bir kutu ise TABANDAN yukarı çizilir; hangisi olduğunu
    // varsaymak yerine band İKİ YORUMU DA kapsar — engel hesabında fazla
    // kapsamak GÜVENLİ yöndür.
    return {
      left: field.x,
      top: field.positionType === 'FT' ? field.y - span : field.y,
      bottom: field.y + span,
    }
  }
  if (field.kind === 'datamatrix') {
    return {
      left: field.x,
      top: field.y - DATA_MATRIX_MAX_HEIGHT,
      bottom: field.y,
    }
  }
  if (field.kind === 'code128') {
    const height = Number.parseInt(
      (field.byCommand?.args ?? '').split(',')[2] ?? '',
      10,
    )
    if (!Number.isFinite(height) || height <= 0) {
      return { left: field.x, top: -Infinity, bottom: Infinity }
    }
    return { left: field.x, top: field.y - height, bottom: field.y }
  }
  if (field.kind === 'qr') {
    const magnification = effectiveQrMagnification(field.codeCommand?.args ?? '')
    const size = CARRIER_QR_MODULES * magnification
    // ^FT ve ^FO yorumlarını BİRLİKTE kapsayan en kötü durum bandı.
    const lift =
      field.positionType === 'FT'
        ? size + QR_FT_LIFT_PER_MAGNIFICATION * magnification
        : 0
    return {
      left: field.x,
      top: field.y - lift,
      bottom: field.y + (field.positionType === 'FT' ? 0 : QR_RENDER_Y_OFFSET + size),
    }
  }
  return { left: field.x, top: -Infinity, bottom: Infinity }
}

export interface VerticalReferenceShift {
  readonly x: number
  readonly fromX: number
  /** Kaydırma sonrası sol MÜREKKEP kenarı — kırpılma payının ölçüsü. */
  readonly inkLeft: number
  readonly fromInkLeft: number
}

export function resolveVerticalReferenceShift(
  referenceField: ZplField | undefined,
  neighbours: readonly ZplField[],
): VerticalReferenceShift | null {
  if (!referenceField) return null
  if (referenceField.positionType !== 'FT') return null
  if (referenceField.font?.orientation !== 'B') return null
  const cell = referenceField.font?.height ?? 0
  const fontWidth = referenceField.font?.width ?? 0
  const text = String(referenceField.data ?? '')
  if (cell <= 0 || fontWidth <= 0 || !text.trim()) return null

  // ═══ İKİ FARKLI GENİŞLİK MODELİ — BİLİNÇLİ ══════════════════════════
  // KENDİ uzanımı için composer'ın KALİBRE modeli (`estimateA0Width`,
  // karakter başına ilerleme tablosu) kullanılır: burada FAZLA tahmin,
  // olmayan bir çakışma uydurup kaydırmayı engellerdi.
  // KOMŞULAR için `fieldTextBox`'ın kaba, GENİŞ modeli kullanılır: orada
  // fazla tahmin GÜVENLİ yöndür.
  const run = estimateA0Width(text, fontWidth)
  // Döndürülmüş `^FT` alanı taban çizgisinin SOLUNA ve YUKARISINA uzar.
  const own = {
    x: referenceField.x - cell,
    y: referenceField.y - run,
    width: cell,
    height: run,
  }

  let limit = LABEL_EDGE
  for (const other of neighbours) {
    if (other === referenceField) continue
    const box = blockingBox(other)
    if (!box) continue
    // Sütunun SOLUNDA kalan bir alan sağa kaymayı sınırlamaz.
    if (box.left <= own.x) continue
    const overlapsVertically =
      box.top <= own.y + own.height && own.y <= box.bottom
    if (!overlapsVertically) continue
    limit = Math.min(limit, box.left)
  }

  // Hücrenin SAĞ kenarı = taban çizgisi x. Mürekkep hücreyi ≤4 dot aşar.
  const maxX = limit - RAIL_MIN_GAP_DOTS - GLYPH_OVERSHOOT_DOTS
  // Hedef: sol MÜREKKEP kenarı güvenli marja otursun. Mürekkep hücrenin
  // solundan GLYPH_INK_INSET_DOTS kadar içeride başlar.
  const targetX =
    TARGET_INK_MARGIN_DOTS - GLYPH_INK_INSET_DOTS + own.width
  const shifted = Math.min(targetX, maxX)
  if (shifted - referenceField.x < MIN_SHIFT_GAIN_DOTS) return null
  return {
    x: shifted,
    fromX: referenceField.x,
    inkLeft: shifted - own.width + GLYPH_INK_INSET_DOTS,
    fromInkLeft: own.x + GLYPH_INK_INSET_DOTS,
  }
}

function fallback(
  mode: SuratComposeMode,
  reason: string,
  sourceZpl: string,
): SuratComposedLabel {
  return { composed: false, mode, reason, zpl: sourceZpl, diagnostics: null }
}

/**
 * `^FT`/`^FO` argümanında YALNIZ x,y değiştirir; ek parametreler (hizalama
 * gibi) AYNEN korunur.
 */
function replacePositionXY(args: string, x: number, y: number): string {
  const parts = String(args ?? '').split(',')
  const rest = parts.slice(2)
  return [String(x), String(y), ...rest].join(',')
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
  //
  // ═══ TAŞIYICI BÖLGEYE SAHİPSE HİÇBİR ŞEY YAZILMAZ ═══════════════════
  // Parser, bold adres bölgesinin taşıyıcı tarafından DOLDURULDUĞUNU
  // (`carrierOwnsAddressBlock`) tespit edip `boldAddressSlots`'u boşaltır.
  // Bu sinyal OKUNMUYORDU: composer sabit `BOLD_ADDRESS_BASELINES`'a
  // koşulsuz yazıyordu. Sonuç, ÜRETİMDE GÖRÜLEN hataydı — aynı taban
  // çizgisinde taşıyıcının `A0` (genişlik 25) metni ile bizim `A@`
  // (genişlik 10) çift vuruşumuz üst üste biniyor, adres okunamaz hale
  // geliyordu.
  //
  // Doğru davranış: bölge taşıyıcınınsa adres ZATEN basılıdır; ikinci bir
  // kopya EKLENMEZ. Bölge boşsa (v1 şablonu) eskisi gibi devralınır.
  const carrierOwnsAddressBlock = semantic.carrierOwnsAddressBlock === true
  const addressLines = carrierOwnsAddressBlock ? [] : semantic.addressLines
  if (
    !carrierOwnsAddressBlock &&
    (addressLines.length === 0 ||
      addressLines.length > semantic.boldAddressSlots.length ||
      addressLines.length > BOLD_ADDRESS_BASELINES.length)
  ) {
    return fallback(
      'fallback_semantic_failure',
      `bold adres için uygun satır sayısı yok (${addressLines.length}/${semantic.boldAddressSlots.length})`,
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
  //
  // TAŞIYICI ZATEN QR BASIYORSA composer İKİNCİSİNİ EKLEMEZ. Aynı gönderi
  // için iki QR, tarayıcıda hangisinin okunacağını belirsizleştirir.
  const carrierAlreadyPrintsQr = Number(semantic.sourceQrCount ?? 0) > 0
  const qr: SuratQrResolution = carrierAlreadyPrintsQr
    ? {
        payload: null, source: null, rejection: null,
        diagnostic: 'kaynak QR taşıyor; composer ikinci QR EKLEMEZ',
      }
    : resolveSuratQrPayload({
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

  // ── 4) TAŞIYICININ KENDİ QR'ı: FİZİKSEL OKUNABİLİR BOYUT ─────────────
  //
  // Composer kendi QR'ını EKLEMEDİĞİ durumda (taşıyıcı zaten basıyor) tek
  // yapabileceği, VAR OLAN QR'ı okunabilir modül boyutuna çıkarmaktır.
  // İşgal listesi, seçilen aktarma genişliğiyle YENİDEN kurulur: QR
  // yerleşimi hangi tipografiyle doğrulandıysa büyütme de onunla sınanır.
  const carrierQrField = carrierAlreadyPrintsQr
    ? semantic.zplFields.find((field) => field.kind === 'qr')
    : undefined
  const carrierQrEnlargement = resolveCarrierQrEnlargement(
    carrierQrField,
    buildOccupancy(transferWidth),
  )

  // ── 5) SOL DİKEY SİPARİŞ REFERANSI: GÜVENLİ BASKI KENARI ─────────────
  //
  // Dikey "ALICI" başlığı bu çıktıda GÖRÜNMEZ kılınıyor (whitelist 6); bu
  // yüzden komşuluk hesabına GİRMEZ. Basılmayan bir metni engel saymak,
  // kaydırmayı sahte bir çakışmaya kurban ederdi.
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
  const orderReferenceField = fields.orderReference?.field
  const orderReferenceShift = resolveVerticalReferenceShift(
    orderReferenceField,
    semantic.zplFields.filter((field) => field !== headingField),
  )

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
  // `addressLines` taşıyıcı bölgeye sahipse BOŞTUR → hiçbir vuruş eklenmez.
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

  // (whitelist 7) taşıyıcı QR'ının büyütmesi 4 → 5.
  //
  // İKİ KOMUT, TEK NİYET: `^BQ` argümanındaki büyütme ile `^FT` konumu
  // birlikte değişir; konum değişmiyorsa yalnız büyütme yazılır.
  const carrierQrArgsBefore = carrierQrField?.codeCommand?.args ?? null
  const carrierQrArgsAfter =
    carrierQrEnlargement && carrierQrArgsBefore !== null
      ? withQrMagnification(
          carrierQrArgsBefore,
          carrierQrEnlargement.magnification,
        )
      : null
  const carrierQrPositionBefore =
    carrierQrEnlargement && carrierQrField
      ? carrierQrField.positionCommand.args
      : null
  const carrierQrPositionAfter =
    carrierQrEnlargement && carrierQrField && carrierQrPositionBefore !== null
      ? replacePositionXY(
          carrierQrPositionBefore,
          carrierQrEnlargement.x,
          carrierQrEnlargement.y,
        )
      : null
  if (
    carrierQrEnlargement &&
    carrierQrField?.codeCommand &&
    carrierQrArgsAfter !== null
  ) {
    edits.push({
      type: 'replace',
      target: carrierQrField.codeCommand,
      commands: [{ name: 'BQ', args: carrierQrArgsAfter }],
    })
    if (carrierQrPositionAfter !== null && carrierQrPositionAfter !== carrierQrPositionBefore) {
      edits.push({
        type: 'replace',
        target: carrierQrField.positionCommand,
        commands: [
          {
            name: carrierQrField.positionCommand.name,
            args: carrierQrPositionAfter,
          },
        ],
      })
    }
  }

  // (whitelist 8) dikey sipariş referansı güvenli kenara kaydırılır.
  const orderReferencePositionBefore =
    orderReferenceShift && orderReferenceField
      ? orderReferenceField.positionCommand.args
      : null
  const orderReferencePositionAfter =
    orderReferenceShift && orderReferenceField && orderReferencePositionBefore !== null
      ? replacePositionXY(
          orderReferencePositionBefore,
          orderReferenceShift.x,
          orderReferenceField.y,
        )
      : null
  if (
    orderReferenceField &&
    orderReferencePositionAfter !== null &&
    orderReferencePositionAfter !== orderReferencePositionBefore
  ) {
    edits.push({
      type: 'replace',
      target: orderReferenceField.positionCommand,
      commands: [
        {
          name: orderReferenceField.positionCommand.name,
          args: orderReferencePositionAfter,
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
    // (7) Taşıyıcı QR'ının büyütülmesi — YALNIZ hesaplanan değere.
    if (
      mutation.name === 'BQ' &&
      carrierQrArgsBefore !== null &&
      carrierQrArgsAfter !== null &&
      mutation.from === carrierQrArgsBefore &&
      mutation.to === carrierQrArgsAfter
    ) {
      return false
    }
    if (
      carrierQrPositionAfter !== null &&
      mutation.name === carrierQrField?.positionCommand.name &&
      mutation.from === carrierQrPositionBefore &&
      mutation.to === carrierQrPositionAfter
    ) {
      return false
    }
    // (8) Dikey sipariş referansının güvenli kenara kaydırılması.
    if (
      orderReferencePositionAfter !== null &&
      mutation.name === orderReferenceField?.positionCommand.name &&
      mutation.from === orderReferencePositionBefore &&
      mutation.to === orderReferencePositionAfter
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
      carrierQr: carrierQrEnlargement
        ? {
            x: carrierQrEnlargement.x,
            y: carrierQrEnlargement.y,
            size: carrierQrEnlargement.size,
            magnification: carrierQrEnlargement.magnification,
            effectiveMagnification: carrierQrEnlargement.effectiveMagnification,
          }
        : null,
      orderReferenceShift: orderReferenceShift
        ? {
            fromX: orderReferenceShift.fromX,
            x: orderReferenceShift.x,
            fromInkLeft: orderReferenceShift.fromInkLeft,
            inkLeft: orderReferenceShift.inkLeft,
          }
        : null,
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
  // ═══ KAYNAKTA ZATEN QR OLABİLİR ══════════════════════════════════════
  //
  // Taşıyıcının güncel şablonu (v2) QR'ı KENDİSİ basıyor. Değişmez kontrolü
  // "composer QR eklemediyse çıktıda QR OLMAMALI" varsayarsa, taşıyıcının
  // kendi QR'ını bizim ürettiğimiz sanıp geçerli etiketi REDDEDER.
  //
  // Beklenen QR sayısı = kaynaktaki + composer'ın eklediği. Composer, kaynak
  // zaten QR taşıyorsa İKİNCİSİNİ EKLEMEZ (çift QR basılmaz).
  const sourceQrCount = Number(source.sourceQrCount ?? 0)
  if (expectedQrPayload === null) {
    if (qrCommands.length > sourceQrCount) {
      return { ok: false, reason: 'beklenmeyen QR üretildi' }
    }
    return { ok: true, reason: '' }
  }
  if (qrCommands.length > sourceQrCount + 1) {
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
