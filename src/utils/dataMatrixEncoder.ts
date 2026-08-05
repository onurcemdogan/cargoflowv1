// ECC200 DATA MATRIX ÜRETECİ — TAMAMEN YEREL, SAF (ağ/IO/DOM YOK).
//
// NEDEN BURADA: resmî Sürat etiketindeki ^BX alanı gerçek bir DataMatrix
// sembolüdür. Önceki sürüm bu alanı yalnız uyarıyla boş bırakıyordu; boş veya
// "placeholder" bir kare GERÇEK ÇIKTI DEĞİLDİR ve okutulamaz. Bu modül
// ISO/IEC 16022 (ECC200) sembolünü CargoFlow içinde üretir.
//
// TASARIM KURALLARI
//   - payload YALNIZ çağırandan (kaynak ZPL'den) gelir; burada hiçbir alan
//     yeniden üretilmez, tahmin edilmez, loglanmaz.
//   - yeni bağımlılık YOK: kodlama, Reed-Solomon ve modül yerleşimi burada.
//   - deterministiktir: aynı payload HER ZAMAN aynı matrisi verir
//     (timestamp/random YOK) — snapshot testleri buna dayanır.
//   - desteklenmeyen durum SESSİZCE yutulmaz: null döner, çağıran katman
//     açık uyarı üretir.
//
// KAPSAM: kare ECC200 sembolleri, ASCII kodlaması (rakam çiftleri + tek
// bayt + upper-shift). Sürat payload'ı sayısaldır; genel bayt verisi de
// güvenle kodlanır. Dikdörtgen semboller KAPSAM DIŞIDIR (kaynak şablonda
// kullanılmıyor) ve istenirse null döner.

/** Kare ECC200 sembol tablosu (ISO/IEC 16022 Tablo 7). */
interface DataMatrixSymbolSpec {
  /** Bitiş sembol kenarı (finder dâhil), modül. */
  size: number
  /** Kenar başına veri bölgesi sayısı. */
  regions: number
  /** Veri kod sözcüğü kapasitesi. */
  dataCodewords: number
  /** Hata düzeltme kod sözcüğü sayısı (toplam). */
  eccCodewords: number
  /** Interleaved RS blok sayısı. */
  blocks: number
}

export const DATA_MATRIX_SQUARE_SYMBOLS: readonly DataMatrixSymbolSpec[] = [
  { size: 10, regions: 1, dataCodewords: 3, eccCodewords: 5, blocks: 1 },
  { size: 12, regions: 1, dataCodewords: 5, eccCodewords: 7, blocks: 1 },
  { size: 14, regions: 1, dataCodewords: 8, eccCodewords: 10, blocks: 1 },
  { size: 16, regions: 1, dataCodewords: 12, eccCodewords: 12, blocks: 1 },
  { size: 18, regions: 1, dataCodewords: 18, eccCodewords: 14, blocks: 1 },
  { size: 20, regions: 1, dataCodewords: 22, eccCodewords: 18, blocks: 1 },
  { size: 22, regions: 1, dataCodewords: 30, eccCodewords: 20, blocks: 1 },
  { size: 24, regions: 1, dataCodewords: 36, eccCodewords: 24, blocks: 1 },
  { size: 26, regions: 1, dataCodewords: 44, eccCodewords: 28, blocks: 1 },
  { size: 32, regions: 2, dataCodewords: 62, eccCodewords: 36, blocks: 1 },
  { size: 36, regions: 2, dataCodewords: 86, eccCodewords: 42, blocks: 1 },
  { size: 40, regions: 2, dataCodewords: 114, eccCodewords: 48, blocks: 1 },
  { size: 44, regions: 2, dataCodewords: 144, eccCodewords: 56, blocks: 1 },
  { size: 48, regions: 2, dataCodewords: 174, eccCodewords: 68, blocks: 1 },
  { size: 52, regions: 2, dataCodewords: 204, eccCodewords: 84, blocks: 2 },
  { size: 64, regions: 4, dataCodewords: 280, eccCodewords: 112, blocks: 2 },
  { size: 72, regions: 4, dataCodewords: 368, eccCodewords: 144, blocks: 4 },
  { size: 80, regions: 4, dataCodewords: 456, eccCodewords: 192, blocks: 4 },
  { size: 88, regions: 4, dataCodewords: 576, eccCodewords: 224, blocks: 4 },
  { size: 96, regions: 4, dataCodewords: 696, eccCodewords: 272, blocks: 4 },
  { size: 104, regions: 4, dataCodewords: 816, eccCodewords: 336, blocks: 6 },
  { size: 120, regions: 6, dataCodewords: 1050, eccCodewords: 408, blocks: 6 },
  { size: 132, regions: 6, dataCodewords: 1304, eccCodewords: 496, blocks: 8 },
  { size: 144, regions: 8, dataCodewords: 1558, eccCodewords: 620, blocks: 10 },
]

