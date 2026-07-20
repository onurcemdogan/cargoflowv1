import { defineConfig } from 'drizzle-kit'

// drizzle-kit yapılandırması. `generate`/`check` DB bağlantısı istemez;
// `migrate`/`push` için DATABASE_URL gerekir (repoya asla yazılmaz).
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
})
