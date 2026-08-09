// ZPL II — SIRALI KOMUT MODELİ.
//
// Amaç: taşıyıcının gerçek technicalZpl'i üzerinde regex zinciriyle değil,
// KOMUT KİMLİĞİ üzerinden cerrahi değişiklik yapabilmek.
//
// Tasarım sözleşmesi:
//  1) KAYIPSIZ. parse → serialize her girdi için BAYT BAYT aynı çıktıyı verir.
//     Bilinmeyen komutlar, satır sonları, boşluklar ve komut sonrası artıklar
//     `args` içinde ham olarak taşınır; hiçbir şey normalize EDİLMEZ.
//  2) DÜZENLEMELER KİMLİK ÜZERİNDEN. `applyZplEdits` hedefi indeksle değil
//     komut nesnesiyle bulur; araya ekleme yapıldığında indeksler kaymaz.
//  3) YORUM YAPMAZ. Model ^FD gövdesini decode etmez, ^FH çözmez, koordinat
//     düzeltmesi uygulamaz. Anlamlandırma üst katmanın (semantic parser) işi.

export type ZplOrientation = 'N' | 'R' | 'I' | 'B'

export interface ZplCommand {
  /** Komut adı, `^` HARİÇ, kaynaktaki yazımıyla: 'XA','FT','A0','A@','MM'… */
  readonly name: string
  /** Komut adından sonraki HAM metin (satır sonları ve artıklar dahil). */
  readonly args: string
}

export interface ZplDocument {
  /** İlk `^` işaretinden önceki ham metin (normalde boş). */
  readonly prologue: string
  readonly commands: readonly ZplCommand[]
}

/** `^A0N,23,24` / `^A@N,15,10,TT0003M_` gibi font komutunun çözümü. */
export interface ZplFontSpec {
  /** Komut adı: 'A0', 'A@', 'AA'… */
  readonly command: string
  /** Font kimliği: '0', '@', 'A'… */
  readonly fontId: string
  /** Açıkça yazılmışsa yön; yazılmamışsa null (yürürlükteki ^FW geçerli). */
  readonly orientation: ZplOrientation | null
  readonly height: number
  readonly width: number
  /** Yalnız `^A@` için indirilmiş font adı (TT0003M_ gibi), aksi halde null. */
  readonly fontName: string | null
}

export type ZplFieldKind =
  | 'text'
  | 'graphic'
  | 'code128'
  | 'datamatrix'
  | 'qr'
  | 'other'

export interface ZplField {
  /** Alanın konum komutu: '^FO' (sol üst) veya '^FT' (taban çizgisi). */
  readonly positionType: 'FO' | 'FT'
  readonly x: number
  readonly y: number
  readonly positionCommand: ZplCommand
  /** Alanı kapatan `^FS` komutu; kapanmamışsa null. */
  readonly endCommand: ZplCommand | null
  readonly fontCommand: ZplCommand | null
  readonly font: ZplFontSpec | null
  readonly dataCommand: ZplCommand | null
  /** `^FD` gövdesi HAM haliyle (^FH decode EDİLMEZ). */
  readonly data: string | null
  readonly kind: ZplFieldKind
  /** Alanı oluşturan tüm komutlar, konum komutundan `^FS`'e kadar. */
  readonly commands: readonly ZplCommand[]
  /** Barkod/2B kod komutu (BC/BX/BQ) — yoksa null. */
  readonly codeCommand: ZplCommand | null
  /** Alandan hemen önce gelen `^BY` komutu — yoksa null. */
  readonly byCommand: ZplCommand | null
}

const ORIENTATIONS: ReadonlySet<string> = new Set(['N', 'R', 'I', 'B'])

/**
 * ZPL metnini sıralı komut listesine çevirir. KAYIPSIZDIR.
 *
 * Sınır: `^` karakteri komut ayracı sayılır. ZPL'de veri gövdesinde çıplak `^`
 * bulunması zaten geçersizdir (ZPL onu komut başlangıcı olarak yorumlar), bu
 * yüzden model ile yazıcı aynı şeyi görür.
 */
