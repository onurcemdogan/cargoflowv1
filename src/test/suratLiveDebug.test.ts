import { describe, expect, it } from 'vitest'
import {
  LEGACY_DEBUG_STORAGE_KEY, TRACE_RETENTION_MAX_PER_TENANT,
  appendTrace, applyRetention, selectCurrentTrace, selectValidTraces,
} from '../services/suratTraceDebugStore'
import {
  LIVE_DEBUG_TABS, buildLiveDebugViewModel, buildTraceableUserError,
  describeWireWhoPaysForDisplay,
} from '../debug/suratLiveDebugViewModel'

const trace = (id: string, over: Record<string, unknown> = {}) => ({
  traceId: id, schemaVersion: 2,
  createdAt: (over.createdAt as string) ?? '2026-08-18T10:00:00.000Z',
  stages: [
    { stage: 'PRE_FLIGHT', at: 'x', section: 'BILLING', data: {
      billingParty: 'TRENDYOL_PAYS', expectedSuratWhoPays: '3',
      odemeTipi: '1', codEnabled: false, preflightValid: true,
      preflightFailures: [], ...(over.pre as object ?? {}) } },
    { stage: 'ROUTING', at: 'x', section: 'CREDENTIAL_ROUTING', data: {
      credentialRole: 'PRIMARY_MARKETPLACE', credentialSource: 'tenant',
      maskedAccount: '49****56', sifre: 'COK_GIZLI' } },
    { stage: 'REQUEST_READY', at: 'x', section: 'REQUEST', data: {
      wireWhoPaysPresent: false,
      wireWhoPaysReason: 'CONTRACT_HAS_NO_WHO_PAYS_FIELD' } },
    { stage: 'CARRIER_CALL', at: 'x', section: 'SERVICE_ROUTING', data: {} },
    { stage: 'CARRIER_RESPONSE', at: 'x', section: 'RESPONSE', data: {
      businessCode: '016', businessMessage: `yanit-${id}`,
      ...(over.response as object ?? {}) } },
    { stage: 'VERIFICATION', at: 'x', section: 'VERIFICATION', data: {
      trackingPresent: true, barcodePresent: true } },
    { stage: 'FINAL', at: 'x', section: 'FINAL_RESULT', data: {
      carrierCreateStatus: 'SUCCESS', carrierCalled: true,
      ...(over.final as object ?? {}) } },
  ],
})

describe('Canlı Debug — Trace V2 kaynagi', () => {
  it('bes sekme tanimli', () => {
    expect([...LIVE_DEBUG_TABS]).toEqual([
      'Son Deneme', 'Karar / Mapping', 'Request', 'Response', 'Geçmiş',
    ])
  })

  it('eski v1 debug kaydi ADAY DEGILDIR', () => {
    // v1 kaydin zaman damgasi DAHA YENI olsa bile secilemez.
    const legacy = { key: LEGACY_DEBUG_STORAGE_KEY, traceId: 'v1',
      createdAt: '2099-01-01T00:00:00.000Z', stages: [] }
    const current = selectCurrentTrace([legacy, trace('CF-A')])
    expect(current?.traceId).toBe('CF-A')
    expect(selectValidTraces([legacy])).toHaveLength(0)
  })

  it('Son Deneme EN YENI v2 izini secer', () => {
    const older = trace('CF-OLD', { createdAt: '2026-08-18T09:00:00.000Z' })
    const newer = trace('CF-NEW', { createdAt: '2026-08-18T11:00:00.000Z' })
    expect(selectCurrentTrace([older, newer])?.traceId).toBe('CF-NEW')
  })

  it('saklama sayi sinirini uygular', () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      trace(`CF-${index}`))
    expect(applyRetention(many, Date.parse('2026-08-18T12:00:00.000Z')))
      .toHaveLength(TRACE_RETENTION_MAX_PER_TENANT)
  })

  it('yeni deneme basa eklenir', () => {
    const next = appendTrace([trace('CF-A')],
      trace('CF-B', { createdAt: '2026-08-18T11:00:00.000Z' }),
      Date.parse('2026-08-18T12:00:00.000Z'))
    expect(next[0].traceId).toBe('CF-B')
  })
})

