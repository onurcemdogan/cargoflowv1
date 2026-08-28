// TAŞIYICI SINIRI KANITI — AĞA ÇIKMADAN ÖNCE, KALICI OLARAK.
//
// ═══ ÖLÇÜLEN GÜVENLİK AÇIĞI ══════════════════════════════════════════════
// Geri alınamaz komut `server/index.mjs` → `callSuratSoap` içindeki
// `await fetch(SURAT_SOAP_URL, ...)`'tir. Ondan ÖNCEKİ son komut
// `onWireReady(body)` idi ve YALNIZ BELLEKTEKİ ize yazıyordu.
//
// `shipment_operations.carrier_create_called` ise create DÖNDÜKTEN SONRA
// kalıcılaşıyordu. Yani şu pencere vardı:
//
//     fetch gönderildi  ──►  süreç ÖLDÜ  ──►  DB'de carrier_create_called=false
//
// Bir sonraki açılışta kanıt "taşıyıcıya gidilmedi" diyordu ve bayat
// kurtarma işi güvenle kuyruğa alıyordu → İKİNCİ GERÇEK GÖNDERİ.
//
// ═══ ÇÖZÜM: KANIT ÖNCE, İSTEK SONRA ══════════════════════════════════════
// Sınır kanıtı zarf serileştikten ve kimlik paritesi geçtikten SONRA, ama
// `fetch`'ten ÖNCE, BEKLENEREK (awaited) kalıcılaştırılır.
//
//   rezervasyon → zarf → parite → [KANIT YAZ] → fetch → sonucu yaz
//
// Kanıt yazımı ile `fetch` arasında kalan pencere tek bir komut kadardır ve
// orada ölmek "belirsiz" tarafına düşer. İHTİYATLI YÖN DOĞRU YÖNDÜR:
// yanlışlıkla belirsiz demek geri alınabilir (insan inceler), yanlışlıkla
// "gidilmedi" demek İKİNCİ FİZİKSEL GÖNDERİ üretir.
//
// ═══ NEDEN AsyncLocalStorage ═════════════════════════════════════════════
// Worker eşzamanlı çalışır (`AUTO_LABEL_CONCURRENCY`). Modül düzeyinde tek
// bir değişken, iki paketin sınır kanıtını BİRBİRİNE KARIŞTIRIRDI. Async
// bağlam her create çağrısına KENDİ sink'ini bağlar.

import { AsyncLocalStorage } from 'node:async_hooks'

export interface CarrierBoundaryContext {
  /** Ağa çıkılmadan ÖNCE çağrılır; BEKLENİR ve kalıcı olmalıdır. */
  readonly persistBoundaryEntered: () => Promise<void>
  /** Aynı denemede ikinci kez yazmayı önler. */
  entered: boolean
}

const storage = new AsyncLocalStorage<CarrierBoundaryContext>()

/** Create çağrısını kendi sınır bağlamında çalıştırır. */
export function runWithCarrierBoundary<T>(
  context: CarrierBoundaryContext,
  run: () => Promise<T>,
): Promise<T> {
  return storage.run(context, run)
}

/**
 * AĞ SINIRINA GİRİLDİĞİNİ KALICILAŞTIRIR.
 *
 * Bağlam yoksa (elle/tekil yollar dışında bir çağıran) sessizce geçer:
 * kanıt modeli o yolda zaten mevcut davranışıyla korunur. Yazım BAŞARISIZ
 * olursa istisna YUKARI TAŞINIR — kanıt yazılamıyorsa istek GÖNDERİLMEZ.
 */
export async function markCarrierBoundaryEntered(): Promise<void> {
  const context = storage.getStore()
  if (!context || context.entered) return
  // Önce işaretle: yazım sırasında yeniden girilirse çift yazım olmaz.
  context.entered = true
  await context.persistBoundaryEntered()
}

/** Test/teşhis: bu bağlamda sınır kanıtı yazıldı mı? */
export function carrierBoundaryEntered(): boolean {
  return storage.getStore()?.entered === true
}
