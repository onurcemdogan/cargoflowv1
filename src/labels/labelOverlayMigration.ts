// ESKİ (STANDALONE) ŞABLONDAN OVERLAY'E GÖÇ.
//
// ═══ SORUN ═══════════════════════════════════════════════════════════════
// Doğru soyutlamadan ÖNCE yayınlanmış kiracı şablonları etiketin TAMAMINI
// çiziyordu: kendi barkodunu, kendi adresini, kendi alıcı adını. Taban
// katman mimarisinde bu bilgiler taşıyıcının GERÇEK etiketinde ZATEN vardır.
// Eski şablonu olduğu gibi overlay saymak, her alanı İKİ KEZ basmak olurdu —
// üretimde görülen adres üst üste binme hatasının tam olarak aynısı.
//
// ═══ NEDEN OTOMATİK YENİDEN YORUMLAMA YOK ════════════════════════════════
// Bir kiracının AKTİF çıktısı, sürüm yükseltmesiyle KENDİLİĞİNDEN değişemez.
// Bu yüzden göç:
//   · eski şablonu ASLA yerinde değiştirmez (arşiv ve aktif sürüm korunur),
//   · YENİ bir TASLAK üretir,
//   · taslağı KENDİLİĞİNDEN yayınlamaz — operatör görür, onaylar, yayınlar.
//
// ═══ NE DÜŞER, NE KALIR ══════════════════════════════════════════════════
// Taşıyıcının bastığı her alan DÜŞER (kimlik, rota, alıcı/adres bloğu).
// Yalnız taşıyıcı etiketinde BULUNMAYAN kiracı içeriği taşınır: mağaza notu,
// ürün listesi, pazaryeri/sipariş tarihi gibi alanlar.
//
// Taşınan bir öğe taşıyıcı bölgesine denk geliyorsa serbest şeride TAŞINIR;
// sığmıyorsa DÜŞÜRÜLÜR ve uyarı üretilir. Sessiz kayıp YOKTUR: her karar
// `warnings` içinde operatöre bildirilir.
//
// SAF: ağ yok, DOM yok, DB yok.

import {
  LABEL_CANVAS_HEIGHT_MM,
  LABEL_CANVAS_WIDTH_MM,
  rectsOverlap,
} from './labelGeometry.ts'
import {
  isOverlayDocument,
  type LabelDocument,
  type LabelElement,
  type LabelElementType,
} from './labelDocument.ts'
import { zoneBlocksOverlay, type CarrierZone } from './labelBaseLayer.ts'

/**
 * TAŞIYICININ BASTIĞI ALANLAR — overlay'e KOPYALANMAZ.
 *
 * Her giriş, taşıyıcı etiketinde karşılığı olan alanı söyler; uyarı metni
 * operatöre "neden düştü"yü AYNEN açıklar.
 */
const CARRIER_OWNED: Partial<Record<LabelElementType, string>> = {
  barcode: 'Ana barkod',
  qr: 'QR kod',
  trackingText: 'Takip numarası (T.No)',
  recipientName: 'Alıcı adı',
  address: 'Alıcı adresi',
  cityDistrict: 'İl / ilçe',
  phone: 'Alıcı telefonu',
  cargoMeta: 'Desi / paket / taşıyıcı bilgisi',
  orderNumber: 'Sipariş referansı',
}

/**
 * KİRACIYA AİT alanlar — taşıyıcı etiketinde BULUNMAZ, taşınabilir.
 *
 * Beyaz liste kullanılır (kara liste değil): ileride yeni bir öğe türü
 * eklenirse, güvenli olduğu AÇIKÇA söylenene kadar göçe girmez.
 */
const TENANT_OWNED: readonly LabelElementType[] = [
  'staticText',
  'productList',
  'buyerName',
  'orderDate',
  'orderTime',
  'marketplace',
  'packageId',
]

export type MigrationWarningCode =
  | 'CARRIER_OWNED_DROPPED'
  | 'UNKNOWN_ELEMENT_DROPPED'
  | 'RELOCATED_TO_FREE_AREA'
  | 'NO_FREE_AREA_DROPPED'

export interface MigrationWarning {
  code: MigrationWarningCode
  elementId: string
  type: LabelElementType
  detail: string
}

export interface OverlayMigrationResult {
  /** Yayınlanmamış TASLAK. Kaynak şablon DEĞİŞMEZ. */
  draft: LabelDocument
  warnings: MigrationWarning[]
  /** Taşınan öğe sayısı — arayüz özeti için. */
  migratedElements: number
}

/** Bir öğenin kutusu, engelleyici taşıyıcı bölgelerinden herhangi biriyle çakışıyor mu? */
function collidesWithCarrier(
  element: LabelElement,
  zones: readonly CarrierZone[],
): boolean {
  const rect = {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  }
  return zones.some(
    (zone) => zoneBlocksOverlay(zone) && rectsOverlap(zone.rect, rect),
  )
}

