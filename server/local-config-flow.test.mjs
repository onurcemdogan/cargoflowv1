import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('Entegrasyon anahtarları yeniden başlatma sonrasında şifreli kalır', async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), 'cargoflow-local-config-'),
  )
  t.after(() => rm(configDirectory, { recursive: true, force: true }))

  const config = {
    trendyol: {
      sellerId: 'seller-local-test',
      apiKey: 'api-key-local-test',
      apiSecret: 'api-secret-local-test',
      environment: 'prod',
      userAgentName: 'CargoFlow',
    },
    surat: {
      kullaniciAdi: 'surat-user-local-test',
      sifre: 'surat-password-local-test',
      firmaId: '42',
      entegrasyonSozlesme: '12345',
      whoPays: 'MARKETPLACE',
    },
  }

  let running = await startApi(configDirectory)
  t.after(() => running.process.kill())

  const saved = await request(running.port, 'PUT', config)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.configured, true)

  const firstRead = await request(running.port, 'GET')
  assert.equal(firstRead.status, 200)
  assert.equal(firstRead.body.config.trendyol.apiKey, config.trendyol.apiKey)
  assert.equal(firstRead.body.config.surat.sifre, config.surat.sifre)
  assert.equal(
    firstRead.body.config.surat.entegrasyonSozlesme,
    config.surat.entegrasyonSozlesme,
  )
  assert.equal(firstRead.body.config.surat.whoPays, config.surat.whoPays)

  const denied = await request(running.port, 'GET', undefined, '192.168.1.50')
  assert.equal(denied.status, 403)

  running.process.kill()
  await waitForExit(running.process)
  running = await startApi(configDirectory)

  const secondRead = await request(running.port, 'GET')
  assert.equal(secondRead.status, 200)
  assert.equal(
    secondRead.body.config.trendyol.apiSecret,
    config.trendyol.apiSecret,
  )

  const encrypted = await readFile(
    join(configDirectory, 'integration-config.enc.json'),
    'utf8',
  )
  assert.doesNotMatch(encrypted, /api-secret-local-test/)
  assert.doesNotMatch(encrypted, /surat-password-local-test/)
})

async function startApi(configDirectory) {
  const port = await getFreePort()
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CARGOFLOW_API_PORT: String(port),
      CARGOFLOW_CONFIG_DIR: configDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  await waitForHealth(port, child)
  return { port, process: child }
}

async function request(port, method, config, clientHost = '127.0.0.1') {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/local-config/integration`,
    {
      method,
      headers: {
        ...(config ? { 'Content-Type': 'application/json' } : {}),
        'X-CargoFlow-Client-Host': clientHost,
      },
      body: config ? JSON.stringify({ config }) : undefined,
    },
  )
  return { status: response.status, body: await response.json() }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`CargoFlow API erken kapandı: ${child.exitCode}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return
    } catch {
      // Sunucunun dinlemeye başlamasını bekle.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('CargoFlow API sağlık kontrolü zaman aşımına uğradı.')
}

function waitForExit(child) {
  if (child.exitCode != null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}