describe('Canlı Debug — gorunum modeli', () => {
  it('beklenen ile tel AYRI bolumlerde', () => {
    const model = buildLiveDebugViewModel(trace('CF-A'))!
    expect(model.expected.expectedSuratWhoPays).toBe('3')
    expect(model.wire.wireWhoPaysPresent).toBe(false)
    const wire = describeWireWhoPaysForDisplay(model)
    expect(wire.label).toBe('GÖNDERİLMEDİ')
    expect(wire.reason).toBe('CONTRACT_HAS_NO_WHO_PAYS_FIELD')
    // Bu bir HATA DEGILDIR.
    expect(wire.isError).toBe(false)
  })

  it('uc alan BIRBIRINDEN BAGIMSIZ gosterilir', () => {
    const model = buildLiveDebugViewModel(trace('CF-A'))!
    expect(model.decision.billing.billingParty).toBe('TRENDYOL_PAYS')
    expect(model.decision.payment.odemeTipi).toBe('1')
    expect(model.decision.cod.codEnabled).toBe(false)
    // Odeme/COD bolumleri fatura tarafini TASIMAZ.
    expect(model.decision.payment).not.toHaveProperty('billingParty')
    expect(model.decision.cod).not.toHaveProperty('billingParty')
  })

  it('kimlik rolu/maskeli cari gosterilir, sir GOSTERILMEZ', () => {
    const model = buildLiveDebugViewModel(trace('CF-A'))!
    expect(model.decision.credential.credentialRole).toBe('PRIMARY_MARKETPLACE')
    expect(model.decision.credential.credentialSource).toBe('tenant')
    expect(model.decision.credential.maskedAccount).toBe('49****56')
    expect(JSON.stringify(model)).not.toContain('COK_GIZLI')
  })

  it('Trace A, Trace B yanitini ASLA gostermez', () => {
    const a = buildLiveDebugViewModel(trace('CF-A'))!
    const b = buildLiveDebugViewModel(trace('CF-B'))!
    expect(a.response.businessMessage).toBe('yanit-CF-A')
    expect(b.response.businessMessage).toBe('yanit-CF-B')
    expect(JSON.stringify(a)).not.toContain('yanit-CF-B')
  })

  it('bloklanan deneme: CARRIER_CALL yok', () => {
    // Bloklanan denemede FINAL de `carrierCalled: false` YAZAR (WIRE_BLOCKED
    // dali). Eski fixture burada `true` birakiyordu; arayuz yalnizca
    // `CARRIER_CALL` asamasina baktigi icin celiski GORUNMUYORDU. Trace V2
    // otoritesine gecince fixture'in kendi celiskisi ortaya cikti.
    const blocked = { ...trace('CF-BLOCK', { final: { carrierCalled: false } }),
      stages: trace('CF-BLOCK', { final: { carrierCalled: false } })
        .stages.filter((entry) =>
          ['PRE_FLIGHT', 'ROUTING', 'FINAL'].includes(entry.stage)) }
    const model = buildLiveDebugViewModel(blocked)!
    expect(model.carrierCalled).toBe(false)
    expect(model.stages).not.toContain('CARRIER_CALL')
  })

  it('039 izlenebilir kullanici hatasi uretir', () => {
    const model = buildLiveDebugViewModel(trace('CF-039', {
      response: { businessCode: '039',
        businessMessage: 'Sipariş kaydedildi, barkod oluşturulamadı' },
      final: { carrierCreateStatus: 'FAILED' },
    }))!
    const message = buildTraceableUserError(model)!
    expect(message).toContain('039')
    expect(message).toContain('CF-039')
    expect(message).not.toBe('Barkod oluşturulamadı')
  })

  it('basarili denemede hata mesaji URETILMEZ', () => {
    expect(buildTraceableUserError(buildLiveDebugViewModel(trace('CF-A'))!))
      .toBeNull()
  })

  it('016 varyantlari FARKLI dogrulama tasir', () => {
    const complete = buildLiveDebugViewModel(trace('CF-1'))!
    const partial = { ...trace('CF-2') }
    partial.stages = partial.stages.map((entry) =>
      entry.stage === 'VERIFICATION'
        ? { ...entry, data: { trackingPresent: false, barcodePresent: true } }
        : entry)
    const incomplete = buildLiveDebugViewModel(partial)!
    expect(complete.verification.trackingPresent).toBe(true)
    expect(incomplete.verification.trackingPresent).toBe(false)
  })

  it('iz yoksa model null', () => {
    expect(buildLiveDebugViewModel(null)).toBeNull()
  })
})

