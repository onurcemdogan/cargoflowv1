// PNG → ikili bitmap çözücü ve LANDMARK ölçümü — SAF, bağımlılık YOK.
//
// AMAÇ: iki render motorunun (Labelary referansı ve yerel zebrash) çıktısını
// OTOMATİK karşılaştırmak. Landmark kutuları GÖRSELDEN ölçülür; beklenen
// yerler kaynak ZPL koordinatlarından gelen arama penceresidir.
//
// Yalnız zlib (Node yerleşik) kullanılır; harici görüntü kütüphanesi YOK.
import { inflateSync } from 'node:zlib'

/** PNG'yi çözer ve `dark[y][x]` (true = koyu) ikili bitmap döner. */
export function decodePngToBitmap(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG imzası yok')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let palette = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlace desteklenmiyor')
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4
  const bitsPerPixel = channels * bitDepth
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8)
  const filterStride = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const lines = []
  let previous = Buffer.alloc(bytesPerLine)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = Buffer.from(raw.subarray(cursor, cursor + bytesPerLine))
    cursor += bytesPerLine
    for (let i = 0; i < bytesPerLine; i += 1) {
      const a = i >= filterStride ? line[i - filterStride] : 0
      const b = previous[i]
      const c = i >= filterStride ? previous[i - filterStride] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = value & 0xff
    }
    lines.push(line)
    previous = line
  }

  const readSample = (line, index) => {
    if (bitDepth === 8) return line[index]
    if (bitDepth === 1) return (line[index >> 3] >> (7 - (index & 7))) & 1
    if (bitDepth === 4) return (line[index >> 1] >> (index & 1 ? 0 : 4)) & 0x0f
    if (bitDepth === 2) return (line[index >> 2] >> (6 - 2 * (index & 3))) & 3
    if (bitDepth === 16) return line[index * 2]
    throw new Error(`bit derinliği desteklenmiyor: ${bitDepth}`)
  }
  const maxValue = bitDepth === 16 ? 255 : (1 << bitDepth) - 1
  const dark = []
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(width)
    for (let x = 0; x < width; x += 1) {
      let luminance
      if (colorType === 3) {
        const index = readSample(lines[y], x)
        const base = index * 3
        luminance = (palette[base] + palette[base + 1] + palette[base + 2]) / 3
      } else if (colorType === 0 || colorType === 4) {
        luminance = (readSample(lines[y], x * channels) / maxValue) * 255
      } else {
        const base = x * channels
        luminance =
          (readSample(lines[y], base) +
            readSample(lines[y], base + 1) +
            readSample(lines[y], base + 2)) /
          3
        if (bitDepth !== 8) luminance = (luminance / maxValue) * 255
      }
      row[x] = luminance < 128 ? 1 : 0
    }
    dark.push(row)
  }
  return { width, height, dark }
}

/** Bitmap'i hedef ölçüye en yakın komşu ile ölçekler (798 → 799 gibi). */
export function scaleBitmap(bitmap, targetWidth, targetHeight) {
  if (bitmap.width === targetWidth && bitmap.height === targetHeight) return bitmap
  const dark = []
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(
      bitmap.height - 1,
      Math.round((y * bitmap.height) / targetHeight),
    )
    const row = new Uint8Array(targetWidth)
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(
        bitmap.width - 1,
        Math.round((x * bitmap.width) / targetWidth),
      )
      row[x] = bitmap.dark[sourceY][sourceX]
    }
    dark.push(row)
  }
  return { width: targetWidth, height: targetHeight, dark }
}

/**
 * Verilen arama penceresi içindeki MÜREKKEBİN sıkı sınırlayıcı kutusu.
 * Pencere kaynak ZPL koordinatlarından gelir; kutu GÖRÜNTÜDEN ölçülür.
 */
export function measureInkBox(bitmap, window) {
  const x0 = Math.max(0, Math.floor(window.x))
  const y0 = Math.max(0, Math.floor(window.y))
  const x1 = Math.min(bitmap.width, Math.ceil(window.x + window.width))
  const y1 = Math.min(bitmap.height, Math.ceil(window.y + window.height))
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let ink = 0
  for (let y = y0; y < y1; y += 1) {
    const row = bitmap.dark[y]
    for (let x = x0; x < x1; x += 1) {
      if (!row[x]) continue
      ink += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (ink === 0) return null
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    ink,
  }
}

/** Etiket boyunca uzanan YATAY çizgilerin y konumları. */
export function findHorizontalRules(bitmap, minCoverage = 0.85) {
  const rows = []
  for (let y = 0; y < bitmap.height; y += 1) {
    let count = 0
    for (let x = 0; x < bitmap.width; x += 1) count += bitmap.dark[y][x]
    if (count >= bitmap.width * minCoverage) rows.push(y)
  }
  // Ardışık satırları tek çizgiye indirger (kalınlık).
  const grouped = []
  for (const y of rows) {
    const last = grouped[grouped.length - 1]
    if (last && y - last.end <= 1) last.end = y
    else grouped.push({ start: y, end: y })
  }
  return grouped.map((group) => ({
    y: group.start,
    thickness: group.end - group.start + 1,
  }))
}

/** Etiket boyunca uzanan DİKEY çizgilerin x konumları. */
export function findVerticalRules(bitmap, minCoverage = 0.85) {
  const columns = []
  for (let x = 0; x < bitmap.width; x += 1) {
    let count = 0
    for (let y = 0; y < bitmap.height; y += 1) count += bitmap.dark[y][x]
    if (count >= bitmap.height * minCoverage) columns.push(x)
  }
  const grouped = []
  for (const x of columns) {
    const last = grouped[grouped.length - 1]
    if (last && x - last.end <= 1) last.end = x
    else grouped.push({ start: x, end: x })
  }
  return grouped.map((group) => ({
    x: group.start,
    thickness: group.end - group.start + 1,
  }))
}

/** İki bitmap arasındaki farklı piksel oranı (%). */
export function pixelDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('pixel-diff için ölçüler eşit olmalı')
  }
  let different = 0
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (a.dark[y][x] !== b.dark[y][x]) different += 1
    }
  }
  const total = a.width * a.height
  return { different, total, percent: (different / total) * 100 }
}
