import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// AYRI dosya: production vite.config.ts DEĞİŞTİRİLMEZ.
// Yalnız gerçek DOM/tıklama testleri için minimal yapılandırma.
export default defineConfig({
  plugins: [react()],
  define: {
    // vite.config.ts'teki define'in test karşılığı; burada git ÇAĞRILMAZ.
    __CARGOFLOW_BUILD_REVISION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    // globals KAPALI: test API'leri açıkça import edilir.
    globals: false,
    setupFiles: ['./src/test/setupDom.ts'],
    include: ['src/test/**/*.test.tsx', 'src/test/**/*.test.ts'],
    // Tam suite 40 jsdom dosyasını paralel koşar; CPU paylaşımında ağır
    // render testleri (tanıtım sahneleri, katalog) tek başına ~1 sn sürerken
    // varsayılan 5 sn'yi aşabiliyor. Sınır, ağır testlerde zaten kullanılan
    // 20 sn'ye hizalanır; askıda kalan test yine başarısız olur.
    testTimeout: 20_000,
  },
})