describe('Canlı Debug — tekrarlanan asama (append-only)', () => {
  // Trace V2 asamalari EKLEMELIDIR: bir yeniden deneme ya da yeniden eklenen
  // asama, AYNI adla ikinci kez yazilabilir. Sunucu izdusumu boyle bir izde
  // SONUNCU girisi okur. Arayuz ILK girisi okursa operatore BAYAT veri
  // gosterilir, ayni izi okuyan CLI denetcisi ise guncelini gosterir —
  // "ayni iz, iki okuyucu, iki cevap" kusuru (CF-4088628726 ailesi).
  const duplicated = () => {
    const base = trace('CF-DUP')
    return {
      ...base,
      stages: [
        ...base.stages,
        { stage: 'PRE_FLIGHT', at: 'y', section: 'BILLING', data: {
          billingParty: 'SELLER_PAYS', expectedSuratWhoPays: '1',
          odemeTipi: '2', codEnabled: true,
          preflightValid: false, preflightFailures: ['COD_LIMIT'] } },
        { stage: 'REQUEST_READY', at: 'y', section: 'REQUEST', data: {
          wireWhoPaysPresent: true, wireWhoPaysValue: '1' } },
        { stage: 'CARRIER_RESPONSE', at: 'y', section: 'RESPONSE', data: {
          businessCode: '000', businessMessage: 'ikinci-deneme' } },
        { stage: 'VERIFICATION', at: 'y', section: 'VERIFICATION', data: {
          trackingPresent: false, barcodePresent: false } },
        { stage: 'FINAL', at: 'y', section: 'FINAL_RESULT', data: {
          carrierCreateStatus: 'FAILED', carrierCalled: true } },
      ],
    }
  }

  it('SONRAKI girisin verisi gosterilir, ilkininki DEGIL', () => {
    const model = buildLiveDebugViewModel(duplicated())!
    expect(model.expected.billingParty).toBe('SELLER_PAYS')
    expect(model.expected.expectedSuratWhoPays).toBe('1')
    expect(model.decision.billing.billingParty).toBe('SELLER_PAYS')
    expect(model.decision.payment.odemeTipi).toBe('2')
    expect(model.decision.cod.codEnabled).toBe(true)
    expect(model.request.wireWhoPaysPresent).toBe(true)
    expect(model.response.businessMessage).toBe('ikinci-deneme')
    expect(model.verification.trackingPresent).toBe(false)
    expect(model.finalResult.carrierCreateStatus).toBe('FAILED')
  })

  it('bayat ILK giris hicbir alandan SIZMAZ', () => {
    const model = buildLiveDebugViewModel(duplicated())!
    expect(model.preflight.passed).toBe(false)
    expect(model.preflight.failures).toEqual(['COD_LIMIT'])
    // Ilk PRE_FLIGHT gecerliydi, ilk FINAL basariliydi, ilk yanit 016'ydi.
    expect(model.expected.billingParty).not.toBe('TRENDYOL_PAYS')
    expect(JSON.stringify(model)).not.toContain('yanit-CF-DUP')
    expect(buildTraceableUserError(model)).toContain('CF-DUP')
  })

  it('tekrar YOKSA davranis DEGISMEZ', () => {
    const model = buildLiveDebugViewModel(trace('CF-A'))!
    expect(model.expected.billingParty).toBe('TRENDYOL_PAYS')
    expect(model.response.businessMessage).toBe('yanit-CF-A')
  })

  it('arayuz ile sunucu izdusumu AYNI girisi secer', async () => {
    // Iki okuyucu ayni kurala baglidir; biri degisirse bu test duser.
    const { stageData } = await import(
      '../../server/shipments/suratTraceProjection')
    const withDuplicates = duplicated()
    const model = buildLiveDebugViewModel(withDuplicates)!
    expect(stageData(withDuplicates.stages, 'PRE_FLIGHT')?.billingParty)
      .toBe(model.expected.billingParty)
    expect(stageData(withDuplicates.stages, 'CARRIER_RESPONSE')?.businessMessage)
      .toBe(model.response.businessMessage)
    expect(stageData(withDuplicates.stages, 'FINAL')?.carrierCreateStatus)
      .toBe(model.finalResult.carrierCreateStatus)
  })
})

