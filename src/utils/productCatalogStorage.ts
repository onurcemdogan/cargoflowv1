import type { ProductCatalogCacheEnvelope } from '../types/cargoflow'

const DATABASE_NAME = 'cargoflow-catalog-v1'
const STORE_NAME = 'productCatalogs'

export async function loadPersistedProductCatalog(
  key: string,
): Promise<ProductCatalogCacheEnvelope | null> {
  if (typeof indexedDB === 'undefined') return null
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(key)
    request.onsuccess = () =>
      resolve((request.result as ProductCatalogCacheEnvelope | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

export async function savePersistedProductCatalog(
  key: string,
  catalog: ProductCatalogCacheEnvelope,
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(catalog, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
