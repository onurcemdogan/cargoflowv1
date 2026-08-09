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
 * `^A0` için karakter ilerlemesinin ÜST SINIRI (genişlik parametresinin katı).
 * Ölçüm: rakamlar 0.482×w, büyük harfler 0.56×w. Üst sınır olarak 0.60
 * kullanılır — sığma kontrolleri bu yüzden temkinli tarafta yanılır.
 */
const A0_ADVANCE_RATIO = 0.6

/**
 * İndirilmiş TrueType (`^A@…TT0003M_`) için karakter ilerlemesinin üst sınırı.
 * zebrash yedek fontunda 11.96 dot ölçüldü; gerçek TT0003M_ metrikleri
 * bilinmediği için 13 dot ile temkinli sınır konur.
 */
const TRUETYPE_ADVANCE_DOTS = 13

/** Bold adres bloğunun sağ sınırı (alıcı kutusunun sağ dikey çizgisi 773). */
const BOLD_ADDRESS_RIGHT_LIMIT = 765

/** QR: model 2, magnification 5 → 21 modül × 5 = 105 dot (version 1). */
const QR_MAGNIFICATION = 5
const QR_SIZE = 105
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
const QR_SCOPE_BY = '^BY2,3,10'
const QR_RENDER_Y_OFFSET = 10
const QR_PREFERRED_X = 645
const QR_Y = 596
const QR_QUIET_ZONE = 16
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
function estimateA0Width(text: string, fontWidth: number): number {
  return Math.ceil(text.length * fontWidth * A0_ADVANCE_RATIO)
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

  // Rota ve aktarma metinlerinin sağ uçlarının ÜST SINIRI; QR bunların
  // sağında ve quiet-zone kadar uzağında durmalıdır.
  const occupiedRight = Math.max(
    route.field.x + estimateA0Width(route.text, route.field.font?.width ?? 0),
    transfer.field.x + estimateA0Width(transfer.text, transfer.field.font?.width ?? 0),
  )
  const requiredLeft = occupiedRight + QR_QUIET_ZONE
  const maxLeft = LABEL_EDGE - QR_QUIET_ZONE - QR_SIZE
  const qrLeft = Math.max(QR_PREFERRED_X, requiredLeft)
  const qrGeometrySafe =
    qrLeft <= maxLeft &&
    QR_Y + QR_RENDER_Y_OFFSET + QR_SIZE + QR_QUIET_ZONE <= LABEL_EDGE

  // E) DOĞRULANMIŞ 727 VARSA QR ZORUNLUDUR. Sığmıyorsa QR'sız kısmi DuruSoft
  //    etiketi üretmek YERİNE composer tümüyle reddeder.
  if (qr.payload !== null && !qrGeometrySafe) {
    return fallback(
      'fallback_geometry_failure',
      'QR güvenli alana sığmıyor (qrRejection=geometry_conflict)',
      sourceZpl,
    )
  }
  const qrFits = qr.payload !== null
  // Kutu ZPL ORIGIN'ini taşır; renderer'da +QR_RENDER_Y_OFFSET kadar aşağıda
  // görünür. Güvenlik kontrolleri iki yorumu da kapsayan bandı kullanır.
  const qrBox = qrFits ? { x: qrLeft, y: QR_Y, size: QR_SIZE } : null

  // ── DÜZENLEMELER ──────────────────────────────────────────────────────
  const document = semantic.document
  const edits: ZplEdit[] = []

  // (whitelist 1) yorum satırı bayrağı Y → N — TEK carrier mutasyonu.
  edits.push({
    type: 'replace',
    target: codeCommand,
    commands: [{ name: 'BC', args: `N,,N,N${codeCommand.args.slice('N,,Y,N'.length)}` }],
  })

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
  if (qrFits && qr.payload) {
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
        `${QR_SCOPE_BY}^FO${qrLeft},${QR_Y}` +
          `^BQN,2,${QR_MAGNIFICATION}^FDLA,${qr.payload}^FS`,
      ),
    )
    if (priorBy) {
      // Geri yükleme: durum QR ÖNCESİYLE birebir aynı bırakılır, böylece
      // sonradan eklenen hiçbir katman (ürün footer'ı vb.) etkilenmez.
      tail.push({ name: 'BY', args: priorBy.args })
    }
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
  const unexpected = diff.mutations.filter(
    (mutation) =>
      !(
        mutation.name === 'BC' &&
        mutation.from.startsWith('N,,Y,N') &&
        mutation.to.startsWith('N,,N,N') &&
        mutation.from.slice('N,,Y,N'.length) === mutation.to.slice('N,,N,N'.length)
      ),
  )
  if (unexpected.length > 0) {
    return fallback(
      'fallback_whitelist_violation',
      `beklenmeyen taşıyıcı mutasyonu (^${unexpected[0].name})`,
      sourceZpl,
    )
  }

  // ── B) SEMANTIC INVARIANT DOĞRULAMASI ─────────────────────────────────
  const verdict = verifySuratOutputInvariants(semantic, outputZpl, qr.payload)
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
): SuratInvariantVerdict {
  const extraction = extractSuratSemanticFields(outputZpl)
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