export function parseZplDocument(zpl: string): ZplDocument {
  const first = zpl.indexOf('^')
  if (first < 0) {
    return { prologue: zpl, commands: [] }
  }
  const prologue = zpl.slice(0, first)
  const commands: ZplCommand[] = []
  let cursor = first
  while (cursor < zpl.length) {
    const next = zpl.indexOf('^', cursor + 1)
    const end = next < 0 ? zpl.length : next
    const body = zpl.slice(cursor + 1, end)
    // Komut adı ZPL II'de iki karakterdir (^FO, ^A0, ^A@, ^MM…). Gövde daha
    // kısaysa (bozuk/kırpılmış girdi) ne varsa ad kabul edilir; kayıp olmaz.
    const nameLength = Math.min(2, body.length)
    commands.push({
      name: body.slice(0, nameLength),
      args: body.slice(nameLength),
    })
    cursor = end
  }
  return { prologue, commands }
}

/** Komut modelini yeniden ZPL metnine çevirir. `parse` ile birebir terstir. */
export function serializeZplDocument(document: ZplDocument): string {
  let out = document.prologue
  for (const command of document.commands) {
    out += `^${command.name}${command.args}`
  }
  return out
}

/**
 * ZPL parçacığını (örn. `^FO16,700^A0N,20,20^FDx^FS`) komut listesine çevirir.
 * Ekleme yükü üretmek için kullanılır; parçacık `^` ile başlamalıdır.
 */
export function zplCommands(snippet: string): ZplCommand[] {
  const parsed = parseZplDocument(snippet)
  if (parsed.prologue !== '') {
    throw new Error('zplCommands: parçacık `^` ile başlamalı')
  }
  return [...parsed.commands]
}

export type ZplEdit =
  | { readonly type: 'insertBefore'; readonly target: ZplCommand; readonly commands: readonly ZplCommand[] }
  | { readonly type: 'insertAfter'; readonly target: ZplCommand; readonly commands: readonly ZplCommand[] }
  | { readonly type: 'replace'; readonly target: ZplCommand; readonly commands: readonly ZplCommand[] }
  | { readonly type: 'remove'; readonly target: ZplCommand }

/**
 * Düzenlemeleri komut KİMLİĞİ üzerinden uygular; indeks kaymasından etkilenmez.
 * Hedef belgede bulunamazsa hata verir (sessiz kayıp yok).
 */
export function applyZplEdits(
  document: ZplDocument,
  edits: readonly ZplEdit[],
): ZplDocument {
  if (edits.length === 0) return document
  const before = new Map<ZplCommand, ZplCommand[]>()
  const after = new Map<ZplCommand, ZplCommand[]>()
  const replaced = new Map<ZplCommand, readonly ZplCommand[] | null>()
  const present = new Set(document.commands)

  for (const edit of edits) {
    if (!present.has(edit.target)) {
      throw new Error(`applyZplEdits: hedef komut belgede yok (^${edit.target.name})`)
    }
    if (edit.type === 'insertBefore') {
      before.set(edit.target, [...(before.get(edit.target) ?? []), ...edit.commands])
    } else if (edit.type === 'insertAfter') {
      after.set(edit.target, [...(after.get(edit.target) ?? []), ...edit.commands])
    } else if (edit.type === 'replace') {
      if (replaced.has(edit.target)) {
        throw new Error(`applyZplEdits: aynı komut iki kez değiştirilemez (^${edit.target.name})`)
      }
      replaced.set(edit.target, edit.commands)
    } else {
      if (replaced.has(edit.target)) {
        throw new Error(`applyZplEdits: aynı komut iki kez değiştirilemez (^${edit.target.name})`)
      }
      replaced.set(edit.target, null)
    }
  }

  const out: ZplCommand[] = []
  for (const command of document.commands) {
    const pre = before.get(command)
    if (pre) out.push(...pre)
    if (replaced.has(command)) {
      const substitute = replaced.get(command)
      if (substitute) out.push(...substitute)
    } else {
      out.push(command)
    }
    const post = after.get(command)
    if (post) out.push(...post)
  }
  return { prologue: document.prologue, commands: out }
}

/** Belgedeki ilk `name` komutunu döndürür. */
export function findCommand(
  document: ZplDocument,
  name: string,
): ZplCommand | null {
  return document.commands.find((command) => command.name === name) ?? null
}

/** Belgedeki tüm `name` komutlarını döndürür. */
export function findCommands(
  document: ZplDocument,
  name: string,
): ZplCommand[] {
  return document.commands.filter((command) => command.name === name)
}

