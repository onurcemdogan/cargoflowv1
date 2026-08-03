// Sürat create operasyonları için UYGULAMA KAPSAMLI in-flight kaydı.
//
// NEDEN: sunucu tarafında shipment_operations.status = 'pending' vardır, fakat
// bu değer istemcideki CargoOrder'a TAŞINMAZ. Order üzerinde yalnız
// operationStatus === 'SHIPMENT_PENDING' gibi türev bir sinyal bulunur. Bu
// yüzden "aynı sipariş için halen süren create" durumu yalnız sunucu
// verisinden GÜVENİLİR biçimde çıkarılamaz.
//
// Bu kayıt YALNIZ İSTEMCİ korumasıdır; sunucudaki idempotency (operation key)
// sözleşmesinin YERİNE GEÇMEZ, onunla birlikte çalışır. Yeni bir lifecycle
// TANIMLAMAZ — sadece aynı paket kimliği için ikinci çağrıyı engeller ve
// devam eden Promise'i yeniden kullanır.
//
// Sözleşme:
//  - create BAŞLAMADAN kaydedilir
//  - finally içinde temizlenir (hata/başarı fark etmez)
//  - aynı kimlik için mevcut Promise YENİDEN KULLANILIR (ikinci istek yok)
//  - retry ancak önceki Promise terminal olduktan SONRA mümkündür
//  - unmount kaydı temizlemez: süren gerçek operasyon iptal EDİLMEZ

const activeOperations = new Map<string, Promise<unknown>>()

export function isOperationInFlight(identity: string): boolean {
  return activeOperations.has(String(identity))
}

export function inFlightOperationCount(): number {
  return activeOperations.size
}

// Aynı kimlik için ikinci çağrı YAPILMAZ; devam eden Promise döner.
export function runExclusiveOperation<T>(
  identity: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = String(identity)
  const existing = activeOperations.get(key)
  if (existing) return existing as Promise<T>

  const run = (async () => {
    try {
      return await task()
    } finally {
      // Terminal olur olmaz temizlenir; retry ancak bundan SONRA mümkündür.
      activeOperations.delete(key)
    }
  })()
  activeOperations.set(key, run)
  return run
}

// Yalnız testler için: kayıt durumunu sıfırlar.
export function resetOperationRegistry(): void {
  activeOperations.clear()
}

// Siparişin canonical (sunucu türevli) "işlem sürüyor" göstergesi.
// SHIPMENT_PENDING mevcut canonical operationStatus değeridir; yeni statü
// UYDURULMAZ.
export function hasPendingServerOperation(order: {
  operationStatus?: unknown
}): boolean {
  const status = String(order?.operationStatus ?? '')
    .trim()
    .toUpperCase()
  return status === 'SHIPMENT_PENDING' || status === 'CREATE_IN_PROGRESS'
}