// ── GF(256) — ISO/IEC 16022 için ilkel polinom x^8+x^5+x^3+x^2+1 (0x12D) ────
const GF_LOG = new Uint8Array(256)
const GF_ALOG = new Uint8Array(256)
{
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    GF_ALOG[index] = value
    GF_LOG[value] = index
    value <<= 1
    if (value & 0x100) value ^= 0x12d
  }
}

/**
 * Reed-Solomon hata düzeltme kod sözcükleri (ECC200).
 * Doğrulama çapası: ISO/IEC 16022 örneği "123456" → veri [142,164,186],
 * 5 ECC → [114,25,5,88,102]. Test bu vektörü birebir kontrol eder.
 */
export function computeDataMatrixEcc(
  data: readonly number[],
  eccLength: number,
): number[] {
  // Üreteç polinomu katsayıları.
  const generator = new Array<number>(eccLength + 1).fill(0)
  generator[0] = 1
  for (let step = 1; step <= eccLength; step += 1) {
    generator[step] = 1
    for (let index = step - 1; index > 0; index -= 1) {
      generator[index] = generator[index]
        ? GF_ALOG[(GF_LOG[generator[index]] + step) % 255] ^ generator[index - 1]
        : generator[index - 1]
    }
    generator[0] = GF_ALOG[(GF_LOG[generator[0]] + step) % 255]
  }

  const ecc = new Array<number>(eccLength).fill(0)
  for (const codeword of data) {
    const feedback = ecc[eccLength - 1] ^ codeword
    for (let index = eccLength - 1; index > 0; index -= 1) {
      ecc[index] =
        ecc[index - 1] ^
        (feedback ? GF_ALOG[(GF_LOG[generator[index]] + GF_LOG[feedback]) % 255] : 0)
    }
    ecc[0] = feedback ? GF_ALOG[(GF_LOG[generator[0]] + GF_LOG[feedback]) % 255] : 0
  }
  return ecc.reverse()
}

/**
 * ASCII kodlaması: ardışık rakam çiftleri tek kod sözcüğüne (130+değer),
 * diğer baytlar değer+1, 127 üstü baytlar upper-shift (235) ile.
 * Payload UTF-8 baytlarına çevrilir; hiçbir karakter sessizce ATILMAZ.
 */
export function encodeDataMatrixAscii(payload: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(payload))
  const codewords: number[] = []
  let index = 0
  while (index < bytes.length) {
    const current = bytes[index]
    const next = index + 1 < bytes.length ? bytes[index + 1] : -1
    const isDigit = (value: number) => value >= 0x30 && value <= 0x39
    if (isDigit(current) && isDigit(next)) {
      codewords.push((current - 0x30) * 10 + (next - 0x30) + 130)
      index += 2
      continue
    }
    if (current > 127) {
      codewords.push(235)
      codewords.push(current - 128 + 1)
    } else {
      codewords.push(current + 1)
    }
    index += 1
  }
  return codewords
}

/** ECC200 dolgu: ilk dolgu 129, sonrakiler 253-randomizasyonu ile. */
function padCodewords(codewords: number[], capacity: number): number[] {
  const out = [...codewords]
  if (out.length < capacity) out.push(129)
  while (out.length < capacity) {
    const position = out.length + 1
    const pseudoRandom = ((149 * position) % 253) + 1
    const value = 129 + pseudoRandom
    out.push(value > 254 ? value - 254 : value)
  }
  return out
}

/**
 * ECC200 blok interleaving. Tek bloklu sembollerde kimlik dönüşümüdür;
 * çok bloklu semboller için standart round-robin uygulanır.
 * 144×144'ün eşit olmayan blokları (8×156 + 2×155) round-robin dağıtımdan
 * DOĞAL olarak çıkar; ayrı bir istisna gerekmez.
 */
