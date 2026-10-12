// KALICI ETİKET HİDRASYONU — ÜRETİM SEMANTİĞİ, TEST EDİLEBİLİR BİÇİMDE.
//
// ═══ NEDEN AYRI MODÜL ════════════════════════════════════════════════════
//
// Bu mantık App.tsx içinde bir closure olarak yaşıyordu ve dışa
// aktarılmadığı için ÜRETİM ZİNCİRİ TEST EDİLEMİYORDU. "3 sipariş seçildi,
// 1 sayfa basıldı" hatası tam da bu test edilemeyen aralıkta yaşadı:
// alt katmanların hepsi 3 üretiyordu, ama gerçek caller'ın kullandığı bu
// halka hiçbir testin görüş alanında değildi.
//
// DAVRANIŞ DEĞİŞMEDİ. Kod App.tsx'ten OLDUĞU GİBİ taşındı; tek fark
// bağımlılığın (fetchPersistedLabel) dışarıdan verilebilmesi.
//
// ═══ SÖZLEŞME ════════════════════════════════════════════════════════════
//
//  1) KARDİNALİTE KORUNUR. Dönen `effectiveOrders` GİRDİ ile AYNI
//     uzunluktadır ve AYNI sıradadır. Bu fonksiyon sipariş ELEMEZ.
//  2) BASILABİLİR ÇIKTIYI SUNUCU BELİRLER. `barcodeRaw`/`technicalZpl`
//     taşıyıcı KAYNAKTIR; istemci onları basılabilir çıktı olarak SEÇMEZ.
//  3) Sunucu "basılamaz" dediyse ETKİN kopyadan kaynak temizlenir; istemci
//     kendi fallback'ini ÜRETMEZ.
//  4) `null` yanıt = sunucu yetkisi yok (legacy mod) → sipariş DOKUNULMADAN
//     geçer, mevcut davranış korunur.
import type { CargoOrder } from '../types/cargoflow'
import {
  applyServerPrintContract,
  isReprintEligible,
  resolvePersistedLabelArtifact,
  stripClientPrintSources,
  type ServerPrintContract,
} from '../utils/persistedLabel'

export interface PersistedLabelFetchResult {
  hasPrintableLabel: boolean
  zpl: string | null
  source: string | null
  desi: number | null
  print: ServerPrintContract | null
}

export interface HydratePersistedLabelsDeps {
  /** Tenant-scoped kayıtlı etiket okuma. Legacy modda `null` döner. */
  fetchPersistedLabel: (
    orderId: string,
  ) => Promise<PersistedLabelFetchResult | null>
}

export interface HydratePersistedLabelsResult {
  /** GİRDİYLE AYNI uzunlukta ve sırada. */
  effectiveOrders: CargoOrder[]
  /** Etiketi olduğu hâlde sunucudan basılabilir sözleşme alınamayanlar. */
  unresolved: string[]
  /**
   * KARDİNALİTE İZİ — üretimde sipariş kaybını görünür kılar.
   * PII taşımaz; yalnız sayılar.
   */
  cardinality: {
    requestedIds: number
    baseOrders: number
    eligible: number
    contracts: number
    blocked: number
    untouched: number
    effectiveOrders: number
  }
}

/**
 * Baskıya girecek siparişleri sunucu sözleşmesiyle hidratlar.
 *
 * SİPARİŞ ELEMEZ: `effectiveOrders` her zaman `baseOrders` ile aynı
 * uzunluktadır. Basılamaz siparişler LİSTEDEN ÇIKARILMAZ; yalnız kaynakları
 * temizlenir ve aşağı akıştaki baskı kapısı onları eler. Bu ayrım, toplu
 * baskıda "sipariş sessizce kayboldu" durumunu yapısal olarak imkânsız kılar.
 */