describe('create hatasi mesaji', () => {
  it('etiketin OLUSTUGUNU iddia ETMEZ', async () => {
    const { LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE } =
      await import('../utils/suratPrintFailureReasons')
    // 4085791254: HTTP 200, barkod/takip/ZPL YOK. "olusturuldu" demek yanlisti.
    expect(LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE)
      .not.toContain('oluşturuldu fakat')
    expect(LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE).toContain('doğrulanamadı')
    expect(LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE).not.toMatch(/etiket oluştur\w*u/)
  })
})

/* ═══ UI-TRACE-1 — TRACE V2 OTORİTEDİR ═════════════════════════════ */

describe('UI-TRACE-1: Debug Merkezi taşıyıcı gerçeğini Trace V2 den alır', () => {
  // ÜRETİM İZİ CF-4103661055 — aşamalar CARRIER_CALL_STARTED ile bitti,
  // `CARRIER_CALL` HİÇ yazılmadı ve süreç uygulama istisnasıyla düştü.
  // Eski arayüz yalnız `CARRIER_CALL` arıyordu ve "Taşıyıcı çağrıldı: hayır"
  // gösteriyordu — Trace V2 `carrierCalled=true` derken.
  const crashed = {
    traceId: 'CF-4103661055', schemaVersion: 2,
    createdAt: '2026-08-25T10:00:00.000Z',
    stages: [
      { stage: 'PRE_FLIGHT', at: 'x', section: 'BILLING', data: {
        billingParty: 'TRENDYOL_PAYS', preflightValid: true,
        preflightFailures: [] } },
      { stage: 'ACTUAL_WIRE_READY', at: 'x', section: 'REQUEST', data: {} },
      { stage: 'CARRIER_CALL_STARTED', at: 'x', section: 'SERVICE_ROUTING',
        data: { operation: 'GonderiyiKargoyaGonder' } },
      { stage: 'APPLICATION_EXCEPTION', at: 'x', section: 'RESPONSE', data: {
        carrierCalled: true, carrierCreateStatus: 'UNKNOWN',
        carrierBusinessResponseReceived: false } },
      { stage: 'FINAL', at: 'x', section: 'FINAL_RESULT', data: {
        carrierCalled: true, carrierCreateStatus: 'UNKNOWN' } },
    ],
  }

  it('CARRIER_CALL yokken bile cagri BASLADIYSA evet der', () => {
    const model = buildLiveDebugViewModel(crashed as never)
    expect(model?.carrierCalled).toBe(true)
  })

  it('taşıyıcı IS YANITI ile ag cagrisini KARISTIRMAZ', () => {
    const model = buildLiveDebugViewModel(crashed as never)
    expect(model?.carrierBusinessResponseReceived).toBe(false)
    expect(model?.applicationException).toBe(true)
  })

  it('gercek is yaniti alindiginda ikisi de dogrudur', () => {
    const model = buildLiveDebugViewModel(trace('CF-OK') as never)
    expect(model?.carrierCalled).toBe(true)
    expect(model?.carrierBusinessResponseReceived).toBe(true)
    expect(model?.applicationException).toBe(false)
  })
})