function buildFullCodewords(
  data: number[],
  spec: DataMatrixSymbolSpec,
): number[] {
  const { blocks, dataCodewords, eccCodewords } = spec
  const eccPerBlock = eccCodewords / blocks
  const blockData: number[][] = Array.from({ length: blocks }, () => [])
  for (let index = 0; index < dataCodewords; index += 1) {
    blockData[index % blocks].push(data[index])
  }
  const blockEcc = blockData.map((block) => computeDataMatrixEcc(block, eccPerBlock))
  const out = [...data]
  for (let position = 0; position < eccPerBlock; position += 1) {
    for (let block = 0; block < blocks; block += 1) {
      out.push(blockEcc[block][position])
    }
  }
  return out
}

/**
 * ISO/IEC 16022 Ek F "default bit placement" algoritması.
 * Dönen dizi her veri modülü için (kod sözcüğü indeksi, bit numarası)
 * taşır; -1 atanmamış demektir.
 */
function buildPlacement(rowCount: number, columnCount: number): Int32Array {
  const grid = new Int32Array(rowCount * columnCount).fill(-1)

  const setModule = (row: number, column: number, chr: number, bit: number) => {
    let targetRow = row
    let targetColumn = column
    if (targetRow < 0) {
      targetRow += rowCount
      targetColumn += 4 - ((rowCount + 4) % 8)
    }
    if (targetColumn < 0) {
      targetColumn += columnCount
      targetRow += 4 - ((columnCount + 4) % 8)
    }
    grid[targetRow * columnCount + targetColumn] = (chr << 3) | bit
  }

  const utah = (row: number, column: number, chr: number) => {
    setModule(row - 2, column - 2, chr, 0)
    setModule(row - 2, column - 1, chr, 1)
    setModule(row - 1, column - 2, chr, 2)
    setModule(row - 1, column - 1, chr, 3)
    setModule(row - 1, column, chr, 4)
    setModule(row, column - 2, chr, 5)
    setModule(row, column - 1, chr, 6)
    setModule(row, column, chr, 7)
  }

  const corner1 = (chr: number) => {
    setModule(rowCount - 1, 0, chr, 0)
    setModule(rowCount - 1, 1, chr, 1)
    setModule(rowCount - 1, 2, chr, 2)
    setModule(0, columnCount - 2, chr, 3)
    setModule(0, columnCount - 1, chr, 4)
    setModule(1, columnCount - 1, chr, 5)
    setModule(2, columnCount - 1, chr, 6)
    setModule(3, columnCount - 1, chr, 7)
  }
  const corner2 = (chr: number) => {
    setModule(rowCount - 3, 0, chr, 0)
    setModule(rowCount - 2, 0, chr, 1)
    setModule(rowCount - 1, 0, chr, 2)
    setModule(0, columnCount - 4, chr, 3)
    setModule(0, columnCount - 3, chr, 4)
    setModule(0, columnCount - 2, chr, 5)
    setModule(0, columnCount - 1, chr, 6)
    setModule(1, columnCount - 1, chr, 7)
  }
  const corner3 = (chr: number) => {
    setModule(rowCount - 3, 0, chr, 0)
    setModule(rowCount - 2, 0, chr, 1)
    setModule(rowCount - 1, 0, chr, 2)
    setModule(0, columnCount - 2, chr, 3)
    setModule(0, columnCount - 1, chr, 4)
    setModule(1, columnCount - 1, chr, 5)
    setModule(2, columnCount - 1, chr, 6)
    setModule(3, columnCount - 1, chr, 7)
  }
  const corner4 = (chr: number) => {
    setModule(rowCount - 1, 0, chr, 0)
    setModule(rowCount - 1, columnCount - 1, chr, 1)
    setModule(0, columnCount - 3, chr, 2)
    setModule(0, columnCount - 2, chr, 3)
    setModule(0, columnCount - 1, chr, 4)
    setModule(1, columnCount - 3, chr, 5)
    setModule(1, columnCount - 2, chr, 6)
    setModule(1, columnCount - 1, chr, 7)
  }

  let chr = 0
  let row = 4
  let column = 0
  do {
    if (row === rowCount && column === 0) {
      corner1(chr)
      chr += 1
    } else if (row === rowCount - 2 && column === 0 && columnCount % 4 !== 0) {
      corner2(chr)
      chr += 1
    } else if (row === rowCount - 2 && column === 0 && columnCount % 8 === 4) {
      corner3(chr)
      chr += 1
    } else if (row === rowCount + 4 && column === 2 && columnCount % 8 === 0) {
      corner4(chr)
      chr += 1
    }
    do {
      if (
        row < rowCount &&
        column >= 0 &&
        grid[row * columnCount + column] < 0
      ) {
        utah(row, column, chr)
        chr += 1
      }
      row -= 2
      column += 2
    } while (row >= 0 && column < columnCount)
    row += 1
    column += 3
    do {
      if (row >= 0 && column < columnCount && grid[row * columnCount + column] < 0) {
        utah(row, column, chr)
        chr += 1
      }
      row += 2
      column -= 2
    } while (row < rowCount && column >= 0)
    row += 3
    column += 1
  } while (row < rowCount || column < columnCount)

  return grid
}