/**
 * SERBEST ŞERİT ARAYICI.
 *
 * Etiketin ALTINDAN yukarı doğru tarar ve hiçbir ENGELLEYİCİ taşıyıcı
 * bölgesine değmeyen ilk bandı döner. Sabit koordinat YOKTUR: bölgeler
 * taşıyıcı ZPL'inden geldiği için şablon değişirse şerit de değişir.
 */
export function findFreeStrip(
  zones: readonly CarrierZone[],
  heightMm: number,
  occupied: readonly LabelElement[] = [],
): { x: number; y: number; width: number } | null {
  const margin = 4
  const width = LABEL_CANVAS_WIDTH_MM - margin * 2
  const step = 0.5
  for (
    let y = LABEL_CANVAS_HEIGHT_MM - margin - heightMm;
    y >= margin;
    y -= step
  ) {
    const candidate = { x: margin, y, width, height: heightMm }
    const hitsCarrier = zones.some(
      (zone) => zoneBlocksOverlay(zone) && rectsOverlap(zone.rect, candidate),
    )
    if (hitsCarrier) continue
    const hitsPlaced = occupied.some((element) =>
      rectsOverlap(
        {
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
        },
        candidate,
      ),
    )
    if (hitsPlaced) continue
    return { x: margin, y, width }
  }
  return null
}

/**
 * ESKİ ŞABLONU OVERLAY TASLAĞINA ÇEVİRİR.
 *
 * KAYNAK DEĞİŞMEZ: girdi belge yalnız OKUNUR, yeni bir belge döner.
 *
 * İDEMPOTENT: zaten overlay olan bir belge yeniden göçürülmez — aynı işlem
 * iki kez çalıştırıldığında öğeler ÇOĞALMAZ.
 */
export function migrateStandaloneToOverlay(
  source: LabelDocument,
  carrierZones: readonly CarrierZone[],
  options: { id: string; name?: string; templateFingerprint?: string },
): OverlayMigrationResult {
  const warnings: MigrationWarning[] = []

  // ZATEN OVERLAY: göç YOK. Tekrarlanan göç öğeleri çoğaltamaz.
  if (isOverlayDocument(source)) {
    return {
      draft: {
        ...source,
        id: options.id,
        name: options.name ?? source.name,
        elements: source.elements.map((element) => ({ ...element })),
      },
      warnings,
      migratedElements: source.elements.length,
    }
  }

  const placed: LabelElement[] = []
  for (const element of source.elements ?? []) {
    if (!element) continue
    const carrierLabel = CARRIER_OWNED[element.type]
    if (carrierLabel) {
      warnings.push({
        code: 'CARRIER_OWNED_DROPPED',
        elementId: element.id,
        type: element.type,
        detail:
          `${carrierLabel} taşıyıcı etiketinde ZATEN basılıyor; ` +
          'overlay\'e kopyalanmadı (çift basım olurdu).',
      })
      continue
    }
    if (!TENANT_OWNED.includes(element.type)) {
      warnings.push({
        code: 'UNKNOWN_ELEMENT_DROPPED',
        elementId: element.id,
        type: element.type,
        detail:
          'Bu öğe türünün taşıyıcı tabanı üstünde güvenli olduğu ' +
          'DOĞRULANMADI; taslağa alınmadı.',
      })
      continue
    }

    const copy: LabelElement = { ...element }
    if (collidesWithCarrier(copy, carrierZones) || overlapsPlaced(copy, placed)) {
      const strip = findFreeStrip(carrierZones, copy.height, placed)
      if (!strip) {
        warnings.push({
          code: 'NO_FREE_AREA_DROPPED',
          elementId: element.id,
          type: element.type,
          detail:
            'Taşıyıcı alanlarının dışında bu öğeye yetecek boş yer yok; ' +
            'taslağa alınmadı. Gerekirse elle yerleştirin.',
        })
        continue
      }
      copy.x = strip.x
      copy.y = strip.y
      copy.width = Math.min(copy.width, strip.width)
      warnings.push({
        code: 'RELOCATED_TO_FREE_AREA',
        elementId: element.id,
        type: element.type,
        detail:
          'Öğe taşıyıcı alanının üstüne denk geldiği için serbest şeride ' +
          `taşındı (${strip.x.toFixed(1)}, ${strip.y.toFixed(1)} mm).`,
      })
    }
    placed.push(copy)
  }

  return {
    draft: {
      schemaVersion: 1,
      id: options.id,
      name: options.name ?? `${source.name} (Sürat tabanlı)`,
      basedOn: source.id,
      mode: 'overlay',
      baseTemplateFingerprint: options.templateFingerprint,
      elements: placed,
    },
    warnings,
    migratedElements: placed.length,
  }
}

function overlapsPlaced(
  element: LabelElement,
  placed: readonly LabelElement[],
): boolean {
  const rect = {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  }
  return placed.some((other) =>
    rectsOverlap(
      { x: other.x, y: other.y, width: other.width, height: other.height },
      rect,
    ),
  )
}
