// AÇIK BASKI SEÇİMİ — NİYET ÇÖZÜMLEYİCİSİ (SAF: DOM/ağ/IO YOK).
//
// ═══ ÜRETİMDE ÖLÇÜLEN KUSUR ══════════════════════════════════════════════
// Operatör birden çok sipariş seçip "Yazdır" diyor, Chrome penceresi
// açılıyor ve İÇİNDE TEK SAYFA oluyordu.
//
// Kaybın yeri baskı belgesi DEĞİLDİ. `App` şu kuralı kullanıyordu:
//
//     includePreviouslyPrinted = selectedOrders.every(daha önce basılmış)
//
// `orderWorkflowService.printLabels` ise bu bayrak `false` iken daha önce
// basılmış HER siparişi aday listesinden DÜŞÜRÜR. Sonuç:
//
//   seçim                         bayrak   belgeye giren
//   5 basılmış                    true     5   ✔
//   4 basılmış + 1 yeni           false    1   ✘  ← "tek sayfa" şikâyeti
//   1 basılmış (tekli baskı)      true     1   ✔
//
// `every()` yüzünden KARIŞIK seçim çöküyordu; tekli baskı tek elemanlı
// `every()` ile daima `true` ürettiği için HİÇ bozulmuyordu. Tekli ve
// toplu yolun ayrıştığı nokta BURASIYDI — belge üreticisi değil.
//
// Üstelik kayıp SESSİZE YAKINDI: kardinalite kilidi "beklenen 1, gerçek 1"
// görüp geçiyordu, çünkü belgeye gerçekten tek sayfa girmişti.
//
// ═══ KURAL: AÇIK SEÇİM = AÇIK NİYET ══════════════════════════════════════
// Operatör kutuyu işaretleyip "Yazdır"a bastıysa o siparişi basmak İSTİYOR
// demektir. Daha önce basılmış olması siparişi seçimden DÜŞÜRMEZ.
//
// NEDEN BU YÖN GÜVENLİ: tekrar baskı taşıyıcıya ÇIKMAZ (kalıcı READY
// artefakt kullanılır), yeni gönderi OLUŞTURMAZ, ücret DOĞURMAZ; bedeli
// bir yaprak kâğıttır. Sessizce DÜŞÜRMENİN bedeli ise etiketsiz giden bir
// kolidir. İki hata eşdeğer değildir.
//
// ═══ SESSİZ DEĞİL ════════════════════════════════════════════════════════
// Tekrar basılacak siparişler AYRICA raporlanır (`reprintOrderNumbers`);
// operatör neyin yeniden basıldığını görür. `printLabels` de bu kayıtlara
// `REPRINT` geçmişi yazmaya DEVAM eder.
//
// ═══ SERVİS SÖZLEŞMESİ GEVŞEMEDİ ═════════════════════════════════════════
// `printLabels(..., { includePreviouslyPrinted })` davranışı AYNEN durur:
// bayrak `false` iken basılmış kayıt hâlâ atlanır (print-flow Test 6/8).
// Değişen tek şey, AÇIK SEÇİM yolunun o bayrağı nasıl hesapladığıdır.

/** Niyet çözümü için gereken EN AZ sipariş şekli. */
export interface PrintSelectionCandidate {
  readonly orderNumber?: unknown
  readonly labelStatus?: unknown
  readonly label?: { readonly printedAt?: unknown } | null
}

export interface PrintSelectionIntent {
  /**
   * `printLabels` için bayrak. Açık seçimde DAİMA `true`: seçilen hiçbir
   * sipariş sessizce düşürülmez.
   */
  readonly includePreviouslyPrinted: boolean
  /** Daha önce basılmış ve bu koşuda TEKRAR basılacak sipariş numaraları. */
  readonly reprintOrderNumbers: readonly string[]
  readonly selectedCount: number
}

/** Sipariş daha önce GERÇEKTEN basılmış mı? (durum + zaman damgası) */
export function isPreviouslyPrintedOrder(
  order: PrintSelectionCandidate | null | undefined,
): boolean {
  if (!order) return false
  return (
    order.labelStatus === 'PRINTED' && Boolean(order.label?.printedAt)
  )
}

/**
 * Operatörün AÇIKÇA seçtiği siparişler için baskı niyeti.
 *
 * Boş seçim `false` döner: "hiçbir şey seçilmedi" bir onay DEĞİLDİR.
 */
export function resolveExplicitPrintSelectionIntent(
  selectedOrders: readonly PrintSelectionCandidate[],
): PrintSelectionIntent {
  const reprintOrderNumbers = selectedOrders
    .filter((order) => isPreviouslyPrintedOrder(order))
    .map((order) => String(order.orderNumber ?? '').trim())
    .filter(Boolean)
  return Object.freeze({
    includePreviouslyPrinted: selectedOrders.length > 0,
    reprintOrderNumbers: Object.freeze(reprintOrderNumbers),
    selectedCount: selectedOrders.length,
  })
}

/** Operatöre gösterilecek TEK kısa satır; tekrar baskı yoksa boş. */
export function describeReprintNotice(intent: PrintSelectionIntent): string {
  const count = intent.reprintOrderNumbers.length
  if (count === 0) return ''
  return (
    ` ${count} sipariş daha önce basılmıştı ve seçildiği için tekrar basıldı: ` +
    `${intent.reprintOrderNumbers.join(', ')}.`
  )
}