export interface DataMatrixSymbol {
  /** Sembolün kenar uzunluğu (modül, finder dâhil, quiet zone HARİÇ). */
  size: number
  /** [row][col] — true = koyu modül. */
  modules: boolean[][]
  /** Kullanılan kod sözcüğü sayısı (teşhis; payload İÇERMEZ). */
  dataCodewords: number
}

/**
 * Payload'ı ECC200 kare DataMatrix sembolüne çevirir.
 * Kapasiteye sığmayan veya boş payload için null döner (sessiz placeholder YOK).
 */
export function encodeDataMatrix(payload: string): DataMatrixSymbol | null {
  const text = String(payload ?? '')
  if (!text) return null
  const encoded = encodeDataMatrixAscii(text)
  const spec = DATA_MATRIX_SQUARE_SYMBOLS.find(
    (candidate) => candidate.dataCodewords >= encoded.length,
  )
  if (!spec) return null

  const padded = padCodewords(encoded, spec.dataCodewords)
  const codewords = buildFullCodewords(padded, spec)

  const regionSide = (spec.size - 2 * spec.regions) / spec.regions
  const mappingRows = regionSide * spec.regions
  const mappingColumns = mappingRows
  const placement = buildPlacement(mappingRows, mappingColumns)

  const modules: boolean[][] = Array.from({ length: spec.size }, () =>
    new Array<boolean>(spec.size).fill(false),
  )

  // Finder pattern + clock track: her veri bölgesi (regionSide+2) kare alan
  // kaplar; sol sütun ve alt satır KESİNTİSİZ koyu, üst satır ve sağ sütun
  // dönüşümlüdür.
  for (let regionRow = 0; regionRow < spec.regions; regionRow += 1) {
    for (let regionColumn = 0; regionColumn < spec.regions; regionColumn += 1) {
      const originRow = regionRow * (regionSide + 2)
      const originColumn = regionColumn * (regionSide + 2)
      for (let offset = 0; offset < regionSide + 2; offset += 1) {
        modules[originRow + offset][originColumn] = true
        modules[originRow + regionSide + 1][originColumn + offset] = true
      }
      for (let offset = 0; offset < regionSide + 2; offset += 2) {
        modules[originRow][originColumn + offset] = true
      }
      for (let offset = 1; offset < regionSide + 2; offset += 2) {
        modules[originRow + offset][originColumn + regionSide + 1] = true
      }
    }
  }

  for (let mappingRow = 0; mappingRow < mappingRows; mappingRow += 1) {
    for (let mappingColumn = 0; mappingColumn < mappingColumns; mappingColumn += 1) {
      const slot = placement[mappingRow * mappingColumns + mappingColumn]
      const regionRow = Math.floor(mappingRow / regionSide)
      const regionColumn = Math.floor(mappingColumn / regionSide)
      const targetRow =
        regionRow * (regionSide + 2) + 1 + (mappingRow % regionSide)
      const targetColumn =
        regionColumn * (regionSide + 2) + 1 + (mappingColumn % regionSide)
      if (slot < 0) {
        // Ek F son köşe istisnası: kalan iki modül SABİT koyu olarak doldurulur
        // (yalnız sağ-alt 2×2 köşesinde oluşur).
        const isFinalCorner =
          mappingRow === mappingRows - 1 && mappingColumn === mappingColumns - 1
        const isFinalCornerMate =
          mappingRow === mappingRows - 2 && mappingColumn === mappingColumns - 2
        modules[targetRow][targetColumn] = isFinalCorner || isFinalCornerMate
        continue
      }
      const codewordIndex = slot >> 3
      const bit = slot & 7
      const codeword = codewords[codewordIndex] ?? 0
      modules[targetRow][targetColumn] = ((codeword >> (7 - bit)) & 1) === 1
    }
  }

  return { size: spec.size, modules, dataCodewords: spec.dataCodewords }
}