/** `^A0N,23,24` / `^A@N,15,10,TT0003M_` komutunu çözer. */
export function parseFontCommand(command: ZplCommand): ZplFontSpec | null {
  if (command.name.length !== 2 || command.name[0] !== 'A') return null
  const fontId = command.name[1]
  // ^A@ dışındaki `^A` komutlarında ilk karakter yön olabilir.
  const parts = command.args.split(',')
  let head = parts[0] ?? ''
  let orientation: ZplOrientation | null = null
  if (head.length > 0 && ORIENTATIONS.has(head[0].toUpperCase())) {
    orientation = head[0].toUpperCase() as ZplOrientation
    head = head.slice(1)
  }
  const height = Number.parseInt(head === '' ? (parts[1] ?? '') : head, 10)
  const heightValue = Number.isFinite(height) ? height : 0
  const widthRaw = head === '' ? parts[2] : parts[1]
  const width = Number.parseInt(widthRaw ?? '', 10)
  const fontNameRaw = head === '' ? parts[3] : parts[2]
  const fontName =
    fontId === '@' && typeof fontNameRaw === 'string' && fontNameRaw.trim() !== ''
      ? fontNameRaw.trim()
      : null
  return {
    command: command.name,
    fontId,
    orientation,
    height: heightValue,
    width: Number.isFinite(width) ? width : heightValue,
    fontName,
  }
}

function parsePosition(command: ZplCommand): { x: number; y: number } | null {
  const parts = command.args.split(',')
  const x = Number.parseInt(parts[0] ?? '', 10)
  const y = Number.parseInt(parts[1] ?? '', 10)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function classify(commands: readonly ZplCommand[]): {
  kind: ZplFieldKind
  codeCommand: ZplCommand | null
} {
  for (const command of commands) {
    if (command.name === 'BC') return { kind: 'code128', codeCommand: command }
    if (command.name === 'BX') return { kind: 'datamatrix', codeCommand: command }
    if (command.name === 'BQ') return { kind: 'qr', codeCommand: command }
    if (command.name === 'GB') return { kind: 'graphic', codeCommand: command }
  }
  const hasData = commands.some((command) => command.name === 'FD')
  return { kind: hasData ? 'text' : 'other', codeCommand: null }
}

/**
 * Belgeyi ALAN'lara böler. Bir alan `^FO`/`^FT` ile başlar, `^FS` ile biter.
 * Konum komutundan hemen önce gelen `^BY` alana iliştirilir (barkod modülü).
 */
export function collectZplFields(document: ZplDocument): ZplField[] {
  const fields: ZplField[] = []
  const commands = document.commands
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]
    if (command.name !== 'FO' && command.name !== 'FT') continue
    const position = parsePosition(command)
    if (!position) continue
    const owned: ZplCommand[] = [command]
    let endCommand: ZplCommand | null = null
    for (let cursor = index + 1; cursor < commands.length; cursor += 1) {
      const next = commands[cursor]
      if (next.name === 'FO' || next.name === 'FT' || next.name === 'XZ') break
      owned.push(next)
      if (next.name === 'FS') {
        endCommand = next
        break
      }
    }
    const previous = index > 0 ? commands[index - 1] : null
    const fontCommand =
      owned.find((entry) => entry.name.length === 2 && entry.name[0] === 'A') ?? null
    const dataCommand = owned.find((entry) => entry.name === 'FD') ?? null
    const { kind, codeCommand } = classify(owned)
    fields.push({
      positionType: command.name as 'FO' | 'FT',
      x: position.x,
      y: position.y,
      positionCommand: command,
      endCommand,
      fontCommand,
      font: fontCommand ? parseFontCommand(fontCommand) : null,
      dataCommand,
      data: dataCommand ? dataCommand.args : null,
      kind,
      commands: owned,
      codeCommand,
      byCommand: previous && previous.name === 'BY' ? previous : null,
    })
  }
  return fields
}

/** Verilen koordinattaki alanları döndürür (tam eşleşme). */
export function fieldsAt(
  fields: readonly ZplField[],
  x: number,
  y: number,
): ZplField[] {
  return fields.filter((field) => field.x === x && field.y === y)
}

/** `^FD` gövdesinden `^FH` hex kaçışlarını çözer (yalnız okuma amaçlı). */
export function decodeFieldHex(data: string, escape = '\\'): string {
  const pattern = new RegExp(`\\${escape}([0-9A-Fa-f]{2})`, 'g')
  return data.replace(pattern, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}
