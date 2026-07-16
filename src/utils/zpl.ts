export type ZplSource = 'surat.ortakBarkod.BarcodeRaw' | 'generated'

export function normalizeSuratBarcodeRawZpl(value: unknown): string {
  const text = decodeXmlEntities(String(value ?? '')).trim()
  if (!text) return ''

  const start = text.indexOf('^XA')
  const end = text.lastIndexOf('^XZ')
  if (start < 0 || end < start) return ''

  return text.slice(start, end + 3)
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
}

export function resolveSuratBarcodeRawZpl(...values: unknown[]): string {
  for (const value of values) {
    const zpl = normalizeSuratBarcodeRawZpl(value)
    if (zpl) return zpl
  }
  return ''
}
