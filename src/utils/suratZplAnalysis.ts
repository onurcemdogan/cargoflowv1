import type { SuratZplAnalysis } from '../types/cargoflow'
import { normalizeSuratBarcodeRawZpl } from './zpl'

export function analyzeSuratZpl(value: unknown): SuratZplAnalysis {
  const zpl = normalizeSuratBarcodeRawZpl(value)
  const fields = extractFields(zpl)
  const allFdValues = unique(fields.map((field) => field.value).filter(Boolean))
  const mainCode128Candidates = unique(
    fields
      .filter((field) => field.kind === 'code128')
      .map((field) => cleanBarcodeValue(field.value))
      .filter(Boolean),
  )
  const qrCandidates = unique(
    fields
      .filter((field) => field.kind === 'qr')
      .map((field) => cleanQrValue(field.value))
      .filter(Boolean),
  )
  const dataMatrixCandidates = unique(
    fields
      .filter((field) => field.kind === 'dataMatrix')
      .map((field) => cleanBarcodeValue(field.value))
      .filter(Boolean),
  )
  const numericBarcodeCandidates = unique(
    [...mainCode128Candidates, ...dataMatrixCandidates, ...allFdValues]
      .map(cleanBarcodeValue)
      .filter(isNumericOperationalCode),
  )
  const webBarcodeCandidates = unique(
    [...mainCode128Candidates, ...allFdValues]
      .map(cleanBarcodeValue)
      .filter((candidate) => /^web[0-9a-z-]+$/i.test(candidate)),
  )
  const tNoCandidates = unique([
    ...extractLabelledNumeric(allFdValues, /t\.?\s*no/i),
    ...allFdValues
      .map((field) => field.match(/t\.?\s*no\s*:?\s*(\d{8,20})/i)?.[1] ?? '')
      .filter(Boolean),
    ...numericBarcodeCandidates.filter(
      (candidate) =>
        /^\d{14}$/.test(candidate) &&
        !mainCode128Candidates.includes(candidate) &&
        !qrCandidates.includes(candidate),
    ),
  ])
  const siparisNoCandidates = unique(
    extractLabelledNumeric(allFdValues, /sipari[sş]|must\.?\s*irs\.?\s*no/i),
  )
  const referenceNoCandidates = unique([
    ...extractLabelledNumeric(allFdValues, /ref(?:erans)?\.?\s*no/i),
    ...qrCandidates.filter(isNumericOperationalCode),
  ])
  const routeTransferText = unique(
    allFdValues.filter((field) => /aktarma|transfer|merkez/i.test(field)),
  )
  const destinationText = unique(
    allFdValues.filter((field) => /teslim|var[ıi][şs]|il[çc]e|adres/i.test(field)),
  )
  const acceptedFinalBarcode =
    mainCode128Candidates.find(isNumericOperationalCode) ??
    webBarcodeCandidates[0] ??
    ''
  const acceptedTNo = tNoCandidates.find(isNumericOperationalCode) ?? ''
  const internalWebBarcode = webBarcodeCandidates[0] ?? ''
  const rejectionReason = resolveRejectionReason({
    zpl,
    acceptedFinalBarcode,
    internalWebBarcode,
  })

  return {
    hasBarcodeRaw: Boolean(zpl),
    allFdValues,
    mainCode128Candidates,
    qrCandidates,
    dataMatrixCandidates,
    numericBarcodeCandidates,
    webBarcodeCandidates,
    tNoCandidates,
    siparisNoCandidates,
    referenceNoCandidates,
    routeTransferText,
    destinationText,
    acceptedFinalBarcode,
    acceptedTNo,
    internalWebBarcode,
    rejectionReason,
  }
}

export function isNumericOperationalCode(value: string): boolean {
  return /^\d{8,20}$/.test(String(value ?? '').trim())
}

function extractFields(zpl: string): Array<{
  value: string
  kind: 'code128' | 'qr' | 'dataMatrix' | 'text'
}> {
  if (!zpl) return []
  const result: Array<{
    value: string
    kind: 'code128' | 'qr' | 'dataMatrix' | 'text'
  }> = []
  const regex = /\^FD([\s\S]*?)\^FS/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(zpl))) {
    const before = zpl.slice(Math.max(0, match.index - 180), match.index)
    const lastCommand = lastBarcodeCommand(before)
    result.push({
      value: decodeZplField(match[1]),
      kind:
        lastCommand === 'BC'
          ? 'code128'
          : lastCommand === 'BQ'
            ? 'qr'
            : lastCommand === 'BX'
              ? 'dataMatrix'
              : 'text',
    })
  }
  return result
}

function lastBarcodeCommand(value: string): string {
  const commands = Array.from(value.matchAll(/\^(BC|BQ|BX)[^^]*/gi))
  return commands.at(-1)?.[1]?.toUpperCase() ?? ''
}

function decodeZplField(value: string): string {
  return String(value ?? '')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanBarcodeValue(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^>[;:]/, '')
    .replace(/^(?:QA|LA),/i, '')
    .trim()
}

function cleanQrValue(value: string): string {
  return cleanBarcodeValue(value)
}

function extractLabelledNumeric(values: string[], label: RegExp): string[] {
  const found: string[] = []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!label.test(value)) {
      label.lastIndex = 0
      continue
    }
    label.lastIndex = 0
    const inline = value.match(/\d{8,20}/g) ?? []
    found.push(...inline)
    const next = cleanBarcodeValue(values[index + 1] ?? '')
    if (isNumericOperationalCode(next)) found.push(next)
  }
  return unique(found)
}

function resolveRejectionReason({
  zpl,
  acceptedFinalBarcode,
  internalWebBarcode,
}: {
  zpl: string
  acceptedFinalBarcode: string
  internalWebBarcode: string
}): string {
  if (!zpl) return 'BarcodeRaw / geçerli ZPL bulunamadı.'
  if (!acceptedFinalBarcode && internalWebBarcode) {
    return 'Ana Code128 barkod çözümlenemedi.'
  }
  if (!acceptedFinalBarcode) return 'Ana Sürat barkodu bulunamadı.'
  return ''
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
