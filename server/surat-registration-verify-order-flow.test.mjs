import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ÜRETİM ÇÖKMESİ — CF-4103661055 (paket 4103661055).
//
// Taşıyıcı çağrısı BAŞLADI (carrierCallStarted=true, carrierCalled=true) ve
// ardından uygulama şu istisnayla düştü:
//
//   Cannot access 'verifyRegistrationReadOnly' before initialization
//
// Sebep: `const` ok fonksiyonu TANIMLANMADAN ÖNCE çağrıldı (temporal dead
// zone). Sonuç: taşıyıcıda mutasyon başlamış, yerel sonuç YOK.
//
// Bu paket kusuru YAPISAL olarak imkânsız kılar: bildirimi HOIST EDİLEN bir
// fonksiyon bildirimine çevirir ve sırayı testle kilitler.

const source = readFileSync('server/index.mjs', 'utf8')
const lines = source.split(String.fromCharCode(10))

const findLine = (predicate) =>
  lines.findIndex((line) => predicate(line.trim()))

test('REGVERIFY-TDZ-1: kullanim TANIMDAN once GELEMEZ', () => {
  const firstUse = findLine(
    (line) => line.includes('verifyRegistrationReadOnly()')
      && !line.startsWith('async function')
      && !line.startsWith('const verifyRegistrationReadOnly'),
  )
  const declaration = findLine(
    (line) => line.startsWith('async function verifyRegistrationReadOnly')
      || line.startsWith('const verifyRegistrationReadOnly'),
  )
  assert.ok(firstUse >= 0, 'cagri BULUNMALI')
  assert.ok(declaration >= 0, 'tanim BULUNMALI')
  // `const` ok fonksiyonu TDZ'ye tabidir: tanimdan once cagrilirsa PATLAR.
  const isHoistedDeclaration = lines[declaration].trim()
    .startsWith('async function verifyRegistrationReadOnly')
  assert.ok(
    isHoistedDeclaration || firstUse > declaration,
    'TDZ: const ok fonksiyonu tanimdan ONCE cagriliyor '
    + `(kullanim satiri ${firstUse + 1}, tanim ${declaration + 1})`,
  )
})

test('REGVERIFY-TDZ-2: bagimlilik YAPISAL olarak hoist edilir', () => {
  // Fonksiyon BILDIRIMI kapsam basina hoist olur; yeniden siralamayla
  // bozulamaz. `const` olsaydi ayni hata tekrar mumkun olurdu.
  assert.ok(
    source.includes('async function verifyRegistrationReadOnly('),
    'salt-okunur teyit HOIST EDILEN bildirim OLMALI',
  )
  assert.equal(
    source.includes('const verifyRegistrationReadOnly ='), false,
    'const ok fonksiyonu TDZ riskini geri getirir',
  )
})
