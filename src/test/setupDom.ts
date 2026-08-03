import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// YALNIZ DOM temizliği. globals kapalı olduğu için Testing Library'nin
// otomatik cleanup'ı devreye girmez; her testten sonra açıkça çağrılır.
afterEach(() => {
  cleanup()
})