export async function hydratePersistedLabels(
  orderIds: string[],
  baseOrders: CargoOrder[],
  deps: HydratePersistedLabelsDeps,
): Promise<HydratePersistedLabelsResult> {
  const idSet = new Set(orderIds)
  const contractById = new Map<string, ServerPrintContract | null>()
  const blocked = new Set<string>()
  const unresolved: string[] = []

  const eligible = baseOrders.filter(
    (order) => idSet.has(order.id) && isReprintEligible(order),
  )
  await Promise.all(
    eligible.map(async (order) => {
      const artifact = resolvePersistedLabelArtifact(order)
      try {
        const fetched = await deps.fetchPersistedLabel(order.id)
        // `null` = sunucu yetkisi YOK (legacy mod, uç mevcut değil).
        // Bu durumda mevcut istemci davranışı AYNEN korunur.
        if (fetched === null) return
        if (fetched.print?.carrierPrintReady && fetched.print.zpl) {
          contractById.set(order.id, fetched.print)
          return
        }
        // SUNUCU "BASILAMAZ" DEDİ. `technicalZpl` mevcut diye bu karar
        // EZİLMEZ; istemci kendi fallback'ini ÜRETMEZ.
        blocked.add(order.id)
        if (artifact.hasPrintableLabel) unresolved.push(order.orderNumber)
      } catch {
        // Bilinmeyen hata fail-open ETMEZ: kaynağa düşülmez.
        blocked.add(order.id)
        if (artifact.hasPrintableLabel) unresolved.push(order.orderNumber)
      }
    }),
  )

  // KARDİNALİTE KORUNUR: map, filter DEĞİL.
  const effectiveOrders =
    contractById.size === 0 && blocked.size === 0
      ? baseOrders
      : baseOrders.map((order) => {
          if (blocked.has(order.id)) return stripClientPrintSources(order)
          const contract = contractById.get(order.id)
          if (!contract) return order
          return applyServerPrintContract(order, contract)
        })

  return {
    effectiveOrders,
    unresolved,
    cardinality: {
      requestedIds: orderIds.length,
      baseOrders: baseOrders.length,
      eligible: eligible.length,
      contracts: contractById.size,
      blocked: blocked.size,
      untouched: eligible.length - contractById.size - blocked.size,
      effectiveOrders: effectiveOrders.length,
    },
  }
}

export const LABEL_LOOKUP_CONCURRENCY = 6

/**
 * KAYITLI ETİKET KEŞFİ — istemcide etiketi hidrate edilmemiş siparişler.
 *
 * `hydratePersistedLabels` yalnız "etiketi var" GÖRÜNEN siparişlere sorar.
 * Kargoya verilmiş ya da gönderi izi olan sipariş istemcide etiketsiz
 * görünebilir; bunlar için create AÇILMAZ, kayıtlı etiket sunucudan aranır.
 * Provider'a ÇIKILMAZ (yalnız tenant-scoped kayıtlı etiket okuması).
 *
 * Sınırlı eşzamanlılık: 25 sipariş 25 ardışık tur DEĞİLDİR. Basılabilirliğe
 * yine SUNUCU karar verir; sözleşme gelmeyen sipariş DEĞİŞMEDEN döner.
 */
export async function discoverPersistedLabels(
  orderIds: string[],
  baseOrders: CargoOrder[],
  deps: HydratePersistedLabelsDeps,
  options: { concurrency?: number } = {},
): Promise<{ orders: CargoOrder[]; resolvedIds: string[] }> {
  const idSet = new Set(orderIds.map(String))
  const targets = baseOrders.filter((order) => idSet.has(String(order.id)))
  const contracts = new Map<string, ServerPrintContract>()
  let cursor = 0
  const limit = Math.max(1, Math.min(Number(options.concurrency ?? LABEL_LOOKUP_CONCURRENCY), targets.length))
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const order = targets[cursor]
        cursor += 1
        if (!order) return
        try {
          const fetched = await deps.fetchPersistedLabel(order.id)
          if (fetched?.print?.carrierPrintReady && fetched.print.zpl) {
            contracts.set(String(order.id), fetched.print)
          }
        } catch {
          // Bulunamadı/okunamadı: sipariş DEĞİŞMEZ, çağıran açık sebeple atlar.
        }
      }
    }),
  )
  if (contracts.size === 0) return { orders: baseOrders, resolvedIds: [] }
  const orders = baseOrders.map((order) => {
    const contract = contracts.get(String(order.id))
    if (!contract) return order
    const applied = applyServerPrintContract(order, contract)
    return { ...applied, hasPrintableLabel: true }
  })
  return { orders, resolvedIds: [...contracts.keys()] }
}
