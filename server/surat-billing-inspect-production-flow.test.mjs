import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// FAZ 3D — TEŞHİS ARACININ ÜRETİM ŞEMASIYLA UYUMU.
//
// ÜRETİMDE ÇÖKTÜ: `select settings from organization_settings` — kolonun
// gerçek adı `settings_json`. Tablo üretimde VAR (migration 0004); sorun tablo
// değil, YANLIŞ KOLONDU. Bu paket hem düzeltmeyi hem "teşhis aracı asla SQL
// istisnasıyla çökmez" sözleşmesini kilitler.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const inspect = await import('./shipments/suratBillingInspectCli.ts')
const getCargo = await import('./shipments/suratGetCargoClient.ts')

const nl = (v) => v.split('\r\n').join('\n')
const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []
const INSPECT_FILE = 'server/shipments/suratBillingInspectCli.ts'

const codeOf = (file) =>
  nl(readFileSync(file, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

async function makeDb({ withSettingsTable = true } = {}) {
  const pglite = new PGlite()
  const dir = join(here, '..', 'drizzle')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pglite.exec(statement)
    }
  }
  if (!withSettingsTable) {
    // Tablonun HİÇ olmadığı en kötü durum.
    await pglite.exec('DROP TABLE organization_settings')
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db) {
  const rows = rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('MonalisaToka','monalisa-${randomBytes(3).toString('hex')}')
     returning id`)))
  return String(rows[0].id)
}

/* ═══ KÖK NEDEN ════════════════════════════════════════════════════════ */

test('INSPECT-PROD-0: gercek kolon settings_json — yanlis kolon KULLANILMAZ', () => {
  // YORUMLARI AYIKLA: hatanın kendisi açıklamada anlatılıyor, kodda YOK.
  const code = codeOf(INSPECT_FILE)
  assert.equal(code.includes('select settings from'), false, 'ham yanlis SQL')
  assert.equal(code.includes('settings from organization_settings'), false)
  // Tipli tablo referansı → kolon adı derleyici kontrolünde, bir daha kayamaz.
  assert.ok(code.includes('organizationSettings.settingsJson'))
})

test('INSPECT-PROD-1: settings tablosu YOKSA SQL istisnasi ATILMAZ', async (t) => {
  const { pglite, db } = await makeDb({ withSettingsTable: false })
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const config = await inspect.resolveGetCargoConfig(db, org)
  assert.deepEqual(config, {}, 'cokme YOK, bos yapilandirma')
  assert.equal(getCargo.isGetCargoConfigured(config), false)
})

test('INSPECT-PROD-2: settings_json icindeki suratGetCargo COZULUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const payload = JSON.stringify({
    suratGetCargo: { baseUrl: 'https://ornek.invalid', path: '/api/getCargo' },
  })
  await db.execute(sql`insert into organization_settings
    (organization_id, settings_json) values (${org}, ${payload}::jsonb)`)

  const config = await inspect.resolveGetCargoConfig(db, org)
  assert.equal(config.baseUrl, 'https://ornek.invalid')
  assert.equal(config.path, '/api/getCargo')
  assert.equal(getCargo.isGetCargoConfigured(config), true)
})

test('INSPECT-PROD-3: yapilandirma YOKSA NOT_CONFIGURED (crash DEGIL)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const config = await inspect.resolveGetCargoConfig(db, org)
  assert.deepEqual(config, {})

  const outcome = await getCargo.getSuratCargoByParcelUniqueId({
    parcelUniqueId: '7270035942963454',
    config,
    fetchImpl: async () => {
      throw new Error('AG CAGRISI YAPILMAMALI')
    },
  })
  assert.equal(outcome.status, 'NOT_CONFIGURED')
})

test('INSPECT-PROD-4: yapilandirma YALNIZ --get-cargo ile okunur', () => {
  const code = codeOf(INSPECT_FILE)
  assert.ok(code.includes("hasFlag('get-cargo')"))
  assert.ok(code.includes('resolveGetCargoConfig(db, organizationId)'))
})

test('INSPECT-PROD-5/6: okuma GET; mutasyon yolu REDDEDILIR', async () => {
  const calls = []
  const ok = await getCargo.getSuratCargoByParcelUniqueId({
    parcelUniqueId: '7270035942963454',
    config: { baseUrl: 'https://ornek.invalid', path: '/api/getCargo' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method })
      return new Response(
        JSON.stringify({ whoPays: '3', senderCode: '496056' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
  assert.equal(ok.status, 'OK')
  assert.equal(calls.length, 1, 'TEK salt-okunur istek')
  assert.equal(calls[0].method, 'GET')
  assert.equal(ok.record.billingParty, 'TRENDYOL')

  const refused = await getCargo.getSuratCargoByParcelUniqueId({
    parcelUniqueId: '7270035942963454',
    config: { baseUrl: 'https://ornek.invalid', path: '/api/OrtakBarkodOlustur' },
    fetchImpl: async () => {
      throw new Error('MUTASYON YOLUNA ISTEK ATILMAMALI')
    },
  })
  assert.equal(refused.reason, 'MUTATION_PATH_REFUSED')
})

test('INSPECT-PROD-7/8: cozucu YAZMA yapmaz, yapilandirma DEGERI basmaz', () => {
  const code = codeOf(INSPECT_FILE)
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'migrate(']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  assert.equal(code.includes('console.info(getCargoConfig'), false)
})

test('INSPECT-PROD-10: npm scriptleri .env yukler (yoksa DUSMEZ)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const name of ['surat:billing:scan', 'surat:billing:inspect']) {
    assert.ok(pkg.scripts[name], `${name} tanimli olmali`)
    assert.ok(
      pkg.scripts[name].includes('--env-file-if-exists=.env'),
      `${name} .env yuklemeli`,
    )
    // SERT `--env-file` DEĞİL: dosya yoksa test/CI DÜŞMEMELİ.
    assert.equal(/--env-file=/.test(pkg.scripts[name]), false)
  }
})

test('INSPECT-PROD-11/12: DB yazma 0, migration 0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)

  const statements = []
  const original = pglite.query.bind(pglite)
  pglite.query = (query, ...rest) => {
    statements.push(String(query))
    return original(query, ...rest)
  }
  await inspect.resolveGetCargoConfig(db, org)

  const mutations = statements.filter((s) =>
    /^\s*(insert|update|delete|alter|create|drop|truncate)\b/i.test(s),
  )
  assert.deepEqual(mutations, [], 'cozucu HIC yazmamali')
})

/* ═══ YAPILANDIRMA ANAHTARI KEŞFİ (Faz 3E) ════════════════════════════ */

test('CFG-1: anahtar listesi DEGERLERI basmaz', () => {
  const described = inspect.describeConfigKeys({
    kullaniciAdi: 'GIZLI_KULLANICI',
    sifre: 'GIZLI_SIFRE',
    webPassword: 'GIZLI_WEB',
    getCargoBaseUrl: 'https://gizli.host.invalid',
    entegrasyonFirmasi: 'Trendyol',
    bosAlan: '',
  })
  const text = JSON.stringify(described)
  for (const secret of [
    'GIZLI_KULLANICI', 'GIZLI_SIFRE', 'GIZLI_WEB', 'gizli.host.invalid',
    'Trendyol',
  ]) {
    assert.equal(text.includes(secret), false, `deger sizdi: ${secret}`)
  }
  // Yalnız ad + doluluk + tür ipucu.
  const byKey = Object.fromEntries(described.map((e) => [e.key, e]))
  assert.equal(byKey.sifre.kind, 'secret(masked)')
  assert.equal(byKey.webPassword.kind, 'secret(masked)')
  assert.equal(byKey.getCargoBaseUrl.present, true)
  assert.equal(byKey.bosAlan.present, false)
})

test('CFG-2: anahtarlar SIRALI ve eksiksiz', () => {
  const described = inspect.describeConfigKeys({ b: 1, a: 2, c: 3 })
  assert.deepEqual(described.map((e) => e.key), ['a', 'b', 'c'])
})

test('CFG-3: yapilandirma okunamazsa CROP degil BOS doner', async (t) => {
  const { pglite, db } = await makeDb({ withSettingsTable: false })
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const result = await inspect.inspectConfigKeys(db, org)
  assert.deepEqual(result.settingsKeys, [], 'tablo yoksa cokme YOK')
  assert.ok(Array.isArray(result.suratKeys))
})

test('CFG-4: settings_json anahtarlari listelenir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const payload = JSON.stringify({ suratGetCargo: { baseUrl: 'x' }, digerAyar: 1 })
  await db.execute(sql`insert into organization_settings
    (organization_id, settings_json) values (${org}, ${payload}::jsonb)`)
  const result = await inspect.inspectConfigKeys(db, org)
  assert.deepEqual(result.settingsKeys, ['digerAyar', 'suratGetCargo'])
})
