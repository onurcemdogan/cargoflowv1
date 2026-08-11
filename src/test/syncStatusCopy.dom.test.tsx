import { expect, test } from 'vitest'
import { resolveLastSuccessfulSyncAt } from '../utils/orderSyncStatus'
import type { CargoOrder } from '../types/cargoflow'

// A) MARKA REFERANSI TEMİZLİĞİ  B) SON SENKRONİZASYON DURUMU
//
// Bu paket YALNIZ sunum/state bağlantısını kilitler. Satış hesapları, rapor
// günü (UTC), Türkiye saat gösterimi ve sync algoritması KAPSAM DIŞIDIR.

// NOT: kaynak-dosya sozlesmeleri (COPY-1..4, SYNC-STATUS-6/7/PERSIST/
// NO-BACKEND-CHANGE) node tarafinda server/sync-status-copy-flow.test.mjs
// icinde kilitlenir; burada SAF cozumleyici davranisi sinanir.

const order = (lastMarketplaceSyncedAt?: string): CargoOrder =>
  ({
    id: `o-${lastMarketplaceSyncedAt ?? 'none'}`,
    orderNumber: 'ORD-1',
    marketplace: 'Trendyol',
    items: [],
    lastMarketplaceSyncedAt,
  }) as unknown as CargoOrder

test('SYNC-STATUS-1: hiç sync yoksa değer YOK (UI "Bekleniyor" gösterir)', () => {
  expect(resolveLastSuccessfulSyncAt([], undefined)).toBeUndefined()
  expect(resolveLastSuccessfulSyncAt([order(undefined)], undefined)).toBeUndefined()
})

test('SYNC-STATUS-2: kalıcı veride sync damgası varsa ilk yüklemede GÖSTERİLİR', () => {
  // Oturum içi sync YOK (sayfa yeni açıldı) ama kalıcı sipariş damgalı.
  const value = resolveLastSuccessfulSyncAt(
    [order('2026-08-10T21:00:00.000Z'), order('2026-08-09T10:00:00.000Z')],
    undefined,
  )
  expect(value).toBe('2026-08-10T21:00:00.000Z')
})

test('SYNC-STATUS-4: başarılı yenileme sonrası oturum damgası kazanır', () => {
  const value = resolveLastSuccessfulSyncAt(
    [order('2026-08-10T21:00:00.000Z')],
    '2026-08-11T09:00:00.000Z',
  )
  expect(value).toBe('2026-08-11T09:00:00.000Z')
})

test('SYNC-STATUS-5: yeniden mount → damga KAYBOLMAZ', () => {
  const orders = [order('2026-08-10T21:00:00.000Z')]
  // Remount: oturum state'i sıfırlanır (undefined), kalıcı veri kalır.
  expect(resolveLastSuccessfulSyncAt(orders, undefined)).toBe(
    '2026-08-10T21:00:00.000Z',
  )
})

test('SYNC-STATUS-8: geçersiz/bozuk damga sonucu kirletmez', () => {
  expect(
    resolveLastSuccessfulSyncAt([order('gecersiz-tarih')], undefined),
  ).toBeUndefined()
  expect(
    resolveLastSuccessfulSyncAt(
      [order('gecersiz-tarih'), order('2026-08-10T21:00:00.000Z')],
      undefined,
    ),
  ).toBe('2026-08-10T21:00:00.000Z')
})
